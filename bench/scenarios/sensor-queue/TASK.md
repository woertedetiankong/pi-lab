The sensor task reads the temperature sensor's FIFO in bursts and hands each reading to the reporting task,
which prints one `report seq=<n> temp=<t>` line per reading. Every reading should be reported exactly once, in
order (seq 0, 1, 2, ...), each with its own temperature. That is not what the board prints.

Find the root cause and fix it on the board. Keep the report line format, the burst size and the burst interval.
