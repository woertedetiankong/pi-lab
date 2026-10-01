#include "link.h"
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

/* Stand-in for the radio driver: a transmit task drains a queue, and the radio is busy every 5th call. */

static QueueHandle_t tx_queue;
static unsigned calls;

static void tx_task(void *arg)
{
    link_packet_t pkt;
    for (;;) {
        if (xQueueReceive(tx_queue, &pkt, portMAX_DELAY) == pdTRUE) {
            vTaskDelay(pdMS_TO_TICKS(10)); /* on air */
            free(pkt.data);
        }
    }
}

void link_init(void)
{
    tx_queue = xQueueCreate(8, sizeof(link_packet_t));
    xTaskCreate(tx_task, "link_tx", 2048, NULL, 6, NULL);
}

esp_err_t link_send(link_packet_t *pkt)
{
    if (++calls % 5 == 0) {
        return ESP_ERR_TIMEOUT;
    }
    if (xQueueSend(tx_queue, pkt, 0) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

unsigned link_queue_depth(void)
{
    return uxQueueMessagesWaiting(tx_queue);
}
