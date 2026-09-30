# pi-lab

给 [pi](https://pi.dev/) 用的嵌入式调试插件：调了两个小时，agent 仍然记得试过什么、板子上看到了什么，也知道板子上跑的是不是最新的代码。

> 早期骨架（v0.1.0）。

## 功能

1. **调试账本**：agent 用 `lab_ledger` 工具记录目标板、硬件证实过的事实、假设及其状态（待验证 / 验证中 / 已排除 / 已确认）。账本每轮都会写进系统提示，上下文压缩后也不会丢失。
   - 把假设标为「已排除」或「已确认」时，必须给出证据（日志行、寄存器值、测量结果）。
   - 新假设和已排除的假设相似时（中英文都能识别）会被拒绝，并提示之前为什么被排除。agent 需要说明两者有什么不同，再用 `force: true` 添加。
   - 账本按会话分支保存：在 `/tree` 里切换分支后，账本也随之切换。
2. **固件同步检测**：agent 运行烧录命令成功后（`idf.py flash`、`pio run -t upload`、`west flash`、openocd `program`、probe-rs、st-flash、STM32_Programmer_CLI、nrfjprog、`make flash` 等），插件会记下当时固件源码的指纹（git HEAD、源码改动、未跟踪文件的内容）。之后源码一改，状态栏就显示 `⚠ board runs stale firmware`，agent 也会看到提醒。只有固件相关文件（`.c/.h/.ld/CMakeLists.txt/sdkconfig/prj.conf/…`）的改动才算，改文档不会触发。
   - 如果 agent 这一轮改了固件却没有烧录就想结束，插件会提醒一次：要么烧录后在板子上验证，要么明确告诉用户这个修复还没在硬件上测过。
3. **旧日志折叠**：编译、烧录、串口日志在发给模型的上下文里只保留最新两份完整内容；更早的只保留开头、结尾和看起来像错误的行（error / fault / panic / Guru Meditation / watchdog / `E (123)` 等）。会话文件里仍然保存完整日志。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/lab` | 查看账本和固件同步状态 |
| `/lab target <描述>` | 设置目标板，例如 `/lab target STM32F407 on /dev/ttyUSB0` |
| `/lab flashed` | 在 pi 之外烧录后（IDE、图形烧录工具），手动标记为已同步 |
| `/lab clear` | 清空当前分支的账本 |

固件同步检测要求项目是 git 仓库；不是 git 仓库时，这部分功能不启用。

## 安装

需要 Node.js 22.19+ 和 pi 0.87 或更新版本。

```bash
# 从 GitHub 安装（写入 ~/.pi/agent/settings.json，所有项目都能用）
pi install git:github.com/woertedetiankong/pi-lab

# 或只装到当前项目（写入 .pi/settings.json）
pi install git:github.com/woertedetiankong/pi-lab -l

# 或不安装，只在这次运行中试用
pi -e git:github.com/woertedetiankong/pi-lab
```

安装后重启 pi，在 git 仓库里的固件项目中，底部状态栏会出现 `🔌`（也可以输入 `/lab` 确认已加载）。更新到最新版本：`pi update --extensions`。卸载：`pi remove git:github.com/woertedetiankong/pi-lab`。

开发者从本地目录安装：`pi install /path/to/pi-lab`。

## 开发

```bash
npm install
npm run check   # tsc
npm test        # node --test
```

## License

MIT
