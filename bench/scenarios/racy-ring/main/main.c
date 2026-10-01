#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "monitor.h"
#include "sampler.h"

void app_main(void)
{
    xTaskCreatePinnedToCore(monitor_task, "monitor", 4096, NULL, 5, NULL, 1);
    sampler_start();
}
