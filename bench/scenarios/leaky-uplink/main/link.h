#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* Radio link driver. */

typedef struct {
    uint8_t *data;
    size_t len;
} link_packet_t;

void link_init(void);

/*
 * Queue a packet for transmission.
 *
 * On ESP_OK the link takes ownership of pkt->data and frees it once the packet has been transmitted.
 * On any error the caller keeps ownership of pkt->data.
 * Returns ESP_ERR_TIMEOUT when the radio is busy (try again).
 */
esp_err_t link_send(link_packet_t *pkt);

/* Packets currently waiting in the transmit queue. */
unsigned link_queue_depth(void);
