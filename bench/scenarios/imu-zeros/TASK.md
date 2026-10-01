The M5StickS3 is lying still on the desk. The firmware reads its BMI270 accelerometer (I2C address 0x68 on
SDA=GPIO47, SCL=GPIO48) five times a second and logs `accel x=<g> y=<g> z=<g> |a|=<g>`. At rest the magnitude
|a| should be about 1.00 g (gravity). On the board it is not.

Find the root cause and fix it on the board. Keep the log format, and keep reading the real sensor.
