The DSP task should process audio frames at a steady 50 frames per second; it logs `fps=<n>` once a second.
On the board the frame rate is wrong and the task watchdog keeps firing.

Find the root cause and fix it on the board. Do not disable or relax the task watchdog, and keep the
processing work per frame as it is.
