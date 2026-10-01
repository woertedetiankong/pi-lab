#include "bmi270.h"
#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "bmi270";

#define BMI270_ADDR            0x68
#define BMI270_CHIP_ID         0x00
#define BMI270_ACC_DATA        0x0C
#define BMI270_INTERNAL_STATUS 0x21
#define BMI270_ACC_CONF        0x40
#define BMI270_ACC_RANGE       0x42
#define BMI270_INIT_CTRL       0x59
#define BMI270_INIT_ADDR_0     0x5B
#define BMI270_INIT_ADDR_1     0x5C
#define BMI270_INIT_DATA       0x5E
#define BMI270_PWR_CONF        0x7C
#define BMI270_PWR_CTRL        0x7D
#define BMI270_CMD             0x7E

#define ACC_RANGE_2G           0x00
#define LSB_PER_G_2G           16384.0f

extern const uint8_t bmi270_config_file[];
extern const size_t bmi270_config_file_size;

static i2c_master_dev_handle_t dev;

static void write_reg(uint8_t reg, uint8_t value)
{
    uint8_t buf[2] = { reg, value };
    esp_err_t err = i2c_master_transmit(dev, buf, sizeof buf, 100);
    if (err != ESP_OK) {
        ESP_LOGD(TAG, "write 0x%02x: %s", reg, esp_err_to_name(err));
    }
    vTaskDelay(pdMS_TO_TICKS(2));
}

static esp_err_t read_regs(uint8_t reg, uint8_t *out, size_t len)
{
    return i2c_master_transmit_receive(dev, &reg, 1, out, len, 100);
}

/* Upload the feature configuration the BMI270 needs before its sensors produce data. */
static void upload_config(void)
{
    write_reg(BMI270_INIT_CTRL, 0x00);
    uint8_t chunk[1 + 64];
    for (size_t off = 0; off < bmi270_config_file_size; off += 64) {
        write_reg(BMI270_INIT_ADDR_0, (off / 2) & 0x0F);
        write_reg(BMI270_INIT_ADDR_1, (off / 2) >> 4);
        chunk[0] = BMI270_INIT_DATA;
        memcpy(chunk + 1, bmi270_config_file + off, 64);
        i2c_master_transmit(dev, chunk, sizeof chunk, 100);
    }
    write_reg(BMI270_INIT_CTRL, 0x01);
    vTaskDelay(pdMS_TO_TICKS(30));
}

esp_err_t bmi270_init(i2c_master_bus_handle_t bus)
{
    i2c_device_config_t cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BMI270_ADDR, .scl_speed_hz = 400000 };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &cfg, &dev));

    uint8_t id = 0;
    ESP_ERROR_CHECK(read_regs(BMI270_CHIP_ID, &id, 1));
    ESP_LOGI(TAG, "chip id 0x%02x", id);

    write_reg(BMI270_CMD, 0xB6); /* soft reset */
    vTaskDelay(pdMS_TO_TICKS(20));

    upload_config();

    write_reg(BMI270_PWR_CONF, 0x00);  /* advanced power save off */
    write_reg(BMI270_PWR_CTRL, 0x04);  /* accelerometer on */
    write_reg(BMI270_ACC_CONF, 0xA8);  /* 100 Hz, normal mode */
    write_reg(BMI270_ACC_RANGE, ACC_RANGE_2G);

    ESP_LOGI(TAG, "init done");
    return ESP_OK;
}

esp_err_t bmi270_read_accel(bmi270_accel_t *out)
{
    uint8_t d[6];
    esp_err_t err = read_regs(BMI270_ACC_DATA, d, sizeof d);
    if (err != ESP_OK) {
        return err;
    }
    out->x = (int16_t)(d[0] | d[1] << 8) / LSB_PER_G_2G;
    out->y = (int16_t)(d[2] | d[3] << 8) / LSB_PER_G_2G;
    out->z = (int16_t)(d[4] | d[5] << 8) / LSB_PER_G_2G;
    return ESP_OK;
}
