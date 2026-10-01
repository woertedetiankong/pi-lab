#pragma once
#include <stdint.h>

typedef struct {
    uint32_t seq;
    int32_t value;
    uint8_t payload[54];
    uint16_t crc; /* CRC-16/CCITT over every field before it */
} sample_t;

uint16_t sample_crc(const sample_t *s);
