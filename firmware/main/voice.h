#pragma once

#include "esp_err.h"

typedef enum {
    VOICE_IDLE, VOICE_CONNECTING, VOICE_RECORDING, VOICE_RECOGNIZING,
    VOICE_SENT, VOICE_SAVED, VOICE_CANCELLED, VOICE_NO_WIFI,
    VOICE_NO_PC, VOICE_AUDIO_ERROR, VOICE_NETWORK_ERROR, VOICE_NO_SPEECH,
    VOICE_SEND_ERROR, VOICE_DRAFTED, VOICE_SUBMITTED
} voice_state_t;

esp_err_t voice_init(void);
esp_err_t voice_start(void);
typedef enum {
    VOICE_ACTION_NONE, VOICE_ACTION_SEND, VOICE_ACTION_CANCEL
} voice_action_t;

void voice_finish(voice_action_t action);
voice_state_t voice_state(void);
