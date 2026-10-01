#pragma once
#include "driver/i2c_master.h"
#include "esp_err.h"

typedef struct {
    float x, y, z; /* g */
} bmi270_accel_t;

esp_err_t bmi270_init(i2c_master_bus_handle_t bus);
esp_err_t bmi270_read_accel(bmi270_accel_t *out);
