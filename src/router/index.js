import { createRouter, createWebHistory } from "vue-router";
import HomeView from "../views/HomeView.vue";
import { findGame } from "../games/registry.js";

// 站点前缀：本地为 "/"，GitHub Pages 项目站为 "/<仓库>/"（构建时由 VITE_BASE 注入）
const BASE = import.meta.env.BASE_URL;

/**
 * 纯静态托管没有服务端回退，刷新深链接会命中 404.html，由它把原始路径塞进 ?r= 跳回站点根。
 * 这里在建 history 之前把地址栏还原成真实路由——createWebHistory 在创建的那一瞬间就读取
 * window.location，等到 app.use(router) 再改就晚了。
 */
function restoreFallbackPath() {
  const raw = new URLSearchParams(window.location.search).get("r");
  // 只接受本站站内路径：必须以单个 / 开头，且不含协议、反斜杠、@ 之类能改写主机的字符
  if (!raw || !/^\/[\w\-./]*$/.test(raw) || raw.startsWith("//")) return;
  if (!window.location.pathname.startsWith(BASE)) return;
  const root = BASE.endsWith("/") ? BASE.slice(0, -1) : BASE;
  window.history.replaceState(window.history.state, "", `${root}${raw}`);
}

restoreFallbackPath();

const router = createRouter({
  history: createWebHistory(BASE),
  routes: [
    { path: "/", name: "home", component: HomeView, meta: { title: "像素游戏厅" } },
    {
      path: "/game/:id",
      name: "game",
      // 视图内部按 id 查注册表并异步加载游戏组件，未知 id 给出可返回首页的提示
      component: () => import("../views/GameView.vue"),
      meta: { title: "游戏" },
      beforeEnter: (to) => (findGame(to.params.id) ? true : { name: "home" }),
    },
    { path: "/:pathMatch(.*)*", redirect: { name: "home" } },
  ],
});

router.afterEach((to) => {
  const current = to.name === "game" ? findGame(to.params.id) : null;
  document.title = current ? `${current.name} · 像素游戏厅` : "像素游戏厅";
});

export default router;
