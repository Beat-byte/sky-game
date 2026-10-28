# 技术栈、依赖与本地服务

## 技术栈（固定，不许漂）
- Vue 3.5.13 + vue-router 4.4.5 + Vite 5.4.11 + @vitejs/plugin-vue 5.2.1 + three 0.186.1。
- 全部 `--save-exact` 精确锁版本；`package.json` 里不出现 `^`/`~`。

## npm 10.8.2 的 arborist 缺陷
- **一条命令同时装多个依赖会触发** `Cannot read properties of null (reading 'edgesOut')`（与网络无关）。
- 绕法：拆成"运行时依赖"和"开发依赖"两条命令、各自带 `--save-exact`。后续新增依赖沿用这个拆法。
  例：`three@0.186.1` 必须**单包** `npm install three --save-exact`。
- `npm ci` 已实测可用。lockfile 根条目仍写着 v1 的 `qoder-breakout` 名字，npm 不校验该项；
  要改就重新生成 lock，注意上面那个缺陷。

## 服务与端口
- `npm run dev` → Vite dev（默认 5173）；`npm run build && npm run preview` → 预览 dist（默认 4173）。
- 两者都由 `scripts/dev.mjs` 托管，`stop` / `status` / `logs` 同样走它；当前模式记录在 `.dev-server.json`。
- Vite 响应头 `X-Sky-Games: <pid>` 用于启停脚本自检，**勿删**。
- 在浏览器里驱动游戏做回归，必须连着 dev 服务（DEV 钩子只存在于 dev，见 [game-module.md](game-module.md)）。
