#include "ble_mouse.h"

#include <stdatomic.h>
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_check.h"
#include "esp_gap_ble_api.h"
#include "esp_gatts_api.h"
#include "esp_hidd.h"
#include "esp_hidd_gatts.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "ble_mouse";
static const char *NAME = "Codex Air Remote";
static esp_hidd_dev_t *device;
static atomic_bool linked;
static atomic_uint generation;

static const uint8_t report_map[] = {
    0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, // Generic Desktop / Mouse
    0x09, 0x01, 0xa1, 0x00,             // Pointer
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, // Buttons 1–3
    0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03, // Padding
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, // X/Y and zero wheel
    0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06,
    0xc0, 0xc0
};

static esp_hid_raw_report_map_t maps[] = {
    {.data = report_map, .len = sizeof(report_map)},
};

static esp_hid_device_config_t hid_config = {
    .vendor_id = 0x02e5,
    .product_id = 0xa180,
    .version = 0x0100,
    .device_name = "Codex Air Remote",
    .manufacturer_name = "Air Remote",
    .serial_number = "01",
    .report_maps = maps,
    .report_maps_len = 1,
};

static esp_ble_adv_params_t adv_params = {
    .adv_int_min = 0x40, .adv_int_max = 0x60,
    .adv_type = ADV_TYPE_IND, .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL, .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

static nvs_handle_t ccc_nvs;
static bool ccc_known;

/* Persist the HID report CCCD so a reboot does not silently lose the Windows
 * subscription (the GATT server resets CCCD state, the host does not). */
static void ccc_persist(bool on)
{
    ccc_known = on;
    if (ccc_nvs == 0 && nvs_open("airremote_ble", NVS_READWRITE, &ccc_nvs) != ESP_OK) return;
    if (nvs_set_u8(ccc_nvs, "ccc", on ? 1 : 0) == ESP_OK) nvs_commit(ccc_nvs);
}

static void ccc_load(void)
{
    uint8_t v = 0;
    if (nvs_open("airremote_ble", NVS_READONLY, &ccc_nvs) == ESP_OK &&
        nvs_get_u8(ccc_nvs, "ccc", &v) == ESP_OK) {
        ccc_known = v != 0;
    }
}
static atomic_bool hid_started, advertising, releasing;/* The controller can answer the advertising-enable HCI command with "memory
 * full" right after the HID service is created. Retrying with a short backoff
 * recovers from that transient failure; success is only reported when the
 * completion event says so. */
static esp_timer_handle_t adv_retry;
static int adv_retry_attempt;
/* HID notifications are enabled by the host through the report CCC, which
 * esp_hid does not expose. Treat the first successful indication as the
 * readiness signal: probing at report rate floods the USB console while the
 * host has not subscribed yet (250 error lines/s, which blocks the log writer
 * when nobody reads the port). */
static atomic_bool reports_ready;
static bool hid_logs_muted;      /* report_lock */
static int64_t probe_at_us;      /* report_lock */
static int64_t warn_at_us;       /* report_lock */
static unsigned dropped_reports; /* report_lock */
static atomic_uint advertising_data_ready;
static esp_timer_handle_t advertise_fallback;
static bool controller_inited, controller_enabled, host_inited, host_enabled;
/* Serializes HID reports against Bluedroid teardown: esp_ble_hidd_dev_input_set()
 * waits for the ATT confirmation with an unbounded semaphore (WAIT_CB =
 * xSemaphoreTake(dev->sem, portMAX_DELAY)), so deinitialising the HID device
 * under an in-flight report would delete that semaphore and free the device
 * (use-after-free). Report path takes the lock with a short timeout; release
 * waits for it with a bounded timeout and refuses to tear down if it is stuck. */
static SemaphoreHandle_t report_lock;

static void advertise(void);
static void schedule_adv_retry(void);

/* TEMP diagnostic (remove before delivery): esp_hid only logs report CCC
 * writes at verbose level, which this build compiles out. Log the GATTS events
 * we care about so we can tell whether Windows ever enables notifications. */
static void gatts_event_probe(esp_gatts_cb_event_t event, esp_gatt_if_t gatts_if,
                              esp_ble_gatts_cb_param_t *param)
{
    switch (event) {
    case ESP_GATTS_CONNECT_EVT:
        ESP_LOGI(TAG, "GATTS connected conn_id=%u", param->connect.conn_id);
        break;
    case ESP_GATTS_DISCONNECT_EVT:
        ESP_LOGI(TAG, "GATTS disconnected reason=0x%x", param->disconnect.reason);
        break;
    case ESP_GATTS_MTU_EVT:
        ESP_LOGI(TAG, "GATTS MTU=%u", param->mtu.mtu);
        break;
    case ESP_GATTS_READ_EVT:
        ESP_LOGI(TAG, "GATTS read handle=%u rsp=%d", param->read.handle, param->read.need_rsp);
        break;
    case ESP_GATTS_WRITE_EVT:
        ESP_LOGI(TAG, "GATTS write handle=%u len=%u prep=%d",
                 param->write.handle, param->write.len, param->write.is_prep);
        /* The HID report CCCD is a two byte value. Windows only writes it when
         * the device is paired, so remember the subscription in NVS and restore
         * it after a reboot: the GATT server drops CCCD state on reset but the
         * host keeps believing it is still subscribed. */
        if (!param->write.is_prep && param->write.len == 2) {
            uint16_t ccc = (uint16_t)param->write.value[0] | ((uint16_t)param->write.value[1] << 8);
            bool on = (ccc & 0x0003) != 0;
            ESP_LOGI(TAG, "CCCD handle=%u value=%u -> %s", param->write.handle, ccc,
                     on ? "subscribed" : "unsubscribed");
            ccc_persist(on);
            if (on) {
                atomic_store(&reports_ready, true);
            }
        }
        break;
    default:
        break;
    }
    esp_hidd_gatts_event_handler(event, gatts_if, param);
}

/* Bluedroid delivers the GATTS profile events that eventually produce
 * ESP_HIDD_START_EVENT to the callback registered with
 * esp_ble_gatts_register_callback(). The esp_hid BLE transport does not
 * register it, so without this call the HID attribute table is never created,
 * ESP_HIDD_START_EVENT never fires and the board never starts advertising
 * (Windows then cannot discover the mouse at all). */
static esp_err_t register_gatts_callback(void)
{
    return esp_ble_gatts_register_callback(gatts_event_probe);
}

/* Diagnostic retry: if the HID start event never arrives, the board must not
 * advertise a device without its HID service (Windows would pair with a dead
 * device), so only log it here. When the event did arrive but advertising was
 * skipped because the advertising data was not ready yet, retry the (idempotent)
 * advertise() call. */
static void advertise_fallback_cb(void *arg)
{
    if (atomic_load(&releasing) || !device) return;
    if (!atomic_load(&hid_started)) {
        ESP_LOGE(TAG, "HID start event missing, not advertising");
        return;
    }
    advertise();
}

static void advertise(void)
{
    if (atomic_load(&hid_started) && atomic_load(&advertising_data_ready) == 3 &&
        !atomic_load(&linked) && !atomic_exchange(&advertising, true)) {
        esp_err_t err = esp_ble_gap_start_advertising(&adv_params);
        if (err != ESP_OK) {
            atomic_store(&advertising, false);
            ESP_LOGW(TAG, "Advertise: %s", esp_err_to_name(err));
            schedule_adv_retry();
        }
    }
}

static void adv_retry_cb(void *arg)
{
    (void)arg;
    atomic_store(&advertising, false);
    advertise();
}

static void schedule_adv_retry(void)
{
    static const uint64_t delays_us[] = {200000, 500000, 1000000};
    if (!adv_retry || adv_retry_attempt >= 3 || atomic_load(&releasing) || atomic_load(&linked)) {
        return;
    }
    uint64_t delay = delays_us[adv_retry_attempt++];
    esp_timer_stop(adv_retry);
    esp_timer_start_once(adv_retry, delay);
}

static void gap_event(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *data)
{
    switch (event) {
    case ESP_GAP_BLE_ADV_DATA_SET_COMPLETE_EVT:
        if (data->adv_data_cmpl.status == ESP_BT_STATUS_SUCCESS) atomic_fetch_or(&advertising_data_ready, 1);
        advertise();
        break;
    case ESP_GAP_BLE_SCAN_RSP_DATA_SET_COMPLETE_EVT:
        if (data->scan_rsp_data_cmpl.status == ESP_BT_STATUS_SUCCESS) atomic_fetch_or(&advertising_data_ready, 2);
        advertise();
        break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        if (data->adv_start_cmpl.status == ESP_BT_STATUS_SUCCESS) {
            adv_retry_attempt = 0;
            ESP_LOGI(TAG, "BLE advertising started");
        } else {
            atomic_store(&advertising, false);
            ESP_LOGW(TAG, "ADV start failed, status %d", data->adv_start_cmpl.status);
            schedule_adv_retry();
        }
        break;
    case ESP_GAP_BLE_SEC_REQ_EVT:
        esp_ble_gap_security_rsp(data->ble_security.ble_req.bd_addr, true);
        break;
    case ESP_GAP_BLE_AUTH_CMPL_EVT:
        if (data->ble_security.auth_cmpl.success) {
            ESP_LOGI(TAG, "BLE pairing complete");
        } else {
            ESP_LOGW(TAG, "Pairing failed: %u", data->ble_security.auth_cmpl.fail_reason);
        }
        break;
    default:
        break;
    }
}

static void hid_event(void *arg, esp_event_base_t base, int32_t event, void *data)
{
    switch (event) {
    case ESP_HIDD_START_EVENT:
        atomic_store(&hid_started, true);
        ESP_LOGI(TAG, "BLE HID started");
        advertise();
        break;
    case ESP_HIDD_CONNECT_EVENT:
        atomic_fetch_add(&generation, 1);
        atomic_store(&linked, true);
        atomic_store(&reports_ready, false);
        if (ccc_known) {
            /* Windows keeps its subscription across device reboots even though
             * our GATT server starts with a cleared CCCD; trust NVS and let the
             * report path verify it. */
            atomic_store(&reports_ready, true);
            ESP_LOGI(TAG, "restoring CCCD subscription from NVS");
        }
        ESP_LOGI(TAG, "BLE host connected");
        break;
    case ESP_HIDD_DISCONNECT_EVENT:
        atomic_store(&linked, false);
        atomic_store(&advertising, false);
        atomic_store(&reports_ready, false);
        ESP_LOGW(TAG, "BLE host disconnected");
        advertise();
        break;
    default:
        break;
    }
}

/* Tear the BT stack down stage by stage so release() stays safe after any
 * partially failed init() step. */
static void bt_stack_down(void)
{
    esp_err_t err;
    if (device) {
        err = esp_hidd_dev_deinit(device);
        if (err != ESP_OK) ESP_LOGE(TAG, "HID deinit: %s", esp_err_to_name(err));
        device = NULL;
    }
    if (host_enabled) {
        if ((err = esp_bluedroid_disable()) != ESP_OK) {
            ESP_LOGW(TAG, "bluedroid disable: %s", esp_err_to_name(err));
        }
        host_enabled = false;
    }
    if (host_inited) {
        if ((err = esp_bluedroid_deinit()) != ESP_OK) {
            ESP_LOGW(TAG, "bluedroid deinit: %s", esp_err_to_name(err));
        }
        host_inited = false;
    }
    if (controller_enabled) {
        if ((err = esp_bt_controller_disable()) != ESP_OK) {
            ESP_LOGW(TAG, "controller disable: %s", esp_err_to_name(err));
        }
        controller_enabled = false;
    }
    if (controller_inited) {
        if ((err = esp_bt_controller_deinit()) != ESP_OK) {
            ESP_LOGW(TAG, "controller deinit: %s", esp_err_to_name(err));
        }
        controller_inited = false;
    }
}

esp_err_t ble_mouse_init(void)
{
    if (device && controller_enabled && host_enabled) {
        return ESP_OK;
    }
    if (controller_inited || controller_enabled || host_inited || host_enabled) {
        /* A previous init() failed halfway (or release() was interrupted):
         * clean up before trying again, otherwise the controller init below
         * returns ESP_ERR_INVALID_STATE and BLE stays dead until reboot. */
        esp_err_t cleanup = ble_mouse_release();
        if (cleanup != ESP_OK) return cleanup;
    }
    if (!report_lock) {
        report_lock = xSemaphoreCreateMutex();
        if (!report_lock) return ESP_ERR_NO_MEM;
    }
    atomic_store(&releasing, false);
    atomic_store(&linked, false);
    atomic_store(&advertising, false);
    atomic_store(&hid_started, false);
    atomic_store(&advertising_data_ready, 0);
    esp_err_t err;
    esp_bt_controller_config_t controller = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    if ((err = esp_bt_controller_init(&controller)) != ESP_OK) {
        ESP_LOGE(TAG, "controller init: %s", esp_err_to_name(err));
        return err;
    }
    controller_inited = true;
    if ((err = esp_bt_controller_enable(ESP_BT_MODE_BLE)) != ESP_OK) goto fail;
    controller_enabled = true;
    if ((err = esp_bluedroid_init()) != ESP_OK) goto fail;
    host_inited = true;
    if ((err = esp_bluedroid_enable()) != ESP_OK) goto fail;
    host_enabled = true;
    if ((err = esp_ble_gap_register_callback(gap_event)) != ESP_OK) goto fail;
    if ((err = esp_ble_gap_set_device_name(NAME)) != ESP_OK) goto fail;
    esp_ble_auth_req_t bond = ESP_LE_AUTH_REQ_SC_BOND;
    esp_ble_io_cap_t capability = ESP_IO_CAP_NONE;
    uint8_t keys = ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK;
    if ((err = esp_ble_gap_set_security_param(ESP_BLE_SM_AUTHEN_REQ_MODE, &bond, 1)) != ESP_OK) goto fail;
    if ((err = esp_ble_gap_set_security_param(ESP_BLE_SM_IOCAP_MODE, &capability, 1)) != ESP_OK) goto fail;
    if ((err = esp_ble_gap_set_security_param(ESP_BLE_SM_SET_INIT_KEY, &keys, 1)) != ESP_OK) goto fail;
    if ((err = esp_ble_gap_set_security_param(ESP_BLE_SM_SET_RSP_KEY, &keys, 1)) != ESP_OK) goto fail;

    static uint8_t hid_uuid[] = {
        0xfb, 0x34, 0x9b, 0x5f, 0x80, 0x00, 0x00, 0x80,
        0x00, 0x10, 0x00, 0x00, 0x12, 0x18, 0x00, 0x00,
    };
    esp_ble_adv_data_t advertisement = {
        .appearance = 0x03c2, .min_interval = 6, .max_interval = 12,
        .flag = ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT,
        .p_service_uuid = hid_uuid, .service_uuid_len = sizeof(hid_uuid),
    };
    esp_ble_adv_data_t scan_response = {.set_scan_rsp = true, .include_name = true};
    if ((err = esp_ble_gap_config_adv_data(&advertisement)) != ESP_OK) goto fail;
    if ((err = esp_ble_gap_config_adv_data(&scan_response)) != ESP_OK) goto fail;
    if ((err = register_gatts_callback()) != ESP_OK) goto fail;
    if ((err = esp_hidd_dev_init(&hid_config, ESP_HID_TRANSPORT_BLE, hid_event, &device)) != ESP_OK) {
        ESP_LOGE(TAG, "HID init failed: %s", esp_err_to_name(err));
        goto fail;
    }
    const esp_timer_create_args_t fallback_args = {
        .callback = advertise_fallback_cb, .name = "ble_adv_fallback",
    };
    const esp_timer_create_args_t retry_args = {
        .callback = adv_retry_cb, .name = "ble_adv_retry",
    };
    if (esp_timer_create(&retry_args, &adv_retry) != ESP_OK) adv_retry = NULL;
    err = esp_timer_create(&fallback_args, &advertise_fallback);
    if (err != ESP_OK) {
        advertise_fallback = NULL;
        ESP_LOGW(TAG, "fallback timer create: %s", esp_err_to_name(err));
    } else if ((err = esp_timer_start_once(advertise_fallback, 1000000)) != ESP_OK) {
        ESP_LOGW(TAG, "fallback timer start: %s", esp_err_to_name(err));
    }
    atomic_store(&reports_ready, false);
    ccc_load();
    probe_at_us = 0;
    dropped_reports = 0;
    if (hid_logs_muted) {
        esp_log_level_set("BLE_HIDD", ESP_LOG_INFO);
        hid_logs_muted = false;
    }
    return ESP_OK;

fail:
    ESP_LOGE(TAG, "BLE init failed: %s", esp_err_to_name(err));
    if (hid_logs_muted) {
        esp_log_level_set("BLE_HIDD", ESP_LOG_INFO);
        hid_logs_muted = false;
    }
    bt_stack_down();
    /* Keep reports gated until a later init() succeeds. */
    atomic_store(&releasing, true);
    return err;
}

esp_err_t ble_mouse_release(void)
{
    if (!controller_inited && !controller_enabled && !host_inited && !host_enabled && !device) {
        return ESP_OK;
    }
    /* Stop new reports and stop the report task from entering the HID API
     * before waiting for any report that is already inside it. */
    atomic_store(&releasing, true);
    atomic_store(&linked, false);
    if (advertise_fallback) {
        esp_err_t timer_err = esp_timer_stop(advertise_fallback);
        if (timer_err != ESP_OK && timer_err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "fallback timer stop: %s", esp_err_to_name(timer_err));
        }
        timer_err = esp_timer_delete(advertise_fallback);
        if (timer_err == ESP_OK) {
            advertise_fallback = NULL;
        } else {
            ESP_LOGW(TAG, "fallback timer delete: %s", esp_err_to_name(timer_err));
        }
    }
    bool drained = true;
    if (report_lock) {
        drained = xSemaphoreTake(report_lock, pdMS_TO_TICKS(250)) == pdTRUE;
    }
    if (!drained) {
        /* WAIT_CB never returned (ATT confirm lost on a dying link). Tearing the
         * HID device down now would free a semaphore another task is blocked on
         * and turn into a use-after-free, so keep the stack up and report it. */
        ESP_LOGE(TAG, "HID report still in flight, keeping the BT stack up");
        return ESP_ERR_TIMEOUT;
    }
    if (hid_logs_muted) {
        esp_log_level_set("BLE_HIDD", ESP_LOG_INFO);
        hid_logs_muted = false;
    }
    atomic_store(&reports_ready, false);
    probe_at_us = 0;
    dropped_reports = 0;
    bt_stack_down();
    if (report_lock) xSemaphoreGive(report_lock);
    atomic_store(&advertising, false);
    atomic_store(&hid_started, false);
    atomic_store(&advertising_data_ready, 0);
    atomic_fetch_add(&generation, 1);
    ESP_LOGI(TAG, "BLE host released");
    return ESP_OK;
}

