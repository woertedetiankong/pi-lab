#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "link.h"
#include "payload.h"

static const char *TAG = "uplink";

#define SEND_PERIOD_MS 20 /* 50 Hz */
#define MAX_ATTEMPTS   3

static uint32_t sent, retries, failed;

static esp_err_t send_with_retry(const uint8_t *frame, size_t len)
{
    for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        link_packet_t pkt;
        pkt.data = encode_frame(frame, len, &pkt.len);
        if (pkt.data == NULL) {
            return ESP_ERR_NO_MEM;
        }
        esp_err_t err = link_send(&pkt);
        if (err == ESP_OK) {
            return ESP_OK;
        }
        ESP_LOGW(TAG, "send failed (%s), retrying", esp_err_to_name(err));
        retries++;
    }
    return ESP_FAIL;
}

void app_main(void)
{
    link_init();
    for (uint32_t seq = 0;; seq++) {
        size_t len;
        uint8_t *frame = build_frame(seq, &len);
        if (send_with_retry(frame, len) == ESP_OK) {
            sent++;
        } else {
            failed++;
        }
        free(frame);

        if (seq % 50 == 0) {
            printf("stats seq=%" PRIu32 " sent=%" PRIu32 " retries=%" PRIu32 " failed=%" PRIu32 " queue=%u heap_free=%" PRIu32 "\n",
                   seq, sent, retries, failed, link_queue_depth(), esp_get_free_heap_size());
        }
        vTaskDelay(pdMS_TO_TICKS(SEND_PERIOD_MS));
    }
}
