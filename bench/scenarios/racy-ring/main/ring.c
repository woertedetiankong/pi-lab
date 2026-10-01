#include "ring.h"

static sample_t slots[RB_SIZE];
static volatile uint32_t head; /* next slot the producer writes */
static volatile uint32_t tail; /* next slot the consumer reads */
static volatile uint32_t dropped;

static uint32_t rb_count(void)
{
    return (head - tail + RB_SIZE) % RB_SIZE;
}

bool rb_push(const sample_t *s)
{
    if (rb_count() > RB_SIZE - 1) {
        dropped++;
        return false;
    }
    /* Claim the slot first so the consumer can start on it right away, then fill it in. */
    uint32_t slot = head;
    head = (slot + 1) % RB_SIZE;
    slots[slot] = *s;
    slots[slot].crc = sample_crc(&slots[slot]);
    return true;
}

bool rb_pop(sample_t *out)
{
    if (rb_count() == 0) {
        return false;
    }
    *out = slots[tail];
    tail = (tail + 1) % RB_SIZE;
    return true;
}

uint32_t rb_dropped(void)
{
    return dropped;
}
