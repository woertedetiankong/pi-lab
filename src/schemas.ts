// The board tools' names, descriptions and parameters, as plain JSON Schema: pi's tools and the MCP server
// describe them the same way.

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: "number", description, ...extra });
const bool = (description: string) => ({ type: "boolean", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const SERIAL: ToolSpec = {
  name: "board_serial",
  label: "Board Serial",
  description:
    "Read the board's serial output. By default resets the board first and captures from the first boot line, for the given number of seconds or until a line matches `until`. Use this instead of `idf.py monitor` or `pio device monitor`, which never exit.",
  promptSnippet: "Reset the board and read its serial log",
  parameters: obj({
    seconds: num("How long to capture (default 8)", { minimum: 1, maximum: 120 }),
    reset: bool("Reset the board first (default true). false reads what it prints now"),
    until: str("Stop early once a line matches this regular expression, e.g. 'Guru Meditation|boot_count='"),
    port: str("Serial port; the project's chosen port, or found automatically, when left out"),
    baud: { type: "integer", minimum: 300, description: "Baud rate, when the firmware's differs from the project's setting (saved for the project). Native USB ports (ESP32-S3, ESP32-C3 USB-Serial/JTAG) ignore it" },
  }),
};

export const FLASH: ToolSpec = {
  name: "board_flash",
  label: "Board Flash",
  description:
    "Build the firmware and flash it to the board, then reset the board so it runs. Works for ESP-IDF and PlatformIO projects in the working directory, sets up the toolchain environment itself, and recovers a USB port that stopped responding. Returns compiler errors when the build fails. When the project has board checks with checkAfterFlash, runs them and reports the result.",
  promptSnippet: "Build and flash the firmware to the board",
  parameters: obj({
    build: bool("Build before flashing (default true)"),
    port: str("Serial port; found automatically when left out"),
  }),
};

export const RECOVER: ToolSpec = {
  name: "board_recover",
  label: "Board Recover",
  description: "Recover a board whose USB port stopped responding (esptool says 'No serial data received', or the serial log is empty): a software unplug and replug of the USB device.",
  promptSnippet: "Recover a board whose USB port stopped responding",
  parameters: obj({}),
};

export const EXPERIMENT: ToolSpec = {
  name: "board_experiment",
  label: "Board Experiment",
  description: [
    "Test an idea on the board as a controlled experiment instead of a one-off probe: each variant runs `repeat` times in shuffled order, the board is reset before every run so each starts from the same state, and every run is judged by the same rule. Returns a table (variant → how many runs matched) and saves it in .pi/lab/experiments/.",
    "Use it when a result surprised you, when two explanations fit what you saw, or before you write down a cause: compare the variants that would tell them apart (the suspect way vs. the alternative, old code vs. new).",
    "A variant's command runs in the project directory with PI_LAB_PORT, PI_LAB_BAUD and PI_LAB_PYTHON (a Python with pyserial) set, and gets the serial port to itself; write commands with these, not your machine's paths, so the experiment can be re-run elsewhere. Judge by the command's output (measure.source \"output\"), or by what the board prints in `observe` seconds after it (\"board\").",
    "rerun: instead of a new experiment, run a saved one (\"E3\") or a note's experiment (the note's path) again and say whether its recorded result still holds.",
  ].join(" "),
  promptSnippet: "Run a controlled, repeated experiment on the board and get a table of results",
  parameters: obj({
    question: str("What the experiment finds out, e.g. 'Does lowering DTR before opening the port restart the board?'"),
    variants: {
      type: "array", minItems: 1, maxItems: 6,
      description: "The alternatives to compare. Usually two or more: the suspect way and the control.",
      items: obj({ name: str("Short name, e.g. 'dtr low first'"), command: str("Shell command for this variant (a script that opens the port, a flash of a variant build, ...). Leave out to only observe the board") }, ["name"]),
    },
    measure: obj({
      source: { type: "string", enum: ["output", "board"], description: "Judge the command's output, or the board's serial output after the command" },
      match: str("Regular expression: a run counts as 'yes' when it matches, e.g. 'rst:0x|ESP-ROM:' for 'the board restarted'"),
      value: str("Optional regular expression with one capture group: a number to record per run, e.g. 't=(\\d+)'"),
    }, ["source", "match"]),
    repeat: { type: "integer", minimum: 1, maximum: 10, description: "Runs per variant (default 3)" },
    reset: bool("Reset the board before every run (default true)"),
    settle: num("Seconds the board runs after the reset before the command (default 3)", { minimum: 0, maximum: 60 }),
    observe: num("Seconds to read the board after the command (needed for measure.source 'board')", { minimum: 0, maximum: 120 }),
    timeout: num("Seconds a command may take (default 60)", { minimum: 1, maximum: 900 }),
    rerun: str("Run a saved experiment (e.g. 'E3') or a note's experiment (the note's path) again instead; the other parameters are ignored"),
  }),
};

export const NOTE: ToolSpec = {
  name: "lab_note",
  label: "Lab Note",
  description:
    "Keep what a settled experiment showed as a note in .pi/lab/notes/: the measured table is the note's facts, your explanation is marked as your reading of it, and the experiment travels with the note so anyone can run it again on their board (board_experiment rerun=<note>). Refuses an experiment whose variants did not answer the same way every run.",
  promptSnippet: "Save a settled experiment as a re-runnable note",
  parameters: obj({
    experiment: str("The experiment, e.g. 'E3'"),
    title: str("The note's title: the finding in one line"),
    explanation: str("Why the table looks like this, as far as you can tell. Keep it apart from what was measured"),
    tags: strings("Tags, e.g. ['esp32-s3', 'usb-serial-jtag']"),
  }, ["experiment", "title"]),
};

export const CHECK: ToolSpec = {
  name: "board_check",
  label: "Board Check",
  description:
    "Run the project's acceptance checks on the board (from .pi/lab.json \"checks\"), or the checks given here, and report PASS/FAIL per criterion: lines that must appear (expect), must not appear (forbid), no restart while watched (noRestart), a number that must stay in range and keep changing (metric). Use it to decide whether a fix is done. save=true stores the given checks as the project's.",
  promptSnippet: "Run the board's acceptance checks",
  parameters: obj({
    names: strings("Run only these of the project's checks"),
    checks: {
      type: "array",
      description: "Checks to run instead of the project's",
      items: obj({
        name: str("What it checks, e.g. 'temperature keeps updating'"),
        seconds: num("How long to watch the board (default 10)", { minimum: 1, maximum: 600 }),
        reset: bool("Reset the board first (default true)"),
        expect: strings("Regular expressions that must each appear"),
        forbid: strings("Regular expressions that must not appear, e.g. 'Guru Meditation|abort\\(\\)'"),
        noRestart: bool("The board must not restart while watched"),
        metric: obj({
          pattern: str("Regular expression whose first capture group is the number, e.g. 'temp=(-?[\\d.]+)'"),
          min: num("Lowest allowed value"), max: num("Highest allowed value"),
          changes: bool("The value must change (a live reading, not a constant)"),
          atLeast: { type: "integer", minimum: 1, description: "At least this many values (default 1)" },
        }, ["pattern"]),
      }, ["name"]),
    },
    save: bool("Store the given checks as the project's acceptance checks"),
    afterFlash: bool("With save: also run them after every board_flash"),
  }),
};

export const LOGIC: ToolSpec = {
  name: "board_logic",
  label: "Board Logic",
  description:
    "Capture signals with a logic analyzer through sigrok-cli: with a protocol decoder (i2c, spi, uart, ...) returns the decoded traffic, otherwise per channel how much it is high, its edges and frequency. Shows what the serial log cannot: whether the bus carries any traffic, which address answers, whether a pin toggles. The analyzer is set in .pi/lab.json under \"logic\".",
  promptSnippet: "Capture and decode signals with a logic analyzer (sigrok)",
  parameters: obj({
    seconds: num("Capture length (default 0.5, at most 10)", { minimum: 0.001, maximum: 10 }),
    decoder: str("sigrok protocol decoder with options, e.g. 'i2c:scl=D0:sda=D1' or 'uart:rx=D2:baudrate=115200'"),
    channels: str("Channels, e.g. 'D0,D1'"),
    samplerate: str("Sample rate, e.g. '1m', '4m'"),
    trigger: str("Start on a condition, e.g. 'D0=f' (falling edge)"),
    driver: str("sigrok driver, when the project does not set one"),
  }),
};

export const TOOLS = [SERIAL, FLASH, RECOVER, EXPERIMENT, NOTE, CHECK, LOGIC];
