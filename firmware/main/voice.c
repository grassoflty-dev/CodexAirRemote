#include "voice.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "board.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_https_server.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "mbedtls/constant_time.h"
#include "provision.h"

static const char *TAG = "voice";
enum {
    PCM_BYTES = 640, STEREO_BYTES = PCM_BYTES * 2, BUFFER_BYTES = 48000,
    BATCH_BYTES = 5 * PCM_BYTES,
    DISCOVERY_PORT = 47682, VOICE_PORT = 47683, MAX_RECORD_SECONDS = 60
};

extern const uint8_t server_crt_start[] asm("_binary_server_crt_start");
extern const uint8_t server_crt_end[] asm("_binary_server_crt_end");
extern const uint8_t server_key_start[] asm("_binary_server_key_start");
extern const uint8_t server_key_end[] asm("_binary_server_key_end");
extern const uint8_t pairing_txt_start[] asm("_binary_pairing_txt_start");

static esp_codec_dev_handle_t microphone;
static StreamBufferHandle_t audio;
static StaticStreamBuffer_t stream_storage;
static TaskHandle_t voice_worker;
static atomic_int state, terminal_result, client_fd, end_action;
static atomic_bool stop_requested, capture_done, capture_allowed, have_ip, wifi_dropped;
static atomic_uint last_client_tick;
static uint32_t sequence;
static bool is_terminal(voice_state_t value) { return value >= VOICE_SENT; }
voice_state_t voice_state(void) { return atomic_load(&state); }

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == IP_EVENT) atomic_store(&have_ip, true);
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (atomic_exchange(&have_ip, false)) atomic_store(&wifi_dropped, true);
    }
}

static esp_err_t send_text(httpd_req_t *request, const char *message)
{
    httpd_ws_frame_t reply = {
        .type = HTTPD_WS_TYPE_TEXT, .payload = (uint8_t *)message, .len = strlen(message),
    };
    return httpd_ws_send_frame(request, &reply);
}

static esp_err_t send_audio(httpd_req_t *request)
{
    uint8_t packet[4 + BATCH_BYTES];
    bool complete = voice_state() == VOICE_RECOGNIZING && atomic_load(&capture_done);
    voice_action_t action = atomic_load(&end_action);
    if (complete && action != VOICE_ACTION_SEND) {
        xStreamBufferReset(audio);
        return send_text(request, "CANCEL");
    }
    size_t count = xStreamBufferReceive(audio, packet + 4, BATCH_BYTES, 0);
    if (!count) {
        if (complete) return send_text(request, "SEND");
        return send_text(request, "WAIT");
    }
    uint32_t wire_seq = htonl(sequence++);
    memcpy(packet, &wire_seq, 4);
    httpd_ws_frame_t reply = {
        .type = HTTPD_WS_TYPE_BINARY, .payload = packet, .len = count + 4,
    };
    return httpd_ws_send_frame(request, &reply);
}

static esp_err_t voice_ws(httpd_req_t *request)
{
    if (request->method == HTTP_GET) return ESP_OK;
    httpd_ws_frame_t message = {0};
    uint8_t data[80] = {0};
    esp_err_t err = httpd_ws_recv_frame(request, &message, 0);
    if (err != ESP_OK || message.len >= sizeof(data) || message.type != HTTPD_WS_TYPE_TEXT) return ESP_FAIL;
    message.payload = data;
    err = httpd_ws_recv_frame(request, &message, sizeof(data) - 1);
    if (err != ESP_OK) return err;
    int fd = httpd_req_to_sockfd(request);
    voice_state_t current = voice_state();

    if (!request->sess_ctx || atomic_load(&client_fd) != fd) {
        if (current != VOICE_CONNECTING || atomic_load(&client_fd) >= 0 ||
            message.len != 69 || memcmp(data, "AUTH ", 5) ||
            mbedtls_ct_memcmp(data + 5, pairing_txt_start, 64)) return ESP_FAIL;
        request->sess_ctx = malloc(1);
        if (!request->sess_ctx) return ESP_ERR_NO_MEM;
        atomic_store(&last_client_tick, xTaskGetTickCount());
        atomic_store(&client_fd, fd);
        return send_text(request, "READY2");
    }
    atomic_store(&last_client_tick, xTaskGetTickCount());

    if (strcmp((char *)data, "CAPTURE") == 0 && current == VOICE_CONNECTING) {
        err = send_text(request, "GO");
        if (err == ESP_OK) atomic_store(&capture_allowed, true);
        return err;
    }
    if (strcmp((char *)data, "PULL") == 0) return send_audio(request);
    if (strcmp((char *)data, "ABORT") == 0) {
        err = send_text(request, "ACK");
        atomic_store(&terminal_result, VOICE_SEND_ERROR);
        return err;
    }
    if (current == VOICE_RECOGNIZING) {
        voice_state_t result = VOICE_IDLE;
        if (strcmp((char *)data, "SENT") == 0) result = VOICE_SENT;
        if (strcmp((char *)data, "SUBMITTED") == 0) result = VOICE_SUBMITTED;
        if (strcmp((char *)data, "DRAFTED") == 0) result = VOICE_DRAFTED;
        if (strcmp((char *)data, "CANCELLED") == 0) result = VOICE_CANCELLED;
        if (strcmp((char *)data, "SAVED") == 0) result = VOICE_SAVED;
        if (strcmp((char *)data, "EMPTY") == 0) result = VOICE_NO_SPEECH;
        if (strcmp((char *)data, "FAILED") == 0) result = VOICE_SEND_ERROR;
        if (is_terminal(result) && atomic_load(&capture_done) && xStreamBufferIsEmpty(audio)) {
            err = send_text(request, "ACK");
            atomic_store(&terminal_result, result);
            return err;
        }
    }
    return ESP_FAIL;
}

