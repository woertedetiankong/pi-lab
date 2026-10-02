# pi-lab

English · [中文](README.zh.md)

Embedded debugging for the [pi](https://pi.dev/) coding agent: it flashes and reads your board reliably, shares a live serial panel with you, stays out of your toolchain, and keeps track of what it tried over a long debugging session.

> Early release (v0.3.4). Tested on an ESP32-S3 (M5StickS3) on macOS. The board tools work with ESP-IDF and PlatformIO projects; automatic USB recovery is macOS only.

![The board panel: live plot of an M5StickS3's BMI270 accelerometer and its serial log](docs/panel.png)

## Quick start

Requires Node.js 22.19+ and pi 0.87 or newer.

```bash
pi install git:github.com/woertedetiankong/pi-lab
```

Restart pi in your firmware project and type `/lab web`: the board panel opens in your browser with the board's serial output. Select a few log lines, type a question and press **Ask pi**. Or just ask pi to fix something: it flashes with `board_flash` and checks the result with `board_serial`.

Other ways to install: `pi install git:github.com/woertedetiankong/pi-lab -l` for the current project only (`.pi/settings.json`), or `pi -e git:github.com/woertedetiankong/pi-lab` to try it for one run. Update with `pi update --extensions`; remove with `pi remove git:github.com/woertedetiankong/pi-lab`. From a local checkout: `pi install /path/to/pi-lab`.

## Features

1. **Board tools**, so the agent does not have to work out the serial port and resets on its own.
   - `board_flash`: recognizes ESP-IDF and PlatformIO projects, sets up the toolchain environment, builds and flashes. A failed build returns just the compiler errors. After flashing it waits for the USB port to settle, then resets the board so the new firmware runs. If the USB port stops answering, it recovers it and tries again.
   - `board_serial`: resets the board and captures the serial output from the first boot line, for a number of seconds or until a line matches `until` (instead of `idf.py monitor`, which never exits). Long logs are folded, with the full log saved to a file. The port is opened by lowering RTS before DTR, so opening it does not reset an ESP32's native USB serial port.
   - `board_recover`: when the board's USB port stops answering, a software unplug and replug (USB re-enumeration, macOS).
2. **Board panel (web)**: `/lab web` opens it at `/lab/`, on the same local page as pi-kb and pi-sessions.
   - Live serial log: timestamps, ESP-IDF log levels in colour, a filter. Resets and flashes show as separators.
   - **Plot**: `name=value` pairs in the log (`fps=50`, `temp: 21.5`, `|a|=0.997`) are plotted automatically. Addresses and clock settings printed at start-up are left out, and values printed only once or twice are hidden until you turn them on. Click a point to jump to its log line.
   - **Ask pi**: press on the log and it stops scrolling; drag over lines to select them (click for one line, Shift-click for a range, Cmd/Ctrl-click to add, Cmd/Ctrl+C to copy). Type a question and press **Ask pi**: the lines go to the agent in your terminal with their times, queued after its current turn if it is busy. **Latest** resumes following the log.
   - **Port and baud rate**: choose the port (auto: the most recently connected board) and the baud rate (9600 to 2000000), saved per project in `.pi/lab.json`. A chosen port that is not connected falls back to auto. When most of what arrives is unreadable, the panel says the baud rate probably does not match and offers common rates. The native USB on the ESP32-S3/C3 ignores the baud rate.
   - **Board pack**: choose the project's board and see what pi knows about it: chip, buses and the devices on them, pins, buttons, known quirks, each marked measured on the board or taken from the vendor's docs; read the verified notes and open the datasheets. When the connected device matches a pack, the panel suggests it.
   - Reset the board, recover the USB port, and **release the port** for your own tools or IDE (click again to take it back).
   - pi-lab owns the serial port through one serial hub shared by the panel, `board_serial` and `board_flash`. It lends the port to flashing and to bash commands that open it (a flash, `idf.py monitor`, esptool, a script of the agent's own), so neither you nor the agent meets "port busy". When no panel is watching and no tool is reading, the port is released.
3. **Crash decoding**: when the log shows an ESP-IDF `Backtrace:`, `abort() was called at PC …` or the PC of a register dump, the addresses are turned into functions and source lines with the ELF in the project's `build/` and addr2line (`↳ store_sample at main/main.c:14`). The decoded lines go into the log, are highlighted in the panel, and are part of what `board_serial` returns to the agent.
4. **Guard**: checked before each tool call.
   - Writing into an SDK, toolchain or system directory (`~/.espressif`, `$IDF_PATH`, `~/.platformio`, `/opt/homebrew`, …), `pip install` into a shared Python environment, `sudo` and `brew install` need your confirmation. Without a UI (`pi -p`) they are blocked, and the agent is told how to do it inside the project instead (copy the component into the project, use a virtual environment in the project).
   - Operations that change a chip permanently, such as burning eFuses, secure boot or flash encryption keys and read protection, are flagged as hardware risks.
   - `PI_LAB_GUARD=off` turns it off.
5. **Debug ledger**: with `lab_ledger` the agent records the target board, what the hardware showed and its hypotheses. The ledger goes into the system prompt every turn and survives context compaction.
   - Something newly recorded is a single observation: listed apart, with a note not to build on it. Reproduced from a clean build with one change, it becomes a fact with `verify_fact`.
   - Marking a hypothesis ruled out or confirmed needs evidence; a new hypothesis similar to one already ruled out is refused (in English and Chinese).
   - After 30 tool calls without a reproduced fact or a settled hypothesis, the agent is asked once to step back: restate the original symptom and read the relevant code again from the start.
   - The ledger follows the session's branches.
6. **Firmware sync**: after a successful flash, pi-lab fingerprints the firmware sources (git HEAD, changes, untracked files). As soon as a firmware file changes, the status bar shows `⚠ board runs stale firmware`, and the agent sees it too. When the agent changed firmware but is about to stop without flashing, it is reminded once. Needs the project to be a git repository.
7. **Log folding**: of the build, flash and serial logs sent to the model, only the latest two stay whole; older ones keep their start, end and lines that look like failures. The session file keeps every log in full.
8. **Board packs**: what is known about a board, in `boards/<board>/`.
   - `board.json`: chip, I2C buses and their devices, pins, button behaviour, known quirks, datasheets. Every entry says where it came from: measured on the board, or the vendor's docs or driver library.
   - `notes/`: lessons verified on the board, in pi-kb's note format.
   - `/lab board <id>`, or **Board pack** in the panel, chooses the board for a project (saved in `.pi/lab.json`); when a matching USB device is connected and no board is chosen, pi-lab suggests it. The chosen board's pins, buses and quirks go into the prompt, and its datasheets are downloaded once to `~/.pi/agent/pi-lab/boards/<id>/docs/`.
   - With [pi-kb](https://github.com/woertedetiankong/pi-kb) installed, the datasheets and notes are imported into a collection named after the board, and the agent cites them with page numbers. Without it, the agent reads the files directly.
   - Available now: `m5sticks3` (the M5StickS3: internal I2C, BMI270, M5PM1, and four notes: the port-open reset, USB wedges, the side button's download mode, the BMI270 init sequence).

## Commands

| Command | What it does |
| --- | --- |
| `/lab web` | Open the board panel in the browser (`/lab web url` prints the address, `/lab web stop` stops the page server) |
| `/lab serial [port \| auto \| baud]` | Show or set this project's serial port and baud rate, e.g. `/lab serial 9600`, `/lab serial auto` |
| `/lab` | Show the debug ledger and the firmware sync state |
| `/lab target <text>` | Set the target board, e.g. `/lab target STM32F407 on /dev/ttyUSB0` |
| `/lab flashed` | Mark the board as up to date after flashing outside pi (an IDE, a GUI flasher) |
| `/lab clear` | Clear the ledger on the current branch |
| `/lab board [id \| none]` | Show or choose the board pack for this project |

Firmware sync needs the project to be a git repository; elsewhere that part is off. In a git project, the status bar shows `🔌` once pi-lab is loaded.

## Known issues

- The ESP32-S3's native USB occasionally wedges as the app takes over the USB port at start-up (the log stops at the bootloader's `Disabling RNG early entropy source...`). After a reset, pi-lab detects this, re-enumerates the USB port and resets once more; otherwise use **Recover USB** in the panel or `board_recover`.

## Benchmark

`bench/` holds debugging tasks run on a real M5StickS3: six ESP-IDF projects with planted bugs; after the agent is done, a script flashes its code and judges the board's output. See [bench/README.md](bench/README.md). Results so far (deepseek-flash):

- Plain pi and pi-lab fixed all six scenarios, and **pi-lab did not make the agent faster**. The ledger-only version was slower in all six, and once took two misobserved "facts" for real and spent 30 minutes on the wrong theory (hence the single-observation rule). The current version, in projects that only name the board, was faster in two scenarios and slower in four.
- In projects that only name the board, plain pi spent about 10 minutes working out serial resets in 1 of 12 runs, and tried to change the machine outside the project in 3 (probing `sudo` twice, installing into the shared Python once). pi-lab: 0 of 12.

The demo video is recorded with `demo/record.mjs`: the real board, the real agent and Bosch's datasheet, nothing staged. See [demo/README.md](demo/README.md) (in Chinese).

## Development

```bash
npm install
npm run check   # tsc
npm test        # node --test
```

## License

MIT