esp_err_t ble_mouse_resume(void)
{
    esp_err_t err = ble_mouse_init();
    ESP_LOGI(TAG, "BLE host resumed: %s", esp_err_to_name(err));
    return err;
}

bool ble_mouse_connected(void) { return atomic_load(&linked); }
unsigned ble_mouse_generation(void) { return atomic_load(&generation); }
bool ble_mouse_reports_ready(void) { return atomic_load(&reports_ready); }

bool ble_mouse_report(uint8_t buttons, int8_t x, int8_t y)
{
    if (!device || !ble_mouse_connected() || atomic_load(&releasing)) return false;
    if (!report_lock) return false;
    if (xSemaphoreTake(report_lock, pdMS_TO_TICKS(10)) != pdTRUE) return false;
    bool sent = false;
    if (device && ble_mouse_connected() && !atomic_load(&releasing)) {
        int64_t now = esp_timer_get_time();
        if (!atomic_load(&reports_ready)) {
            /* Host has not subscribed yet: probe the CCC state once per 500 ms
             * instead of flooding the console with an error per report. */
            if (now - probe_at_us < 500000) {
                xSemaphoreGive(report_lock);
                return false;
            }
            probe_at_us = now;
        }
        uint8_t report[] = {buttons & 0x07, (uint8_t)x, (uint8_t)y, 0};
        sent = esp_hidd_dev_input_set(device, 0, 0, report, sizeof(report)) == ESP_OK;
        static int64_t last_report_log_us;
        if (now - last_report_log_us >= 200000) {
            last_report_log_us = now;
            ESP_LOGI(TAG, "report dx=%d dy=%d btn=%02x ret=%s", (int)(int8_t)x, (int)(int8_t)y,
                     buttons, sent ? "ok" : "fail");
        }
        if (sent) {
            dropped_reports = 0;
            if (!atomic_exchange(&reports_ready, true)) {
                ESP_LOGI(TAG, "HID reports enabled by host");
            }
            if (hid_logs_muted) {
                esp_log_level_set("BLE_HIDD", ESP_LOG_INFO);
                hid_logs_muted = false;
            }
        } else {
            atomic_store(&reports_ready, false);
            dropped_reports++;
            /* The HID library logs "Indicate Not Enabled" for every attempt we
             * make; mute that tag while we wait and keep one rate-limited WARN. */
            if (!hid_logs_muted) {
                esp_log_level_set("BLE_HIDD", ESP_LOG_NONE);
                hid_logs_muted = true;
            }
            if (now - warn_at_us >= 1000000) {
                warn_at_us = now;
                ESP_LOGW(TAG, "HID reports not enabled by host yet (%u dropped)", dropped_reports);
            }
        }
    }
    xSemaphoreGive(report_lock);
    return sent;
}
