#include "identity.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "bootloader_random.h"
#include "esp_log.h"
#include "esp_random.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecp.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/x509_crt.h"
#include "nvs.h"

static const char *TAG = "board_identity";
static const char *NAMESPACE = "ar_identity";
static const char *KEY = "voice_v1";

void board_identity_clear(board_identity_t *identity)
{
    mbedtls_platform_zeroize(identity, sizeof(*identity));
}

static bool valid(const board_identity_t *identity)
{
    if (!identity->cert_len || identity->cert_len > BOARD_CERT_MAX ||
        !identity->key_len || identity->key_len > BOARD_KEY_MAX ||
        identity->cert[0] != 0x30 || identity->key[0] != 0x30) return false;
    for (size_t i = 0; i < BOARD_TOKEN_LEN; ++i) {
        char c = identity->token[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
}

static int entropy(void *ctx, unsigned char *data, size_t length)
{
    (void)ctx;
    esp_fill_random(data, length);
    return 0;
}

static esp_err_t generate(board_identity_t *identity)
{
    static const char host[] = "CN=airremote.local";
    static const unsigned char seed_label[] = "airremote device identity v1";
    static const unsigned char san[] = {0x30, 0x11, 0x82, 0x0f,
        'a','i','r','r','e','m','o','t','e','.','l','o','c','a','l'};
    static const char hex[] = "0123456789abcdef";
    unsigned char serial[16] = {0};
    unsigned char token[BOARD_TOKEN_LEN / 2] = {0};
    mbedtls_ctr_drbg_context rng;
    mbedtls_pk_context private_key;
    mbedtls_x509write_cert certificate;
    mbedtls_ctr_drbg_init(&rng);
    mbedtls_pk_init(&private_key);
    mbedtls_x509write_crt_init(&certificate);

    /* RF/ADC 尚未启动。临时打开硬件熵源，再用 CTR-DRBG 生成密钥及令牌。 */
    bootloader_random_enable();
    int rc = mbedtls_ctr_drbg_seed(&rng, entropy, NULL, seed_label, sizeof(seed_label) - 1);
    bootloader_random_disable();
    if (rc != 0) goto cleanup;
    if ((rc = mbedtls_pk_setup(&private_key, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY))) != 0) goto cleanup;
    if ((rc = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(private_key), mbedtls_ctr_drbg_random, &rng)) != 0) goto cleanup;
    if ((rc = mbedtls_ctr_drbg_random(&rng, serial, sizeof(serial))) != 0) goto cleanup;
    serial[0] = (serial[0] & 0x7f) | 1;
    if ((rc = mbedtls_ctr_drbg_random(&rng, token, sizeof(token))) != 0) goto cleanup;

    mbedtls_x509write_crt_set_version(&certificate, MBEDTLS_X509_CRT_VERSION_3);
    mbedtls_x509write_crt_set_md_alg(&certificate, MBEDTLS_MD_SHA256);
    mbedtls_x509write_crt_set_subject_key(&certificate, &private_key);
    mbedtls_x509write_crt_set_issuer_key(&certificate, &private_key);
    if ((rc = mbedtls_x509write_crt_set_subject_name(&certificate, host)) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_issuer_name(&certificate, host)) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_serial_raw(&certificate, serial, sizeof(serial))) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_validity(&certificate, "20200101000000", "21200101000000")) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_basic_constraints(&certificate, 1, 0)) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_key_usage(&certificate, MBEDTLS_X509_KU_DIGITAL_SIGNATURE | MBEDTLS_X509_KU_KEY_CERT_SIGN)) != 0) goto cleanup;
    if ((rc = mbedtls_x509write_crt_set_extension(&certificate, MBEDTLS_OID_SUBJECT_ALT_NAME,
                                                MBEDTLS_OID_SIZE(MBEDTLS_OID_SUBJECT_ALT_NAME), 0, san, sizeof(san))) != 0) goto cleanup;
    rc = mbedtls_x509write_crt_der(&certificate, identity->cert, sizeof(identity->cert), mbedtls_ctr_drbg_random, &rng);
    if (rc <= 0) goto cleanup;
    identity->cert_len = (uint16_t)rc;
    memmove(identity->cert, identity->cert + sizeof(identity->cert) - rc, (size_t)rc);
    memset(identity->cert + rc, 0, sizeof(identity->cert) - rc);

    rc = mbedtls_pk_write_key_der(&private_key, identity->key, sizeof(identity->key));
    if (rc <= 0) goto cleanup;
    identity->key_len = (uint16_t)rc;
    memmove(identity->key, identity->key + sizeof(identity->key) - rc, (size_t)rc);
    mbedtls_platform_zeroize(identity->key + rc, sizeof(identity->key) - rc);
    for (size_t i = 0; i < sizeof(token); ++i) {
        identity->token[i * 2] = hex[token[i] >> 4];
        identity->token[i * 2 + 1] = hex[token[i] & 15];
    }
    rc = 0;

cleanup:
    mbedtls_platform_zeroize(token, sizeof(token));
    mbedtls_x509write_crt_free(&certificate);
    mbedtls_pk_free(&private_key);
    mbedtls_ctr_drbg_free(&rng);
    if (rc != 0 || !valid(identity)) {
        ESP_LOGE(TAG, "device identity generation failed (code=%d)", rc);
        board_identity_clear(identity);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t board_identity_read(board_identity_t *identity)
{
    nvs_handle_t handle;
    esp_err_t result = nvs_open(NAMESPACE, NVS_READONLY, &handle);
    if (result != ESP_OK) return result;
    size_t size = sizeof(*identity);
    result = nvs_get_blob(handle, KEY, identity, &size);
    nvs_close(handle);
    if (result == ESP_OK && (size != sizeof(*identity) || !valid(identity))) result = ESP_ERR_INVALID_STATE;
    if (result != ESP_OK) board_identity_clear(identity);
    return result;
}

esp_err_t board_identity_init(void)
{
    board_identity_t *identity = calloc(1, sizeof(*identity));
    if (!identity) return ESP_ERR_NO_MEM;
    esp_err_t result = board_identity_read(identity);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        result = generate(identity);
        if (result == ESP_OK) {
            nvs_handle_t handle;
            result = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
            if (result == ESP_OK) {
                result = nvs_set_blob(handle, KEY, identity, sizeof(*identity));
                if (result == ESP_OK) result = nvs_commit(handle);
                nvs_close(handle);
            }
            if (result == ESP_OK) ESP_LOGI(TAG, "new device identity created; pair by USB");
        }
    }
    board_identity_clear(identity);
    free(identity);
    return result;
}

esp_err_t board_identity_erase(void)
{
    nvs_handle_t handle;
    esp_err_t result = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;
    result = nvs_erase_key(handle, KEY);
    if (result == ESP_OK || result == ESP_ERR_NVS_NOT_FOUND) result = nvs_commit(handle);
    nvs_close(handle);
    return result;
}
