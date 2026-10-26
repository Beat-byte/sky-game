import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const here = dirname(fileURLToPath(import.meta.url));

// 身份头：启停脚本据此确认端口上跑的确实是本项目，避免被别的服务抢占后「假启动成功」
const identityHeader = { "X-Sky-Games": String(process.pid) };

/**
 * 站点前缀。GitHub Pages 的项目站是 https://<用户>/<仓库>/ 这种子路径，
 * 静态资源必须带上同一前缀，否则 /assets/xxx.js 会打到 https://<用户>/assets/xxx.js 上 404。
 * 由部署流水线注入 VITE_BASE（workflow 里按仓库名推导，用户根站点填 "/"）；本地不注入即为 "/"。
 */
function normalizeBase(value) {
  const trimmed = String(value ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

const base = normalizeBase(process.env.VITE_BASE);

/** 404.html 里的占位符换成真实站点前缀，回退脚本才知道该把深链接送回哪个根路径 */
const ghPagesFallback = {
  name: "sky-games:gh-pages-fallback",
  transformIndexHtml(html) {
    return html.replaceAll("%GHPAGES_BASE_URL%", base);
  },
};

export default defineConfig({
  base,
  plugins: [vue(), ghPagesFallback],
  server: {
    // host: true 让局域网里的真机（手机/平板）能直接访问开发服务器做适配验证
    host: true,
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    headers: identityHeader,
  },
  preview: {
    host: true,
    port: Number(process.env.PORT ?? 4173),
    strictPort: false,
    headers: identityHeader,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      // 两个 HTML 入口：站点首页 + 托管方的 404 回退页
      input: { index: resolve(here, "index.html"), fallback: resolve(here, "404.html") },
    },
  },
});
