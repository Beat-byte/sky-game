# 静态托管（GitHub Pages）的四个耦合点

改构建配置、路由、`404.html` 或站点图标前先看这份。任何一处被动过，其余三处要一起复验。

## 1. base 与路由

- `vite.config.js` 用 `VITE_BASE` 算 `base`（本地不注入即 `/`），路由必须
  `createWebHistory(import.meta.env.BASE_URL)`。
- 页面与组件里**不得出现 `/assets/...`、`href="/..."` 这类根绝对路径**，
  跳转一律 `<RouterLink :to="{ name: ... }">`。
- **唯一例外**：HTML 里指向 `public/` 的资源（站点图标）必须写根相对路径
  `href="/favicon.svg"`，Vite 构建时按 `base` 重写（已实测 `dist/index.html` 与 `dist/404.html`
  都变成 `/前缀/favicon.svg`）。手写 `%BASE_URL%` 或把它挪进 `src/` 反而是错的。

## 2. `404.html` 是第二个 rollup 入口

- 由 `build.rollupOptions.input.fallback` 声明，靠同名插件的 `transformIndexHtml`
  把 `%GHPAGES_BASE_URL%` 换成真实前缀。
- **删掉这个 input 或改占位符名，发布产物就没有 SPA 回退。**
- 别把 `404.html` 放进 `public/` —— 那里的文件不会被 Vite 处理，占位符会原样留在线上。

## 3. 深链接回退约定 `?r=<站内路径>`

- 404 页把原始路径塞进查询参数跳回站点根。
- `src/router/index.js` 必须在 **`createRouter` 之前**用 `history.replaceState` 还原地址栏
  （`createWebHistory` 在创建的那一瞬间就读走了 `window.location`，晚了就来不及）。
- 还原时要校验路径以单个 `/` 开头且只含 `[\w\-./]`，**防开放重定向**。

## 4. 站点图标是生成物

- `scripts/gen-icons.mjs` 里那张 16×16 像素矩阵是**唯一真实来源**；
  `public/favicon.svg`、`public/favicon.png`(48)、`public/apple-touch-icon.png`(192) 由它产出并提交进仓库。
- 改图案只改矩阵再跑 `npm run icons`，**不要手改产物**（`test/icons.test.js` 会把已提交产物与矩阵对拍）。
- PNG 是 Node 内置 `zlib` 手写编码的（本机只有 `sips`，既不能栅格化 SVG 也不能出 ICO，所以不做 `.ico`）。
- 尺寸必须是 16 的整数倍；`apple-touch-icon` 必须是实心背景（iOS 把透明填黑）。

## workflow 与 CI

- `.github/workflows/deploy.yml` 按 `github.event.repository.name` 推导前缀；
  托管到用户根站点时改用仓库变量 `SITE_BASE=/`。
- `npm ci` 已实测可用（lockfile 根条目仍写着 v1 的 `qoder-breakout` 名字，npm 不校验该项；
  要改就重新生成 lock，注意 npm 10.8.2 的 arborist 缺陷，见 [stack-and-deps.md](stack-and-deps.md)）。
- 本机没有 `gh` CLI，Actions 运行状态只能网页查看（见 [environment.md](environment.md)）。

## 怎么验证托管真的对

要**在本地起一个无 SPA 回退的静态服务器**（未命中返回 `404.html` + 404 状态码）来测深链接：
Pages 不会替你回退，而直接 `npm run preview` 会因 Vite 的 spa 回退掩盖问题，测不出真实行为。

## 相关

- 服务与端口（dev 5173 / preview 4173、`scripts/dev.mjs`）见 [stack-and-deps.md](stack-and-deps.md)
