#include <inttypes.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "boot";

#define STORAGE_NAMESPACE "stats"
#define BOOT_COUNT_KEY    "boot_count"

static esp_err_t storage_init(void)
{
    esp_err_t err = nvs_flash_init();
    /* A partition written by an older layout must be erased before it can be used again. */
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

static uint32_t load_boot_count(nvs_handle_t nvs)
{
    uint32_t count = 0;
    esp_err_t err = nvs_get_u32(nvs, BOOT_COUNT_KEY, &count);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "no boot count stored yet");
        return 0;
    }
    ESP_ERROR_CHECK(err);
    return count;
}

static void save_boot_count(nvs_handle_t nvs, uint32_t count)
{
    ESP_ERROR_CHECK(nvs_set_u32(nvs, BOOT_COUNT_KEY, count));
    ESP_ERROR_CHECK(nvs_commit(nvs));
    ESP_LOGI(TAG, "saved boot_count=%" PRIu32, count);
}

void app_main(void)
{
    ESP_ERROR_CHECK(storage_init());

    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &nvs));

    uint32_t count = load_boot_count(nvs) + 1;
    printf("boot_count=%" PRIu32 " (reset reason %d)\n", count, esp_reset_reason());

    /* Let the power rail settle before writing to flash. */
    vTaskDelay(pdMS_TO_TICKS(1500));
    save_boot_count(nvs, count);
    nvs_close(nvs);

    for (int tick = 0;; tick++) {
        ESP_LOGI(TAG, "alive %d", tick);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
