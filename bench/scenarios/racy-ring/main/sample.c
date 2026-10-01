#include "sample.h"
#include <stddef.h>

uint16_t sample_crc(const sample_t *s)
{
    const uint8_t *p = (const uint8_t *)s;
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < offsetof(sample_t, crc); i++) {
        crc ^= (uint16_t)p[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}
