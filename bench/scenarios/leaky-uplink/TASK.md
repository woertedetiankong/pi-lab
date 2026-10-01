The telemetry firmware builds a frame 50 times a second and sends it over the radio link (simulated by
`main/link.c`, which fails now and then just like the real radio). Every second it logs a `stats` line.
On the board, after a few seconds every send fails and nothing gets through any more.

Find the root cause and fix it on the board, so it keeps sending indefinitely. Do not change `main/link.c` or
`main/link.h` (they stand in for the radio driver), the frame size, or the 50 Hz rate.