static void capture_task(void *unused)
{
    voice_state_t result = VOICE_IDLE;
    microphone = board_microphone();
    if (!microphone) {
        atomic_store(&terminal_result, VOICE_AUDIO_ERROR);
        atomic_store(&capture_done, true);
        vTaskDelete(NULL);
        return;
    }
    /* The board's ES7210 microphone runs as a 16 kHz stereo TDM stream; the
     * voice protocol carries 16 kHz mono PCM, so downmix each 20 ms frame. */
    if (esp_codec_dev_set_in_gain(microphone, 25) != ESP_CODEC_DEV_OK) result = VOICE_AUDIO_ERROR;
    if (!atomic_load(&stop_requested) && result == VOICE_IDLE) {
        atomic_store(&state, VOICE_RECORDING);
        ESP_LOGI(TAG, "ES7210 recording at 16 kHz stereo");
        int16_t stereo[STEREO_BYTES / sizeof(int16_t)];
        int16_t mono[PCM_BYTES / sizeof(int16_t)];
        for (int frame = 0; frame < MAX_RECORD_SECONDS * 50 && !atomic_load(&stop_requested); frame++) {
            if (esp_codec_dev_read(microphone, stereo, sizeof(stereo)) != ESP_CODEC_DEV_OK) {
                result = VOICE_AUDIO_ERROR;
                break;
            }
            for (size_t i = 0; i < sizeof(mono) / sizeof(mono[0]); i++) {
                mono[i] = (int16_t)((stereo[2 * i] + stereo[2 * i + 1]) / 2);
            }
            if (xStreamBufferSpacesAvailable(audio) < sizeof(mono) ||
                xStreamBufferSend(audio, mono, sizeof(mono), 0) != sizeof(mono)) {
                result = VOICE_NETWORK_ERROR;
                break;
            }
        }
    } else if (result == VOICE_IDLE) {
        result = VOICE_CANCELLED;
    }
    if (result == VOICE_IDLE) {
        atomic_store(&state, VOICE_RECOGNIZING);
    } else {
        atomic_store(&terminal_result, result);
    }
    atomic_store(&capture_done, true);
    vTaskDelete(NULL);
}

