# 发帖文案

视频：`demo/out/pi-lab-demo-en.mp4`（英文社区）、`demo/out/pi-lab-demo-zh.mp4`（中文社区）。链接：https://github.com/woertedetiankong/pi-lab

每段文案都对应一次具体的录制：重新录制后，agent 的做法会不同，发之前对照视频改一下细节（引用的页码、有没有先到 0.25 g）。

## r/esp32、r/embedded（英文）

**Title:** I made my coding agent watch the ESP32's serial port with me: select the bad lines, ask, it fixes and verifies on the board

My M5StickS3's BMI270 read all zeros. In the pi-lab panel I selected five log lines and asked "why does the accelerometer always read 0?". The agent read the initialization section of Bosch's BMI270 datasheet (with page citations), flashed the code as it was to reproduce the zeros, added register reads to the init code, and found two bugs: the config file was uploaded before advanced power save was turned off, so the upload failed silently, and ACC_RANGE was written to the wrong register. It fixed both, flashed, read the board again, and the plot went back to 1 g. Video attached (the agent part is at 5× speed). Its only reference was the datasheet itself: no notes about this bug in its knowledge base.

pi-lab is an open-source extension for the pi coding agent:

- a live serial panel in the browser: log, plots of `name=value` pairs, "ask pi" about selected lines
- board tools for the agent: flash, read the serial log from the first boot line, recover a wedged USB port
- ESP-IDF crash backtraces decoded to source lines automatically
- a guard that stops the agent from editing your SDK or installing into your system Python
- board packs: what we measured on a board (pins, quirks, datasheets), starting with the M5StickS3

Everything in the video is live, on a real board. It is early: tested on ESP32-S3 with ESP-IDF on macOS. I'd love to hear what slows you down when debugging firmware with an AI agent.

## M5Stack Community（英文）

**Title:** pi-lab: an AI debugging panel for the M5StickS3 (BMI270 zeros fixed in the video)

Same text as above, plus: the M5StickS3 board pack includes four notes we verified on the board: opening its USB serial port with pyserial's defaults resets it into download mode (lower RTS before DTR), the USB port can wedge after a reset (a USB re-enumeration recovers it), long-pressing the side button enters download mode, and the BMI270 init sequence with measurements. Corrections welcome.

## Hacker News（Show HN）

**Show HN: pi-lab – let a coding agent debug firmware on a real board**

pi-lab gives the pi coding agent a serial panel you share with it, tools to flash and read the board, crash decoding and a guard for your toolchain. In the video an ESP32-S3's accelerometer reads zeros; I select the log lines, ask, and the agent fixes two datasheet-level bugs and verifies on the board. I also benchmarked it against plain pi on six hardware bugs (two runs each): it did not make the agent faster. Without it, plain pi once spent 12 minutes on serial-port reset plumbing and tried to change the machine (sudo, pip into the shared Python) in 3 of 12 runs; with it, 0 of 12. The benchmark and its results are in the repo.

## B 站 / 知乎 / 微信群（中文）

**标题：** 让 AI 和我一起盯着 ESP32 的串口：选中几行日志问它，它查手册、改代码、烧录、验证

M5StickS3 上的 BMI270 加速度计读数全是 0。我在 pi-lab 的网页面板上选中这几行日志，问「为什么读数一直是 0」。pi 先在初始化代码里加了读寄存器的诊断，看到 INTERNAL_STATUS 停在 0x00，再去查 Bosch 的 BMI270 原版手册（引用了第 18、25 页），把「关闭省电模式」挪到上传配置文件之前，烧录后曲线从 0 升到 0.25 g。这又暴露出第二个问题：量程寄存器地址写错了。改完后曲线回到 1 g。视频里 agent 工作的部分是 5 倍速。它手里只有原版手册，知识库里没有任何关于这个 bug 的提示。

pi-lab 是给 pi 编程助手用的开源插件：

- 浏览器里的实时串口面板：日志、`名称=数值` 自动画曲线、选中日志「问 pi」
- 给 agent 的板级工具：烧录、从第一行启动日志开始读串口、USB 卡死自动恢复
- ESP-IDF 崩溃调用栈自动翻译成源码行
- 防护：不让 agent 改你的 SDK、往系统 Python 里装包
- 板卡包：在板子上实测过的引脚、坑和芯片手册，第一个是 M5StickS3

视频里都是真实的板子和真实的 agent。还很早期，目前只在 macOS + ESP32-S3 + ESP-IDF 上测过。想听听大家用 AI 调固件时最卡的是哪一步。

安装：`pi install git:github.com/woertedetiankong/pi-lab`
