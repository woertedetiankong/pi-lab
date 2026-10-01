#include "sampler.h"
#include <string.h>
#include "esp_timer.h"
#include "ring.h"

#define SAMPLE_PERIOD_US 1000 /* 1 kHz */

static uint32_t next_seq;

static void sample_cb(void *arg)
{
    sample_t s;
    s.seq = next_seq++;
    s.value = (int32_t)(s.seq * 7919u % 4096u) - 2048;
    for (size_t i = 0; i < sizeof s.payload; i++) {
        s.payload[i] = (uint8_t)(s.seq + i);
    }
    s.crc = 0;
    rb_push(&s);
}

void sampler_start(void)
{
    const esp_timer_create_args_t args = { .callback = sample_cb, .name = "sampler" };
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, SAMPLE_PERIOD_US));
}
