# 预言鲸 · 前端

Linux.do 微应用（mapp）的前端：深海蓝 + 荧光青的模型预测市场。拖动信念滑块，小鲸鱼从「幼鲸」一路进化到「鲸祖」；负方向则沉入「渊祖」。

## 开发与构建

```sh
bun install
bun run dev        # http://127.0.0.1:5194/
bun run typecheck
bun test
bun run build      # 产出 dist/package/app.zip
```

Vite 输出单份 IIFE `app.js` 与 `app.css`，`scripts/package.ts` 按官方示例打包成 `dist/package/app.zip`。

当前环境 Bun 为 1.4.2，低于官方建议的 1.4.3；本项目的安装、类型检查、测试与构建均已在此版本跑通，没有升级全局 Bun。

## 上线前替换

1. **API 地址**：改 `src/config.ts` 里的

   ```ts
   export const API_ORIGIN = "https://whale-api.example.com";
   ```

   `scripts/package.ts` 会在打包时读取这个常量，把 `manifest.json` 中的默认 origin 一并替换；也可以用环境变量覆盖：

   ```sh
   MINI_APP_API_ORIGIN=https://your-api.example.com bun run build
   ```

   只接受纯 https origin，不要带路径与结尾斜杠。

2. **应用 ID**：把 `manifest.json` 的 `id` 换成社区应用页分配的 UUID。当前占位值是

   ```text
   00000000-0000-7000-8000-000000000000
   ```

   打包时也可临时覆盖：

   ```sh
   MINI_APP_ID=<app-id> MINI_APP_VERSION=1.1.0 bun run build
   ```

3. **manifest endpoints** 与 `docs/CONTRACT.md` 第 8 节逐字一致；`test/integrity.test.ts` 会校验名称、方法、路径、auth 与动态 query。不要只改 manifest 而漏掉 `src/config.ts`。

## 目录

```text
app/
  src/
    config.ts          API origin、endpoint 表、默认配置、缓存 TTL
    app.ts             启动、路由、平台连接、缓存与 UI 编排
    api.ts             契约端点封装、响应解析、错误归一化、幂等重试
    cache.ts           localStorage 信封与 TTL
    logic.ts           滑块分档、金额校验、格式化、市场排序、彩池更新
    platform.ts        mapp SDK 连接、主题、网络 transport
    market-status.ts   状态/截止文案
    mock.ts            仅开发预览用的演示数据
    template.html      mapp 正文片段（无脚本、无内联样式、无事件属性）
    style.css          视觉系统与响应式
    strings.json       全部中文文案
    views/             市场、详情、排行榜、我的
  scripts/package.ts   打包与 manifest 改写
  test/                logic / cache / api / integrity
```

`vendor/sdk` 是从官方 SDK 复制来的原样依赖，`package.json` 通过 `file:../vendor/sdk` 引用。

## 预览方式

- `bun run dev`：本地预览。没有 mapp SDK 时，公开接口改用 `fetch` 直连 `API_ORIGIN`；私密接口不可用。
- `?demo=1`：仅供开发截图的离线演示数据，生产构建会把它 tree-shake 掉。
- `?demo=1&guest=1`：演示匿名访客的只读界面。
- `?demo=1&empty=1`：空态与空列表预览。
- `?demo=1&view=markets|leaderboard|me`：直接打开某个页签。
- `?demo=1&detail=<marketId>`：直接打开市场详情。
- `?demo=1&detail=...&confidence=72&amount=100`：预置滑块与金额，方便检查鲸鱼形态。
- `?demo=1&card=<marketId>`：直接渲染嵌入卡片（帖子 iframe 看到的界面）。
- `?demo=1&card=1&missing=1`：卡片空态（缺 market 参数）预览。

以上 query 仅在 `import.meta.env.DEV` 下生效，不会进入生产包。

## 数据与缓存

严格按契约第 10 节：

- 键前缀 `whale:v1:`；`prefs`、`draft:bet` 永久，`cache:config` 10 分钟，`cache:markets` / `cache:leaderboard` 60 秒，`cache:me` 30 秒。
- 首次渲染先读缓存，再后台刷新；网络失败不删缓存，顶部显示「离线数据 · 上次更新 …」与重试。
- 服务端返回的 `chips` 覆盖本地快照；本地缓存不参与余额、持仓或结算的权威判定。
- 提交预测使用 `crypto.randomUUID()`。同一意图（市场/方向/金额/信心）失败重试会复用同一个 `clientRequestId`，服务端 `(user_key, client_request_id)` 唯一约束保证不重复扣款。
- 成功后立即写回 `cache:me`、清空 `draft:bet`。

