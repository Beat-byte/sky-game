# 环境与运行时（2026-10-28 实测）

## 实测结果
- 系统：macOS 15.7.7，arm64（Apple 芯片）
- 终端：`/bin/zsh`；项目目录 `/Users/skyf/Documents/program/sky/qoder/game`（**是 git 仓库**，远端 `git@github.com:Beat-byte/sky-game.git`，主干 `main`）
- **系统 Node：v20.19.5**，路径 `/usr/local/bin/node`（Bash 工具里 `node` 实际解析到的版本）
- **Qoder 智能体自带 Node：v24.18.0**（与应用内运行时一致，与终端 `node` 不同）
- npm 10.8.2 / npx 10.8.2
- 未安装版本管理器（无 nvm、volta、fnm、asdf）
- 无 pnpm、yarn、bun，也无全局 tsc
- git 2.50.1（Apple Git）、Python 3.12.10
- 本机没有 `gh` CLI：查 Actions / PR 只能网页侧看，别在脚本里调 `gh`

## 对本项目的影响
- 代码按 Node v20 的 API 和语法编写，不要假设 v22/v24 独有特性在运行时可用。
- 依赖只用 `npm` 安装；`pnpm`、`yarn`、`bun` 命令视为不可用，除非用户自行安装。
- 类型检查通过本地安装的 typescript 执行（`npx tsc`），不要直接调用全局 `tsc`。
- 若任务确实需要更新的 Node 版本，需明确说明，而不是隐性依赖智能体的 v24。

## 维护说明
- 更新本节前先重新执行 `node -v`、`npm -v`、`which node`、`uname -m`、`sw_vers -productVersion`；
  版本管理器与智能体运行时都可能变化。
