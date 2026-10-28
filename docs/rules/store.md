# 持久化（只走 src/services/store.js）

碰 `localStorage`、战绩、偏好、存档之前先读这份。

## 三个互不相干的键域

| 键 | 结构 | 用途 |
| --- | --- | --- |
| `sky-games:game:<id>` | `{v, best, plays, records[]}` | 单局成绩（五款游戏都用） |
| `sky-games:global` | `{v, prefs}` | 全局偏好（静音、视图偏好等） |
| `sky-games:save:<id>` | `{v, ...游戏自定义}` | 跨局资产（危险行动：仓库/货币/配装；愤怒的小鸟：`unlocked`/`stars`/`best`） |

**当前两个版本号都是 `1`**（`SCHEMA_VERSION` 管成绩与全局偏好，`SAVE_SCHEMA_VERSION` 管跨局存档）。
**存档必须单独一个键域，不要往 `game:<id>` 里塞新字段**：`store.js` 对成绩文档有两处"自愈"
（版本不符当空档、`records` 非数组时只挑 `best`/`plays` 重建），未知字段会被静默丢掉；
而且存档的 `SAVE_SCHEMA_VERSION` 与成绩的 `SCHEMA_VERSION` 各有各的递增节奏，混用会互相清零。

## 铁律

- **游戏模块与组件不得直接调用 `localStorage`**；一切读写走 `src/services/store.js`
  （框架无关，注入 `storage` 即可在 Node 里测，见 `test/store.test.js` 的 18 例）。
- 组件侧只用 `src/composables/useStore.js` 暴露的 `useStore` / `useGameStats(id)` / `usePrefs` /
  `useStorageAvailable` / `useGameSave(id, defaults)`。
- 写入时机只有"一局结束"（over/won/quit）和"配装/商店变更"，**绝不每帧落盘**。
- 读坏就当没有，写失败就退回内存副本并广播"存储不可用"，**绝不让持久化异常打断游戏主循环**
  （隐私模式会抛错、配额会写满、内容可能被手工改坏，这些路径都有对应单测）。
- 战绩上限 `RECORD_LIMIT = 20`。
- v1 的裸键 `pixel-breakout-best` 由注册表 `bestKey` 驱动一次性迁移，勿删。
- `readSave` 交回深拷贝，`writeSave` 由存储层盖版本戳；调用方不要自己写 `v`。

## 改结构时

同步 `test/store.test.js`，并按节奏递增对应的 `SCHEMA_VERSION` 或 `SAVE_SCHEMA_VERSION`
（否则老用户数据会被当空档清掉），见 [testing.md](testing.md)。
