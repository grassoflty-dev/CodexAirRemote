#pragma once

#include "codec_board.h"
#include "codec_init.h"
#include "i2c_bsp.h"

/*
 * Thin C++ wrapper around the vendored Espressif `codec_board` component for
 * the C6-AMOLED-2.16 board (ES8311 speaker + ES7210 microphone over I2S TDM).
 *
 * The stream is opened once at construction: 16 kHz, 2 channels, 16 bit, which
 * is what the board's TDM codec chain supports. The firmware downmixes the
 * stereo microphone frames to mono for the voice protocol.
 */
class CodecPort
{
private:
    esp_codec_dev_handle_t playback_ = NULL;
    esp_codec_dev_handle_t record_ = NULL;
    I2cMasterBus &i2cbus_;

public:
    CodecPort(I2cMasterBus &i2cbus, const char *board_name);
    ~CodecPort();

    void CodecPort_SetSpeakerVol(int vol);
    void CodecPort_SetMicGain(float db_value);
    int CodecPort_PlayWrite(void *ptr, int len);
    int CodecPort_MicRead(void *ptr, int len);

    esp_codec_dev_handle_t speaker() { return playback_; }
    esp_codec_dev_handle_t microphone() { return record_; }
};
