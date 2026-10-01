// Speaks serial_broker.py's protocol: prints a boot log on reset, records commands to stderr-free stdout events.
import { createInterface } from "node:readline";
const emit = o => process.stdout.write(JSON.stringify(o) + "\n");
emit({ t: "state", state: "open" });
let tick = 0, timer, resets = 0;
const stallFirst = process.argv.includes("--stall-first");
const alive = () => { timer = setInterval(() => emit({ t: "data", text: `alive ${tick++}\r\n` }), 50); };
alive();
createInterface({ input: process.stdin }).on("line", line => {
  const { id, cmd } = JSON.parse(line);
  if (cmd === "reset") {
    // A rebooting board prints nothing else: only its boot log, which arrives in pieces.
    clearInterval(timer);
    emit({ t: "ok", id });
    if (stallFirst && resets++ === 0) {
      setTimeout(() => emit({ t: "data", text: "rst:0x15 (USB_UART_CHIP_RESET)\r\nI (73) boot: Disabling RNG early entropy source...\r\n" }), 20);
      return;
    }
    setTimeout(() => emit({ t: "data", text: "rst:0x15 (USB_UART_CHIP_RESET)\r\nboot_count=" }), 20);
    setTimeout(() => { emit({ t: "data", text: "3 (reset reason 11)\r\nI (100) app: ready\r\n" }); alive(); }, 60);
  } else if (cmd === "release") { clearInterval(timer); emit({ t: "state", state: "released" }); emit({ t: "ok", id }); }
  else if (cmd === "acquire") { emit({ t: "state", state: "open" }); emit({ t: "ok", id }); }
  else if (cmd === "quit") process.exit(0);
  else emit({ t: "error", id, message: `unknown ${cmd}` });
});