金额校验与服务端使用同一上下界：整数、`>= betMin`、`<= floor(chips × maxBetRatio)`；余额过低时优先提示领取鲸珠。

## 视觉与交互

- 字体全部走系统栈：标题用衬线（Iowan / Palatino / 宋体 / Noto Serif），正文用无衬线，数字用等宽；不加载远程字体。
- 色板：深海 `#03090f`、青 `#3ff2dd`、涨 `#ffcf6f`、跌 `#ff829b`。鲸珠是青色光点，涨跌只用于方向。
- 鲸鱼为内联 SVG，五档形态：
  - 涨：幼鲸 → 小鲸 → 涌鲸 → 鲸王 → 鲸祖
  - 跌：幼鲸 → 潜鲸 → 沉鲸 → 渊鲸 → 渊祖
  - 大小、漂移、倾斜、背鳍、尾鳍、光晕随 | 信念 | 连续变化；第四档（鲸王/渊鲸）起持续增强，最高档出现王冠并切换金 / 深紫配色。
- 动效：卡片渐入、鲸鱼漂浮、气泡、声呐圆环、结果提示；`prefers-reduced-motion` 与 SDK `theme.reducedMotion` 都会关闭动画。
- 响应式 320–900px；列表在 ≥680px 变两列，详情变「鲸鱼 + 预测单」双列；外层滚动，不设 `100vh`。
- 所有用户可见文案位于 `strings.json` 与 `logic.ts`，遵守契约第 2 节的用词替换：预测、投入、彩池、预期回报、结算（`test/integrity.test.ts` 校验）。

## 契约差异与待后端确认项

以下是前端实现时发现的契约空档。前端做了兼容或占位，**没有改契约**：

1. `GET /public/markets` 的公开字段没有「参与人数」。卡片仅在响应带可选 `participants` 时显示「参与 N」，否则只显示彩池。若后端愿意补该字段，前端无需改动。
2. `GET /me/positions`、`GET /me/history` 只描述了语义，没有给出字段名。当前服务端持仓返回 `marketId/marketTitle/marketStatus/side/amount/payout/status/createdAt`，历史返回 `betId/marketId/marketTitle/side/amount/confidence/status/payout/createdAt`。前端做了兼容读取（含 `marketId/market_id`、`title/marketTitle/market_title`、`betId/id` 等），建议后端在 `docs/API.md` 固定结构。
3. §7.2 说首次请求可带 `displayName`，但 §8 的 `me`（GET）没有动态 query，manifest 不允许临时加 query。前端改为在 `POST /me/claim` 与 `POST /bets` 的 body 中附带 SDK 展示名。服务端 `ensureUser` 目前只在**插入用户行**时写 `display_name`；如果应用启动的 `GET /me` 已先创建用户，后续 claim/bet 携带的名称不会被回填。需要后端在 `display_name` 为空时更新，或在 `GET /me` 提供可携带名称的合法入口。
4. 没有公告接口，第 10 节的 `seen:version` 缓存键没有数据源，因此未使用；界面上也没有公告位。
5. `public/config` 未暴露 `accuracy_min_samples`，排行榜无法在文案里写出「至少 N 次」的具体门槛。
6. `POST /me/claim` 成功响应不含 `nextClaimAt`，前端领取成功后重新请求 `GET /me` 来取得下次可领时间。
7. `GET /public/markets?id=` 的响应形状（单对象还是 `items`）未明确；前端两种都兼容。
8. 排行榜条目没有稳定的用户标识。本人高亮优先用 `GET /me/rank` 的名次，其次才用展示名匹配，避免仅凭昵称误判。
9. `public/config` 未暴露 `page_size`，前端列表固定请求 20 条；管理端若调整该值，前端不会跟随。如需联动，请补充公开字段。持仓列表单独请求 100 条，减少分页压力。
10. 服务端 `GET /me/positions` 的 `nextCursor` 返回 `market_id`，而游标子查询按 `bets.id` 读取。前端因此不对持仓展示分页（单次最多请求 100 条），避免误用；历史分页正常。建议后端统一游标语义，前端再恢复持仓分页。
11. `GET /public/leaderboard?type=assets` 在服务端直接按 `users.chips` 排序，未按 `season` 过滤；切换赛季时总资产榜不会变化。若这是产品设计（全站资产榜）可接受，否则需后端补赛季资产口径。
12. 服务端 `marketView` 的 `yesShare` 使用 `(yesPool + seedYes) / total`，契约写的是 `yesPool / (yesPool + noPool)`。前端未使用 `yesShare`（只用 `impliedYes`），界面不受影响，但两处口径应统一。

如后端确定结构调整，优先更新 `docs/CONTRACT.md` 与 `docs/API.md`，再同步 `src/api.ts` 与 `src/types.ts`。
