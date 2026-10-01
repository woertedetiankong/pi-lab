#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "dsp";

#define FRAME_PERIOD_MS 20   /* 50 frames per second */
#define WORK_US         12000

static volatile float sink;

/* Stand-in for filtering one frame: about 12 ms of CPU work. */
static void process_frame(void)
{
    int64_t start = esp_timer_get_time();
    float acc = 0;
    for (int i = 0; esp_timer_get_time() - start < WORK_US; i++) {
        acc += sinf(i * 0.001f);
    }
    sink = acc;
}

static void dsp_task(void *arg)
{
    int frames = 0;
    int64_t window = esp_timer_get_time();
    for (;;) {
        int64_t start = esp_timer_get_time();
        process_frame();
        frames++;

        /* Sleep for the rest of the frame period, giving the CPU to other tasks. */
        int elapsed_ms = (int)((esp_timer_get_time() - start) / 1000);
        if (elapsed_ms < FRAME_PERIOD_MS) {
            vTaskDelay(pdMS_TO_TICKS(FRAME_PERIOD_MS - elapsed_ms));
        }

        if (esp_timer_get_time() - window >= 1000000) {
            ESP_LOGI(TAG, "fps=%d", frames);
            frames = 0;
            window = esp_timer_get_time();
        }
    }
}

void app_main(void)
{
    xTaskCreatePinnedToCore(dsp_task, "dsp", 4096, NULL, 5, NULL, 0);
}
