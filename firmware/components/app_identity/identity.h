#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define BOARD_TOKEN_LEN 64
#define BOARD_CERT_MAX 512
#define BOARD_KEY_MAX 192

typedef struct {
    uint16_t cert_len;
    uint16_t key_len;
    uint8_t cert[BOARD_CERT_MAX];
    uint8_t key[BOARD_KEY_MAX];
    char token[BOARD_TOKEN_LEN];
} board_identity_t;

/* 冷启动、RF/ADC 初始化之前调用。只在设备没有身份时生成。 */
esp_err_t board_identity_init(void);
esp_err_t board_identity_read(board_identity_t *identity);
/* 只从受信 USB 命令调用；成功后立即重启，不保留原身份。 */
esp_err_t board_identity_erase(void);
void board_identity_clear(board_identity_t *identity);
