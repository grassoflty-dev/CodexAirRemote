#include "ble_mouse.h"

#include <stdatomic.h>
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"
#include "esp_hidd.h"
#include "esp_log.h"
#include "esp_check.h"

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

static atomic_bool hid_started, advertising;
static atomic_uint advertising_data_ready;

static void advertise(void)
{
    if (atomic_load(&hid_started) && atomic_load(&advertising_data_ready) == 3 &&
        !atomic_load(&linked) && !atomic_exchange(&advertising, true)) {
        esp_err_t err = esp_ble_gap_start_advertising(&adv_params);
        if (err != ESP_OK) {
            atomic_store(&advertising, false);
            ESP_LOGW(TAG, "Advertise: %s", esp_err_to_name(err));
        }
    }
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
    case ESP_GAP_BLE_SEC_REQ_EVT:
        esp_ble_gap_security_rsp(data->ble_security.ble_req.bd_addr, true);
        break;
    case ESP_GAP_BLE_AUTH_CMPL_EVT:
        if (!data->ble_security.auth_cmpl.success) {
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
        advertise();
        break;
    case ESP_HIDD_CONNECT_EVENT:
        atomic_fetch_add(&generation, 1);
        atomic_store(&linked, true);
        break;
    case ESP_HIDD_DISCONNECT_EVENT:
        atomic_store(&linked, false);
        atomic_store(&advertising, false);
        advertise();
        break;
    default:
        break;
    }
}

esp_err_t ble_mouse_init(void)
{
    esp_bt_controller_config_t controller = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_bt_controller_init(&controller), TAG, "controller");
    ESP_RETURN_ON_ERROR(esp_bt_controller_enable(ESP_BT_MODE_BLE), TAG, "enable BLE");
    ESP_RETURN_ON_ERROR(esp_bluedroid_init(), TAG, "Bluedroid init");
    ESP_RETURN_ON_ERROR(esp_bluedroid_enable(), TAG, "Bluedroid enable");
    ESP_RETURN_ON_ERROR(esp_ble_gap_register_callback(gap_event), TAG, "GAP callback");
    ESP_RETURN_ON_ERROR(esp_ble_gap_set_device_name(NAME), TAG, "name");
    esp_ble_auth_req_t bond = ESP_LE_AUTH_REQ_SC_BOND;
    esp_ble_io_cap_t capability = ESP_IO_CAP_NONE;
    uint8_t keys = ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK;
    ESP_RETURN_ON_ERROR(esp_ble_gap_set_security_param(ESP_BLE_SM_AUTHEN_REQ_MODE, &bond, 1), TAG, "bonding");
    ESP_RETURN_ON_ERROR(esp_ble_gap_set_security_param(ESP_BLE_SM_IOCAP_MODE, &capability, 1), TAG, "IO");
    ESP_RETURN_ON_ERROR(esp_ble_gap_set_security_param(ESP_BLE_SM_SET_INIT_KEY, &keys, 1), TAG, "keys");
    ESP_RETURN_ON_ERROR(esp_ble_gap_set_security_param(ESP_BLE_SM_SET_RSP_KEY, &keys, 1), TAG, "keys");

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
    ESP_RETURN_ON_ERROR(esp_ble_gap_config_adv_data(&advertisement), TAG, "advertisement");
    ESP_RETURN_ON_ERROR(esp_ble_gap_config_adv_data(&scan_response), TAG, "scan response");
    return esp_hidd_dev_init(&hid_config, ESP_HID_TRANSPORT_BLE, hid_event, &device);
}

bool ble_mouse_connected(void) { return atomic_load(&linked); }
unsigned ble_mouse_generation(void) { return atomic_load(&generation); }

bool ble_mouse_report(uint8_t buttons, int8_t x, int8_t y)
{
    if (!device || !ble_mouse_connected()) return false;
    uint8_t report[] = {buttons & 0x07, (uint8_t)x, (uint8_t)y, 0};
    return esp_hidd_dev_input_set(device, 0, 0, report, sizeof(report)) == ESP_OK;
}
