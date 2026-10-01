# pi-lab 演示视频

用一块 M5StickS3 演示：BMI270 加速度计读数全是 0，在 pi-lab 面板上选中日志问 pi，pi 查手册、改代码、烧录、验证，曲线回到 1 g。

## 自动录制（推荐）

不需要手动录屏：脚本驱动真实的板子、真实的 agent 和 Chrome，把每一帧截下来合成 MP4。

```bash
node demo/record.mjs --lang zh     # 中文字幕 → demo/out/pi-lab-demo-zh.mp4
node demo/record.mjs --lang en     # English captions → demo/out/pi-lab-demo-en.mp4
```

需要：M5StickS3 插在 USB 上、ESP-IDF v6.0.1、Google Chrome、ffmpeg、pi（配置好模型）、`../pi-knowledge`（pi-kb，用于手册引用）。

脚本会：

1. 运行 `demo/setup.sh`：在 `~/pi-lab-demo` 建好（或还原）演示项目，把有 bug 的固件烧进板子。
2. 用临时的 pi 配置和临时知识库启动 pi（加载 pi-lab 和 pi-kb），不动你自己的配置和 `~/.pi/kb`。
3. 用 headless Chrome 打开板子面板，右侧叠加「pi 在做什么」，底部加字幕。
4. 按剧本操作：展示读数全是 0 → 选中 5 行日志、输入问题、点「问 pi」→ pi 工作（10 倍速）→ 曲线回到 1 g → 结尾卡片。
5. 用 ffmpeg 合成 1600×900 的 MP4。

视频里的数据都是真的：每次录出来的过程会不一样（agent 每次的做法不同），录完先看一遍再发。

## 手动录制

想自己录（加配音、用自己的终端）时：

1. `demo/setup.sh`：准备项目、烧录有 bug 的固件。每录一次前都运行一次，恢复原状。
2. `cd ~/pi-lab-demo && pi`，在 pi 里输入 `/lab web`，浏览器打开面板。
3. 窗口布局：浏览器在左（约 60% 宽），终端在右；终端字号调大（18pt 左右）。浏览器地址栏里有访问令牌（`#token=…`），录制时裁掉地址栏。
4. 用 `⌘ + Shift + 5`（录制所选部分）或 OBS 开始录制，然后按下面的分镜操作。

| 时间 | 操作 | 字幕 |
| --- | --- | --- |
| 0:00–0:08 | 面板上读数全是 0，曲线贴着 0 | M5StickS3 静止放在桌上，加速度计应该读到 1 g。实际读数：全是 0 |
| 0:08–0:20 | 点第一行 `accel x=0.000…`，按住 Shift 点第五行；输入问题，点「问 pi」 | 在 pi-lab 面板上选中这几行日志，直接问 pi |
| 0:20–1:00 | 切到终端，pi 查手册、改代码、烧录（剪辑时加速） | pi 查 BMI270 手册（带页码）、读代码、改代码、烧录、看串口 |
| 1:00–1:15 | 回到面板，曲线跳到 1 g 附近 | 修好了：\|a\| ≈ 1.00 g，结果在真实板子上验证 |
| 1:15–1:20 | 结尾卡片 | pi-lab · `pi install git:github.com/woertedetiankong/pi-lab` |

问题建议用：「为什么加速度读数一直是 0？板子是静止放着的。」

## 这个 bug 是什么

`main/bmi270.c` 里有两处问题，都需要对照手册才能看出来：

1. 关闭高级省电模式（`PWR_CONF=0x00`）写在了上传配置文件之后。BMI270 要求先关省电模式再上传，否则上传会悄悄失败，`INTERNAL_STATUS` 停在 0，读数全是 0。
2. `ACC_RANGE` 的寄存器地址写成了 0x42（实际是 0x41），量程停在默认的 ±8 g，修好第 1 处后读数是 0.25 g。

两处都在板子上实测过，见 `boards/m5sticks3/notes/m5sticks3-bmi270-init.md`。
