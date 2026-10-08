# pi-lab 试用说明

感谢试用 pi-lab。这份说明写清楚三件事：现在能用在哪些板子上、怎么在半小时内用起来，以及我们最想从你这里了解什么。

pi-lab 是 [pi](https://pi.dev/) 编程助手的插件：让 AI 在你的真板子上调试固件。它能烧录、读串口、复位、解码崩溃，用对照实验验证猜测，并按你定好的验收标准判断问题修好没有。

## 1. 先确认能不能用

| 你的环境 | 状态 |
| --- | --- |
| ESP32 系列芯片，ESP-IDF 或 PlatformIO 项目 | ✅ 支持 |
| macOS | ✅ 实测过（M5StickS3，ESP32-S3） |
| Linux | ⚠️ 应该能用，但还没有在真板子上测过 |
| Windows | ❌ 暂不支持（找不到 COM 口） |
| 板子用 CH340 / CP2102 等 USB 转串口芯片 | ⚠️ 能识别串口，复位时序按原理适用，但还没实测；**这正是我们最需要你帮忙验证的** |
| 板子用芯片自带的 USB（ESP32-S3 / C3 的 USB-Serial/JTAG） | ✅ 实测过 |
| STM32、nRF 等其他芯片，或 Keil、IAR、自定义烧录脚本 | ❌ 暂不支持一键烧录；串口、实验、验收检查仍然可以用 |
| 板子没有自动复位电路（需要手动按复位键） | ❌ 暂不支持 |

不在支持范围内也没关系，先告诉我们你的环境，我们会优先补上。

## 2. 安装（约 10 分钟）

需要：Node.js 22.19 或更新版本，pi 0.87 或更新版本，以及装好的 ESP-IDF 或 PlatformIO。读写串口用的 pyserial 随 ESP-IDF 一起安装，不用另装。

```bash
pi install git:github.com/woertedetiankong/pi-lab
pi install git:github.com/woertedetiankong/pi-kb      # 推荐：芯片手册检索（回答带页码），实验笔记也会进入知识库
```

装完重启 pi。试用期间我们会根据反馈经常修问题，**更新**只需要：

```bash
pi update --extensions      # 然后重启 pi
```

（不写版本号安装的是最新代码，`pi update` 会跟着更新。写了版本号，例如 `pi-lab@v0.4.1`，就会固定在那个版本，`pi update` 不再更新它。）

如果你平时用 Claude Code 或 Codex，而不是 pi，可以把 pi-lab 当作 MCP 服务来用。核心功能都有，但没有网页面板和调试账本：

```bash
git clone https://github.com/woertedetiankong/pi-lab ~/pi-lab
claude mcp add pi-lab -- node ~/pi-lab/src/mcp.ts      # Claude Code
codex mcp add pi-lab -- node ~/pi-lab/src/mcp.ts       # Codex
```

这种方式更新用 `git -C ~/pi-lab pull`，然后重启 Claude Code 或 Codex。

## 3. 第一次使用（约 20 分钟）

1. **在固件项目目录里启动 pi**，接上板子，输入 `/lab web`，浏览器会打开板子面板，能看到实时串口日志和曲线。串口不对的话，在面板左上角选择，或者输入 `/lab serial`。
2. **让 AI 先读一次板子**：比如「复位板子，看看启动日志有没有报错」。它会用 `board_serial` 复位并读取日志。
3. **约定"修好"的标准**：比如「帮我设置验收检查：温度每秒都在更新、3 分钟内不重启、不出现 Guru Meditation，烧录后自动跑」。AI 会把这些条件写进 `.pi/lab.json`。之后每次烧录都会自动检查，你也可以随时输入 `/lab check`。
4. **解决一个真实问题**：在面板上选中出问题的几行日志，写下你的问题，点「Ask pi」。也可以直接在终端里描述症状。
5. **看证据**：面板上的「实验」按钮会列出 AI 做过的对照实验（每种做法试几次、结果是否一致），以及最近一次验收结果。AI 说"找到原因了"时，可以对照这里的表格判断它是不是真的验证过。

## 4. 数据去哪里

- **发给模型的内容**：你和 AI 的对话、它读到的代码和日志，会发给你在 pi 里配置的模型提供商（DeepSeek、Anthropic、OpenAI 等）。用哪家、数据怎么处理，由你的 pi 设置决定；pi-lab 不会改变这一点。
- **pi-lab 自己不往外发数据。** 它唯一的下载，是你选定板卡包后，从厂商网站下载对应的芯片手册。网页面板只在本机（127.0.0.1）打开，需要令牌才能访问。
- **保存在你项目里的东西**：对照实验记录（`.pi/lab/experiments/`）和经验笔记（`.pi/lab/notes/`）可以随 git 提交，同事拿到代码就能看到 AI 做过哪些验证。最近一次验收结果（`last-check.json`）默认不提交。
- **防护**：AI 想改 SDK 或工具链目录、往共享的 Python 环境装包，或者烧 eFuse、开启加密这类不可逆操作时，pi-lab 会先停下来问你。

## 5. 已知问题

- ESP32-S3 自带的 USB 偶尔会卡死：串口没有任何输出，esptool 报 "No serial data received"。在 macOS 上 pi-lab 会自动恢复，或者点面板上的「恢复 USB」；在 Linux 上需要拔插一次 USB 线。
- 逻辑分析仪功能（`board_logic`，基于 sigrok）还没有接真设备测过。
- AI 什么时候主动做对照实验、什么时候切换到更严格的调试流程，目前是按经验设定的，正需要你的使用反馈来调整。

## 6. 我们最想知道的

试用一周左右后，请回答这几个问题，几句话就可以：

1. **从安装到第一次读出板子的日志，花了多久？卡在了哪一步？**
2. **你让 AI 解决的那个问题，它找到的原因对吗？** 修好了吗？比你自己查快了还是慢了？
3. **实验表格和验收检查，你会看吗？信吗？** 有没有哪一次它说修好了，其实并没有？
4. 最希望它支持什么：你的芯片、烧录方式、操作系统，还是别的？

遇到问题时，请一起发给我们：

- 你装的 pi-lab 是哪一版：运行下面这行，把输出发给我们（MCP 方式请把路径换成 `~/pi-lab`）；

  ```bash
  git -C ~/.pi/agent/git/github.com/woertedetiankong/pi-lab log -1 --format="%h %ad %s" --date=short
  ```

- 你的环境：芯片、板子的 USB 芯片、操作系统、ESP-IDF 或 PlatformIO 的版本；
- 项目里的 `.pi/lab/experiments/` 文件夹（如果有）；
- 出问题那次的会话文件：在 `~/.pi/agent/sessions/` 里以项目路径命名的文件夹中。会话里有你的代码和日志，发送前请确认可以分享。

反馈请发到 [GitHub Issues](https://github.com/woertedetiankong/pi-lab/issues)，或者直接联系我们。
