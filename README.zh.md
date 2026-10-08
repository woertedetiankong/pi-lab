# pi-lab

[English](README.md) · 中文

**你和编程 AI 盯着同一个串口。** 选中几行日志问它，它在真实板子上修好再给你看。

![M5StickS3 的加速度计读数全是 0；选中五行日志发给 agent；它查手册、烧录、找到两个 bug，曲线回到 1 g](docs/demo.gif)

*真实的板子、真实的 agent，没有摆拍。加速度计读数全是 0。五行日志发给 agent，它查 Bosch 的 BMI270 原版手册（带页码），烧录复现，加几行寄存器读取，找到两个在代码里看起来完全正常的 bug，再烧一次，曲线回到 1 g。[带配音的完整视频](https://github.com/woertedetiankong/pi-lab/releases)；录制过程可以用 `demo/record.mjs` 重现。*

pi-lab 是给 [pi](https://pi.dev/) 编程 agent 用的插件。除了这块共用的屏，它还给 agent 一套不会和你抢串口的板级工具，把崩溃信息翻译进日志，不让它碰你的工具链，并用一本调试账本记住长会话里试过什么。

> 早期版本（v0.4.0）。目前在 ESP32-S3（M5StickS3）上实测；板级工具支持 ESP-IDF 和 PlatformIO 项目，USB 自动恢复仅支持 macOS。

## 快速开始

需要 Node.js 22.19+ 和 pi 0.87 或更新版本。第一次试用请先看[试用说明](docs/pilot.zh.md)：支持哪些板子和系统、半小时上手、数据去哪里。

```bash
# 从 GitHub 安装（写入 ~/.pi/agent/settings.json，所有项目都能用）
pi install git:github.com/woertedetiankong/pi-lab

# 或只装到当前项目（写入 .pi/settings.json）
pi install git:github.com/woertedetiankong/pi-lab -l

# 或不安装，只在这次运行中试用
pi -e git:github.com/woertedetiankong/pi-lab
```

安装后在固件项目里重启 pi，输入 `/lab web`：浏览器里打开板子面板，显示串口输出。选中几行日志，写一个问题，点「问 pi」；或者直接让 pi 修东西，它会用 `board_flash` 烧录、用 `board_serial` 看结果。在 git 仓库里的固件项目中，底部状态栏会出现 `🔌`（也可以输入 `/lab` 确认已加载）。更新到最新版本：`pi update --extensions`。卸载：`pi remove git:github.com/woertedetiankong/pi-lab`。

开发者从本地目录安装：`pi install /path/to/pi-lab`。

## 它是什么，不是什么

pi-lab 是你和 agent 共用的那块屏，以及它调试时的记忆。它不是又一个编译烧录服务，也不是调试探针：

- **编译烧录。** ESP-IDF 6.0 自带 MCP server（`idf.py mcp-server`：设目标、编译、烧录、清理）。pi-lab 的 `board_flash` 今天覆盖同样的事（ESP-IDF 和 PlatformIO 项目），外加烧录后等 USB 稳定再复位、USB 卡死自动恢复。官方的够用就用官方的，面板、账本和防护照常起作用。
- **调试探针。** [embedded-debugger-mcp](https://github.com/Adancurusul/embedded-debugger-mcp) 通过 probe-rs 或 OpenOCD 给 agent 一个探针：停机、读内存、断点、RTT、故障寄存器。pi-lab 不接探针，也不打算在这里竞争；它读固件打印出来的东西，并把它翻译清楚。
- **只有这里有的：** 你们两个一起看的面板（曲线、选中日志、提问），把串口借给烧录和 agent 自己的命令、而不是报「端口被占用」的串口中枢，崩溃回溯翻译进日志，工具链防护，固件过期提醒，调试账本，每一条都标明来源的板卡包，以及公开结果的真机基准测试。在这些之上，还有：在板子上做对照实验，自带实验、谁都能重跑的经验笔记，以及判定「修好了没有」的验收检查。这些也能通过 pi-lab 的 MCP 服务在 Claude Code、Codex 等 agent 里使用。

## 它还做了什么

1. **板级工具**：agent 不用自己摸索串口和复位。
   - `board_flash`：识别 ESP-IDF / PlatformIO 项目，自动加载工具链环境，编译并烧录；编译失败只返回编译错误；烧录后等 USB 稳定再复位，让新固件运行。USB 无响应时自动恢复并重试。
   - `board_serial`：复位板子，从第一行启动日志开始抓串口，抓够秒数或匹配到 `until` 就结束（代替永不退出的 `idf.py monitor`）。长日志自动折叠，完整日志存到文件。打开串口时先拉低 RTS 再拉低 DTR，避免 ESP32 原生 USB 串口在打开时被误复位。
   - `board_recover`：板子 USB 无响应时，用软件让 USB 重新枚举（相当于拔插一次，macOS）。
2. **板子面板（网页）**：`/lab web` 打开，和 pi-kb、pi-sessions 的网页在同一个地址下（`/lab/`）。
   - 实时串口日志：时间戳、按 ESP-IDF 日志级别着色、过滤；复位、烧录在日志里显示为分隔线。
   - **曲线**：日志里的 `名称=数值`（`fps=50`、`temp: 21.5`、`|a|=0.997`）自动画成曲线；启动阶段的地址、时钟等参数不画；只出现一两次的值默认隐藏。点曲线上的点跳到对应的日志行。
   - **问 pi**：在日志上按下鼠标，日志停止滚动；按住拖过几行就选中它们（单击选一行，Shift 点击选一段，⌘/Ctrl 点击加选，⌘C 复制）。写个问题，点「问 pi」，这几行和时间一起发给终端里的 agent；agent 正忙时排在当前任务之后。「↓ 回到最新」恢复自动滚动。
   - **串口和波特率**：顶部选择看哪个串口（默认「自动」：最近插上的那块板子）和波特率（9600～2000000），按项目保存在 `.pi/lab.json`；指定的串口拔掉后自动回到「自动」。收到的内容大部分是乱码时，提示波特率可能不对，点一下换成常用的波特率。ESP32-S3/C3 的原生 USB 不受波特率影响。
   - **板卡包**：在面板上选这个项目的板子，看 pi 知道它的哪些信息：芯片、总线和上面的器件、引脚、按键、已知的坑，每一项都标明是在板子上实测的还是来自厂商文档；可以看验证过的经验笔记、打开芯片手册。插着的设备和某个板卡包匹配时，面板会提示。
   - 复位板子、恢复 USB、**释放串口**（让你自己的工具或 IDE 用串口，再点一下取回）。
   - pi-lab 通过一个串口中枢独占串口，网页、`board_serial`、`board_flash` 共用：烧录时自动让出、烧完取回；agent 用 bash 跑烧录、`idf.py monitor`、esptool 或自己的串口脚本时，也会先让出串口，不会遇到「端口被占用」。没有网页在看、也没有工具在读时，串口会释放。
3. **崩溃自动解码**：串口里出现 ESP-IDF 的 `Backtrace:`、`abort() was called at PC …` 或寄存器转储的 PC 时，用项目 `build/` 里的 ELF 和 addr2line 翻译成函数和源码行（`↳ store_sample at main/main.c:14`），插在日志里；网页上高亮，`board_serial` 返回给 agent 的结果里也有。

4. **防护**：工具调用执行前检查。
   - 写入 SDK、工具链或系统目录（`~/.espressif`、`$IDF_PATH`、`~/.platformio`、`/opt/homebrew` 等），往共享 Python 环境 `pip install`，`sudo`、`brew install`：需要你确认；没有界面时（`pi -p`）直接拦下，并告诉 agent 怎么在项目内解决（把组件复制进项目、用项目内的虚拟环境）。
   - 烧 eFuse、安全启动/加密密钥、读保护等会永久改变芯片的操作，单独标为硬件风险。
   - `PI_LAB_GUARD=off` 关闭。
5. **调试账本（问题难缠时才启用）**：agent 用 `lab_ledger` 记录目标板、硬件上观察到的现象和假设，每轮写进系统提示，上下文压缩后不丢失。
   - pi-lab 默认是**轻量模式**，不要求记账：在板子上试几次就能找到的 bug 用不着这套流程（基准测试里，记账在这类问题上只增加了用时）。遇到以下情况才切换到**严谨模式**，从当轮起要求按账本规则做：同一个任务里第二次烧录、一次实验各轮结果不一致、20 次工具调用还没有结论，或者 agent 自己开始记账。`/lab careful` 和 `/lab light` 可以手动切换；在 `.pi/lab.json` 里写 `"process": "careful"`，项目从一开始就用严谨模式。模式按会话分支保存。
   - 新记录的现象先算「单次观察」，单独列出并提示不要以此为基础推理；复现之后才算事实：一次结论一致的 `board_experiment` 直接算数，会自动记入账本；其他情况重复一遍后用 `verify_fact` 记录（固件改动要从干净代码只改一处重新构建；电脑端脚本重跑同一个实验即可）。事实是在「要基于它往下推」之前复现，修好之后不需要再逐条补验证。
   - 假设标为已排除 / 已确认时必须给证据；和已排除的假设相似的新假设会被拦下（中英文都能识别）。
   - 连续 30 次工具调用没有复现的事实、也没有确认或排除假设时，提醒一次「退一步」：回到最初的症状，从头读一遍相关代码。
   - 账本按会话分支保存。
6. **固件同步检测**：烧录成功后记下固件源码的指纹（git HEAD、源码改动、未跟踪文件）。之后固件相关文件一改，状态栏显示 `⚠ board runs stale firmware`，agent 也会看到。agent 改了固件却没烧录就想结束时，提醒一次。需要项目是 git 仓库。
7. **旧日志折叠**：编译、烧录、串口日志在发给模型的上下文里只保留最新两份完整内容，更早的只留开头、结尾和像错误的行。会话文件里仍然保存完整日志。

8. **板卡包**：一块板子的知识打包在 `boards/<板子>/` 里：
   - `board.json`：芯片、I2C 总线和上面的器件、引脚、按键行为、已知的坑、用到的芯片手册。每一项都标明来源：在板子上实测的，或来自厂商文档、驱动库。
   - `notes/`：在板子上验证过的经验笔记（pi-kb 笔记格式）。
   - 用 `/lab board <id>` 或面板上的「板卡」给项目选定板子（存在项目的 `.pi/lab.json`）；连着匹配的 USB 设备、又还没选板子时，pi-lab 会提示。选定后，引脚、总线和已知的坑写进提示词；芯片手册下载一次到 `~/.pi/agent/pi-lab/boards/<id>/docs/`。
   - 同时装了 [pi-kb](https://github.com/woertedetiankong/pi-kb) 时，手册和笔记会导入到以板子命名的资料集，agent 检索时带页码引用；没装时，agent 直接读这些文件。
   - 目前有：`m5sticks3`（M5StickS3：内部 I2C、BMI270、M5PM1，以及串口打开即复位、USB 卡死、侧键下载模式、BMI270 初始化四篇笔记）。
9. **对照实验**（`board_experiment`）：结果出乎意料，或者有两种解释都说得通时，agent 用对照实验来验证，而不是写一次性的探测脚本。每个变体（一条命令：用某种方式打开串口的脚本、某个变体固件……）跑若干次，顺序打乱，每次运行前复位板子，每次都用同一条规则判定：对命令输出或之后板子打印的内容做正则匹配，还可以每次记录一个数值。结果是一张表，连同运行环境保存在 `.pi/lab/experiments/E<n>.json`：

   | 变体 | `rst:0x\|ESP-ROM:` | 第一个 `t=`（开机后毫秒） | 一致 |
   | --- | --- | --- | --- |
   | 打开前把 DTR、RTS 设低 | 3/3 | 16 | 是 |
   | pyserial 默认方式 | 0/3 | 8207 | 是 |
   | 两根线保持高，先拉低 RTS 再拉低 DTR | 0/3 | 8207 | 是 |

   命令运行时独占串口，并能拿到 `PI_LAB_PORT`、`PI_LAB_BAUD` 和 `PI_LAB_PYTHON`（带 pyserial 的 Python）。每个变体每次结果都一致的表，会作为已复现的事实记入调试账本；结果不一致时，pi-lab 切换到严谨模式。
10. **能重跑的经验笔记**（`lab_note`）：结论一致的实验可以存成 `.pi/lab/notes/` 里的笔记，格式和 pi-kb 一样。实测的表格是笔记里的事实；agent 的解释单独放、标明「未经测量」（基准测试里，没有笔记的 agent 修好了 bug，但三次里有两次把原因说错）。实验跟着笔记走：`board_experiment` 的 `rerun` 指向这条笔记，就会在另一块板子上、或者 SDK 升级之后重跑一遍，告诉你结论还成不成立；项目里的笔记不再成立时，会标成 `status: needs-review`，新表格记在「Re-runs」下面。M5StickS3 的「打开串口即复位」笔记已经带上了它的实验。
11. **板级验收检查**（`board_check`、`/lab check`）：和工程师约定好的验收标准，保存在 `.pi/lab.json`：必须出现的行（`expect`）、不能出现的行（`forbid`）、观察期间不能重启（`noRestart`）、某个数值要在范围内并且持续变化（`metric`）。设置 `"checkAfterFlash": true` 后，每次 `board_flash` 之后自动跑，修没修好由它来判定：

   ```
   [PASS] the logger starts
   [PASS] uptime keeps rising, readings plausible
   [FAIL] no restart in 3 minutes
          FAIL no restart: the board booted 1 more time(s) while watched
   ```
12. **逻辑分析仪**（`board_logic`）：看串口日志里看不到的东西，通过 [sigrok-cli](https://sigrok.org/wiki/Sigrok-cli) 支持各种分析仪（便宜的 fx2lafw 板、Saleae、DSLogic）。指定协议解码器（`i2c:scl=D0:sda=D1`、`uart:rx=D2:baudrate=115200` 等）时返回解码后的通信内容和按类型的统计；不指定时返回每个通道的高电平占比、跳变次数和频率。在 `.pi/lab.json` 里设置分析仪：`{"logic": {"driver": "fx2lafw", "names": {"D0": "SCL", "D1": "SDA"}}}`。

## 在 Claude Code、Codex 等 agent 里使用

pi-lab 的板级工具同时是一个 MCP 服务：`board_serial`、`board_flash`、`board_recover`、`board_experiment`、`lab_note`、`board_check`、`board_logic`，和 pi 里用的是同一份代码。项目就是 agent 启动这个服务时所在的目录（也可以用 `PI_LAB_PROJECT` 指定）。

```bash
claude mcp add pi-lab -- node /path/to/pi-lab/src/mcp.ts       # Claude Code
codex mcp add pi-lab -- node /path/to/pi-lab/src/mcp.ts        # Codex
```

需要 Node.js 22.19+（直接运行 TypeScript）和本仓库的一份代码。依赖 pi 扩展接口的功能只在 pi 里有：板子面板、工具链防护、调试账本和它的两种模式、固件同步检测、日志折叠。


## 已知问题

- ESP32-S3 原生 USB 偶尔会在应用启动、接管 USB 时卡住（日志停在 bootloader 的 `Disabling RNG early entropy source...`）。pi-lab 复位后检测到这种情况会自动重新枚举 USB 再复位一次；其他时候用面板上的「恢复 USB」或 `board_recover`。

## 实测

`bench/` 是在真实 M5StickS3 上的调试测试：6 个埋了 bug 的 ESP-IDF 项目，agent 修完后由脚本烧录并看板子判定。详见 [bench/README.md](bench/README.md)。目前的结论（deepseek-flash）：

- 6 个场景普通 pi 和 pi-lab 都能修好，**pi-lab 没有让 agent 更快**：只有账本的旧版本在 6 个场景里都更慢，还有一次把两条错误观察当成事实，钻了 30 分钟牛角尖（因此有了「单次观察」规则）；新版在只写板子型号的项目里 2 个场景更快、4 个更慢。
- 项目里只写板子型号时，普通 pi 在 12 次里有 1 次花了约 10 分钟摸索串口复位，有 3 次试图改动项目以外的环境（2 次试探 `sudo`，1 次往共享 Python 装包）；pi-lab 12 次里是 0 次。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/lab web` | 在浏览器打开板子面板（`/lab web url` 只显示地址，`/lab web stop` 关闭网页服务） |
| `/lab serial [串口 \| auto \| 波特率]` | 查看或设置这个项目的串口和波特率，例如 `/lab serial 9600`、`/lab serial auto` |
| `/lab` | 查看账本和固件同步状态 |
| `/lab target <描述>` | 设置目标板，例如 `/lab target STM32F407 on /dev/ttyUSB0` |
| `/lab flashed` | 在 pi 之外烧录后（IDE、图形烧录工具），手动标记为已同步 |
| `/lab clear` | 清空当前分支的账本 |
| `/lab board [id \| none]` | 查看或选择这个项目用的板卡包 |
| `/lab careful` / `/lab light` | 现在就切换到严谨模式（按账本规则），或者切回轻量模式（见「调试账本」） |
| `/lab check [名字]` | 运行这个项目的板级验收检查，或者其中一项 |

固件同步检测要求项目是 git 仓库；不是 git 仓库时，这部分功能不启用。

## 开发

```bash
npm install
npm run check   # tsc
npm test        # node --test
```

## License

MIT
