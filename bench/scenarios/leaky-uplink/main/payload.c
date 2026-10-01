#include "payload.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_system.h"

uint8_t *build_frame(uint32_t seq, size_t *len)
{
    uint8_t *frame = malloc(FRAME_SIZE);
    if (frame == NULL) {
        printf("payload: out of memory building frame %lu\n", (unsigned long)seq);
        abort();
    }
    for (size_t i = 0; i < FRAME_SIZE; i++) {
        frame[i] = (uint8_t)(seq + i * 31);
    }
    *len = FRAME_SIZE;
    return frame;
}

uint8_t *encode_frame(const uint8_t *frame, size_t len, size_t *out_len)
{
    uint8_t *out = malloc(len + 8);
    if (out == NULL) {
        return NULL;
    }
    out[0] = 0xA5;
    out[1] = 0x5A;
    out[2] = (uint8_t)(len >> 8);
    out[3] = (uint8_t)len;
    memcpy(out + 4, frame, len);
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) {
        sum += frame[i];
    }
    memcpy(out + 4 + len, &sum, 4);
    *out_len = len + 8;
    return out;
}
