#pragma once
#include <stddef.h>
#include <stdint.h>

#define FRAME_SIZE 4096

/* Build the telemetry frame for sample `seq`. Returns a malloc'd buffer of FRAME_SIZE bytes; the caller frees it. */
uint8_t *build_frame(uint32_t seq, size_t *len);

/* Encode a frame for the radio: header, payload and checksum. Returns a malloc'd buffer. */
uint8_t *encode_frame(const uint8_t *frame, size_t len, size_t *out_len);
