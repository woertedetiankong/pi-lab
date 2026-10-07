#include <inttypes.h>
#include <stdio.h>
#include "driver/temperature_sensor.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* A temperature logger meant to run unattended for weeks: five times a second it prints the time since boot and
 * the chip's temperature. A host program (tools/logger.py) collects the readings. */
void app_main(void)
{
    temperature_sensor_handle_t tsens;
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(10, 80);
    ESP_ERROR_CHECK(temperature_sensor_install(&config, &tsens));
    ESP_ERROR_CHECK(temperature_sensor_enable(tsens));
    printf("temperature logger started\n");

    for (;;) {
        float celsius = 0;
        ESP_ERROR_CHECK(temperature_sensor_get_celsius(tsens, &celsius));
        printf("t=%" PRId64 " temp=%.1f\n", esp_timer_get_time() / 1000, celsius);
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
