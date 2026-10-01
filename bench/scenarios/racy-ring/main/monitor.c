#include "monitor.h"
#include <inttypes.h>
#include <stdio.h>
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ring.h"

/* Reference consumer: checks every sample and reports once a second. */

#define FLUSH_PERIOD_US 1000000
#define FLUSH_US        80000 /* writing a batch to storage */

#define POLL_US         100  /* poll this often for a few ms each tick, for low latency */
#define POLLS_PER_TICK  40

void monitor_task(void *arg)
{
    uint32_t expect = 0, ok = 0, crc_err = 0, gaps = 0;
    int64_t last_flush = esp_timer_get_time(), last_report = last_flush;
    for (;;) {
        for (int poll = 0; poll < POLLS_PER_TICK; poll++) {
            sample_t s;
            while (rb_pop(&s)) {
                if (sample_crc(&s) != s.crc) {
                    crc_err++;
                    continue;
                }
                if (s.seq != expect) {
                    gaps++;
                }
                expect = s.seq + 1;
                ok++;
            }
            esp_rom_delay_us(POLL_US);
        }
        int64_t now = esp_timer_get_time();
        if (now - last_flush >= FLUSH_PERIOD_US) {
            esp_rom_delay_us(FLUSH_US);
            last_flush = esp_timer_get_time();
        }
        if (now - last_report >= 1000000) {
            printf("stats ok=%" PRIu32 " crc_err=%" PRIu32 " gaps=%" PRIu32 " dropped=%" PRIu32 "\n", ok, crc_err, gaps, rb_dropped());
            last_report = now;
        }
        vTaskDelay(1);
    }
}
