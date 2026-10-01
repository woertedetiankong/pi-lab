#include <math.h>
#include <stdio.h>
#include "bmi270.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = 0, .sda_io_num = 47, .scl_io_num = 48,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &bus));
    ESP_ERROR_CHECK(bmi270_init(bus));

    for (;;) {
        bmi270_accel_t a;
        if (bmi270_read_accel(&a) == ESP_OK) {
            printf("accel x=%.3f y=%.3f z=%.3f |a|=%.3f\n", a.x, a.y, a.z, sqrtf(a.x * a.x + a.y * a.y + a.z * a.z));
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
