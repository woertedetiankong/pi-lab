#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "sample.h"

/* Single-producer, single-consumer ring buffer of samples. */

#define RB_SIZE 64

/* Producer side (sampler). Stamps the sample's CRC. Returns false and counts a drop when the ring is full. */
bool rb_push(const sample_t *s);

/* Consumer side (monitor). Returns false when the ring is empty. */
bool rb_pop(sample_t *out);

uint32_t rb_dropped(void);