static voice_state_t connect_wifi(void)
{
    wifi_config_t config;
    if (provision_read(&config) != ESP_OK) return VOICE_NO_WIFI;
    atomic_store(&have_ip, false);
    atomic_store(&wifi_dropped, false);
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &config);
    memset(&config, 0, sizeof(config));
    if (err != ESP_OK || esp_wifi_start() != ESP_OK) return VOICE_NO_WIFI;
    for (int attempt = 0; attempt < 3 && !atomic_load(&stop_requested); attempt++) {
        esp_wifi_connect();
        for (int poll = 0; poll < 60 && !atomic_load(&stop_requested); poll++) {
            if (atomic_load(&have_ip)) return VOICE_IDLE;
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
    return atomic_load(&stop_requested) ? VOICE_CANCELLED : VOICE_NO_WIFI;
}

static int discovery_socket(void)
{
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) return -1;
    const struct timeval timeout = {.tv_usec = 150000};
    const struct sockaddr_in local = {.sin_family = AF_INET, .sin_port = htons(DISCOVERY_PORT)};
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
        bind(fd, (const struct sockaddr *)&local, sizeof(local)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void reply_to_discovery(int fd)
{
    struct sockaddr_in peer;
    socklen_t size = sizeof(peer);
    char data[32];
    int length = recvfrom(fd, data, sizeof(data), 0, (struct sockaddr *)&peer, &size);
    if (length == 20 && memcmp(data, "AR1?", 4) == 0) {
        data[3] = '!';
        sendto(fd, data, length, 0, (struct sockaddr *)&peer, size);
    }
}

static voice_state_t serve_voice(void)
{
    httpd_ssl_config_t config = HTTPD_SSL_CONFIG_DEFAULT();
    config.port_secure = VOICE_PORT;
    config.httpd.stack_size = 12288;
    config.httpd.max_open_sockets = 2;
    config.httpd.lru_purge_enable = true;
    config.httpd.recv_wait_timeout = 4;
    config.httpd.send_wait_timeout = 4;
    config.servercert = server_crt_start;
    config.servercert_len = server_crt_end - server_crt_start;
    config.prvtkey_pem = server_key_start;
    config.prvtkey_len = server_key_end - server_key_start;

    httpd_handle_t server = NULL;
    if (httpd_ssl_start(&server, &config) != ESP_OK) return VOICE_NETWORK_ERROR;
    const httpd_uri_t ws = {.uri = "/voice", .method = HTTP_GET, .handler = voice_ws, .is_websocket = true};
    int discover = discovery_socket();
    voice_state_t result = VOICE_NETWORK_ERROR;
    if (discover >= 0 && httpd_register_uri_handler(server, &ws) == ESP_OK) {
        int64_t deadline = esp_timer_get_time() + 20000000;
        while (atomic_load(&client_fd) < 0 && !atomic_load(&stop_requested) &&
               !atomic_load(&wifi_dropped) && esp_timer_get_time() < deadline) {
            reply_to_discovery(discover);
        }
        if (atomic_load(&client_fd) >= 0) {
            int64_t setup_deadline = esp_timer_get_time() + 20000000;
            while (!atomic_load(&capture_allowed) && !atomic_load(&stop_requested) &&
                   !atomic_load(&wifi_dropped) && !is_terminal(atomic_load(&terminal_result)) &&
                   esp_timer_get_time() < setup_deadline) {
                vTaskDelay(pdMS_TO_TICKS(25));
            }
        }
        if (atomic_load(&stop_requested)) {
            result = VOICE_CANCELLED;
        } else if (atomic_load(&wifi_dropped)) {
            result = VOICE_NETWORK_ERROR;
        } else if (atomic_load(&client_fd) < 0) {
            result = VOICE_NO_PC;
        } else if (!atomic_load(&capture_allowed)) {
            result = VOICE_SEND_ERROR;
        } else if (xTaskCreate(capture_task, "mic_capture", 8192, NULL, 7, NULL) != pdPASS) {
            result = VOICE_AUDIO_ERROR;
        } else {
            int64_t recognition_deadline = 0;
            while (!is_terminal(atomic_load(&terminal_result))) {
                TickType_t elapsed = xTaskGetTickCount() - atomic_load(&last_client_tick);
                if (voice_state() == VOICE_RECOGNIZING && !recognition_deadline) {
                    recognition_deadline = esp_timer_get_time() + 110000000;
                }
                if (atomic_load(&wifi_dropped) ||
                    (!recognition_deadline && elapsed > pdMS_TO_TICKS(6000)) ||
                    (recognition_deadline && esp_timer_get_time() > recognition_deadline)) break;
                vTaskDelay(pdMS_TO_TICKS(25));
            }
            if (is_terminal(atomic_load(&terminal_result))) result = atomic_load(&terminal_result);
            atomic_store(&stop_requested, true);
            while (!atomic_load(&capture_done)) vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
    if (discover >= 0) close(discover);
    httpd_ssl_stop(server);
    return result;
}

static void voice_task(void *unused)
{
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        xStreamBufferReset(audio);
        sequence = 0;
        atomic_store(&client_fd, -1);
        atomic_store(&capture_done, false);
        atomic_store(&capture_allowed, false);
        atomic_store(&terminal_result, VOICE_IDLE);
        voice_state_t result = connect_wifi();
        if (result == VOICE_IDLE) result = serve_voice();
        esp_wifi_stop();
        ESP_LOGI(TAG, "Voice session ended (%d)", result);
        atomic_store(&state, result);
    }
}

esp_err_t voice_init(void)
{
    uint8_t *storage = heap_caps_malloc(BUFFER_BYTES + 1, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    ESP_RETURN_ON_FALSE(storage, ESP_ERR_NO_MEM, TAG, "PCM buffer");
    audio = xStreamBufferCreateStatic(BUFFER_BYTES + 1, PCM_BYTES, storage, &stream_storage);
    ESP_RETURN_ON_FALSE(audio, ESP_ERR_NO_MEM, TAG, "PCM stream");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    ESP_RETURN_ON_FALSE(esp_netif_create_default_wifi_sta(), ESP_FAIL, TAG, "station");
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&config), TAG, "Wi-Fi init");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "Wi-Fi storage");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "Wi-Fi STA mode");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL), TAG, "IP event");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, wifi_event, NULL), TAG, "Wi-Fi event");
    return xTaskCreate(voice_task, "voice", 6144, NULL, 5, &voice_worker) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t voice_start(void)
{
    if (!voice_worker) return ESP_ERR_INVALID_STATE;
    voice_state_t current = voice_state();
    if (current != VOICE_IDLE && !is_terminal(current)) return ESP_ERR_INVALID_STATE;
    atomic_store(&stop_requested, false);
    atomic_store(&end_action, VOICE_ACTION_NONE);
    atomic_store(&state, VOICE_CONNECTING);
    xTaskNotifyGive(voice_worker);
    return ESP_OK;
}

void voice_finish(voice_action_t action)
{
    voice_state_t current = voice_state();
    int unset = VOICE_ACTION_NONE;
    if ((current == VOICE_CONNECTING || current == VOICE_RECORDING) &&
        atomic_compare_exchange_strong(&end_action, &unset, action)) {
        atomic_store(&stop_requested, true);
    }
}
