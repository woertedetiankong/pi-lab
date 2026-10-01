#include <inttypes.h>
#include <stdio.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "sensor";

#define FIFO_BURST        5    /* readings the sensor FIFO holds per burst */
#define BURST_INTERVAL_MS 500
#define QUEUE_LEN         4

static QueueHandle_t readings;

/* Stand-in for the sensor: a deterministic temperature for each sample, in centi-degrees. */
static int fake_temperature(uint32_t seq)
{
    return 2150 + (int)((seq * 37) % 300) - 150;
}

static void sensor_task(void *arg)
{
    char line[48];
    uint32_t seq = 0;
    for (;;) {
        for (int i = 0; i < FIFO_BURST; i++, seq++) {
            int t = fake_temperature(seq);
            snprintf(line, sizeof line, "seq=%" PRIu32 " temp=%d.%02d", seq, t / 100, t % 100);
            char *msg = line;
            if (xQueueSend(readings, &msg, pdMS_TO_TICKS(10)) != pdTRUE) {
                ESP_LOGW(TAG, "queue full, reading %" PRIu32 " dropped", seq);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(BURST_INTERVAL_MS));
    }
}

static void report_task(void *arg)
{
    char *msg;
    for (;;) {
        if (xQueueReceive(readings, &msg, portMAX_DELAY) == pdTRUE) {
            /* Uploading a report takes a while. */
            vTaskDelay(pdMS_TO_TICKS(30));
            printf("report %s\n", msg);
        }
    }
}

void app_main(void)
{
    readings = xQueueCreate(QUEUE_LEN, sizeof(char *));
    xTaskCreate(report_task, "report", 3072, NULL, 4, NULL);
    xTaskCreate(sensor_task, "sensor", 3072, NULL, 5, NULL);
}
