This firmware should count how many times the device has booted, persisted in flash: after every reset the
`boot_count=` line in the log should go up by one. Users report it always shows `boot_count=1`.

Find the root cause and fix it on the board. Keep the log format unchanged.
