#include "codec_bsp.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>

static const char *TAG = "codec_bsp";

CodecPort::CodecPort(I2cMasterBus &i2cbus, const char *board_name) : i2cbus_(i2cbus)
{
    set_codec_board_type(board_name);

    codec_init_cfg_t cfg = {};
    cfg.in_mode = CODEC_I2S_MODE_TDM;
    cfg.out_mode = CODEC_I2S_MODE_TDM;
    cfg.in_use_tdm = true;
    cfg.reuse_dev = false;
    ESP_ERROR_CHECK(init_codec(&cfg));

    playback_ = get_playback_handle();
    record_ = get_record_handle();
    if (!record_) {
        ESP_LOGE(TAG, "No microphone stream: check the board config table");
        return;
    }

    esp_codec_dev_sample_info_t format = {};
    format.sample_rate = 16000;
    format.channel = 2;
    format.bits_per_sample = 16;
    if (playback_ && esp_codec_dev_open(playback_, &format) != ESP_CODEC_DEV_OK) {
        ESP_LOGW(TAG, "Speaker path unavailable, voice recording only");
    }
    if (esp_codec_dev_open(record_, &format) != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "Could not open the microphone stream");
        record_ = NULL;
        return;
    }
    ESP_LOGI(TAG, "ES8311/ES7210 ready at 16 kHz stereo");
}

CodecPort::~CodecPort()
{
    if (record_) {
        esp_codec_dev_close(record_);
    }
    if (playback_) {
        esp_codec_dev_close(playback_);
    }
}

void CodecPort::CodecPort_SetSpeakerVol(int vol)
{
    if (playback_) {
        esp_codec_dev_set_out_vol(playback_, vol);
    }
}

void CodecPort::CodecPort_SetMicGain(float db_value)
{
    if (record_) {
        esp_codec_dev_set_in_gain(record_, db_value);
    }
}

int CodecPort::CodecPort_PlayWrite(void *ptr, int len)
{
    return playback_ ? esp_codec_dev_write(playback_, ptr, len) : ESP_CODEC_DEV_WRONG_STATE;
}

int CodecPort::CodecPort_MicRead(void *ptr, int len)
{
    return record_ ? esp_codec_dev_read(record_, ptr, len) : ESP_CODEC_DEV_WRONG_STATE;
}
