A 1 kHz sampler (an esp_timer callback) hands samples to the monitor task through a ring buffer. Once a
second the monitor writes a batch to storage (simulated: it takes 80 ms) and logs
`stats ok=<n> crc_err=<n> gaps=<n> dropped=<n>`. Every sample must arrive intact and in order: crc_err,
gaps and dropped must all stay at 0. On the board they don't.

Find the root cause and fix it on the board. Keep the 1 kHz sample rate and the storage write as they are,
and do not change `main/monitor.c` or `main/sample.h` (the monitor is the reference consumer).
