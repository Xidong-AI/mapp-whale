# 预言鲸 · 技术契约 v1

本文件是前端 `app/` 与后端 `server/` 的唯一接口契约。两个实现 lane 必须严格遵守，任何一方需要改契约，先改本文件并通知另一方。

## 1. 目标与范围

- Linux.do 微应用（mapp），虚拟筹码预测市场。
- 预测标的：DeepSeek 下一代模型（版本出现、上下文、输出上限等可机读条件）。
- 前端：Bun + Vite + TypeScript，单 IIFE `app.js`，mapp SDK。
- 后端：Cloudflare Workers + D1 + Cron Triggers。

## 2. 术语与文案

| 内部字段 | 对外文案 |
| -------- | -------- |
| chips | 鲸珠 |
| bet | 预测 / 投入 |
| pool | 彩池 |
| odds | 预期回报 |
| settle | 结算 |
| side yes/no | 涨 / 跌 |

## 3. 目录结构

```text
mapp-whale/
  app/                 # 前端（@designer 负责）
    src/
    public/
    test/
    manifest.json
    package.json
    vite.config.ts
  server/              # 后端（@fixer 负责）
    src/
    migrations/
    test/
    wrangler.jsonc
    package.json
  docs/
    CONTRACT.md        # 本文件
    API.md             # 由 server 生成或手写，面向配置者
  README.md
```

## 4. 占位与密钥

构建前必须替换：

- `<API_ORIGIN>`：后端 HTTPS origin，例如 `https://whale-api.example.com`。
- `<APP_ID>`：社区应用页分配的 UUID。

后端 secrets（`wrangler secret put`）：

| 名称 | 必填 | 说明 |
| ---- | ---- | ---- |
| `DEEPSEEK_API_KEY` | 是 | 调 `https://api.deepseek.com/models` |
| `ADMIN_TOKEN` | 是 | 管理 API 的 Bearer token，至少 32 随机字符 |
| `PLATFORM_ISSUER` | 是 | 例如 `https://linux.do` |
| `PLATFORM_APP_ID` | 是 | 与 manifest `id` 一致 |

后端 vars：

| 名称 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PLATFORM_AUDIENCE` | `<API_ORIGIN>` | JWT `aud` |
| `ALLOWED_ORIGINS` | `https://linux.do` | CORS 白名单，逗号分隔 |
| `DEEPSEEK_MODELS_URL` | `https://api.deepseek.com/models` | 结算数据源 |

## 5. 数据模型（D1）

```sql
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_key      TEXT PRIMARY KEY,          -- `${iss}#${sub}`
  display_name  TEXT,                      -- 客户端首次上报，仅展示，非权威身份
  chips         INTEGER NOT NULL DEFAULT 0,
  last_claim_day TEXT,                     -- Asia/Shanghai 的 YYYY-MM-DD
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  condition_json TEXT NOT NULL,
  deadline       INTEGER NOT NULL,         -- epoch ms
  status         TEXT NOT NULL DEFAULT 'open', -- open|locked|settled|void
  outcome        TEXT,                     -- yes|no|void
  yes_pool       INTEGER NOT NULL DEFAULT 0,
  no_pool        INTEGER NOT NULL DEFAULT 0,
  seed_yes       INTEGER NOT NULL DEFAULT 0,
  seed_no        INTEGER NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER,
  settled_at     INTEGER,
  settle_reason  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
  id                TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  market_id         TEXT NOT NULL,
  user_key          TEXT NOT NULL,
  side              TEXT NOT NULL,         -- yes|no
  amount            INTEGER NOT NULL,
  confidence        INTEGER NOT NULL,      -- -100..100
  status            TEXT NOT NULL DEFAULT 'open', -- open|won|lost|refunded
  payout            INTEGER NOT NULL DEFAULT 0,
  season            TEXT NOT NULL,         -- YYYY-MM
  created_at        INTEGER NOT NULL,
  UNIQUE (user_key, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id, status);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_season ON bets(season);

CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key   TEXT NOT NULL,
  market_id  TEXT,
  bet_id     TEXT,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,                -- claim|bet|payout|refund|adjust
  season     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);

CREATE TABLE IF NOT EXISTS season_stats (
  season      TEXT NOT NULL,
  user_key    TEXT NOT NULL,
  start_chips INTEGER NOT NULL,
  end_chips   INTEGER NOT NULL,
  staked      INTEGER NOT NULL DEFAULT 0,
  payout      INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  peak_chips  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, user_key)
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
```

## 6. 配置项（`config` 表，全部可在管理 API 修改）

| key | 默认 | 说明 |
| --- | ---- | ---- |
| `product_name` | `预言鲸` | 展示名 |
| `season` | 当前 `YYYY-MM` | 当前赛季 |
| `initial_chips` | `1000` | 新用户初始鲸珠 |
| `daily_chips` | `100` | 每日补给 |
| `bet_min` | `10` | 单笔最小投入 |
| `max_bet_ratio` | `0.5` | 单笔投入 ≤ 当前鲸珠 × 该比例 |
| `seed_per_side` | `5000` | 每个市场每边系统种子，0 关闭 |
| `models_url` | `https://api.deepseek.com/models` | 结算数据源 |
| `poll_confirmations` | `2` | 连续命中次数 |
| `accuracy_min_samples` | `5` | 入准确率榜的最少预测数 |
| `page_size` | `20` | 列表分页 |
| `retain_bet_seasons` | `2` | 保留最近几个赛季的下注明细 |
| `retain_ledger_days` | `90` | 流水保留天数 |
| `retain_audit_days` | `180` | 审计日志保留天数 |

配置读取顺序：`config` 表 → 代码默认值。`GET /public/config` 只暴露前端需要的字段。

## 7. HTTP API

统一响应：

```jsonc
// 成功
{ "ok": true, "data": {} }
// 失败
{ "ok": false, "error": { "code": "BET_TOO_LARGE", "message": "…" } }
```

时间统一 epoch 毫秒。金额统一整数。

### 7.1 公开接口（`auth: none`）

#### `GET /public/config`

返回：

```jsonc
{
  "ok": true,
  "data": {
    "productName": "预言鲸",
    "season": "2026-11",
    "betMin": 10,
    "maxBetRatio": 0.5,
    "dailyChips": 100,
    "initialChips": 1000,
    "serverTime": 1760000000000
  }
}
```

#### `GET /public/markets`

query：

- `id`（可选）：返回单个市场。
- `status`（可选）：`open|locked|settled|void`，默认全部。
- `limit`（可选）：默认 `page_size`。
- `cursor`（可选）：上一页最后一条的 `id`。

返回：

```jsonc
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "m_v5_2026",
        "title": "V5 在 2026 年底前出现？",
        "description": "以官方 /models 的 name 字段为准。",
        "deadline": 1798732799000,
        "status": "open",
        "outcome": null,
        "yesPool": 1200,
        "noPool": 800,
        "seedYes": 5000,
        "seedNo": 5000,
        "yesShare": 0.6,
        "impliedYes": 0.6,
        "payoutYes": 1.83,
        "payoutNo": 2.75,
        "hitCount": 0,
        "firstSeenAt": null,
        "settledAt": null,
        "settleReason": null
      }
    ],
    "nextCursor": null
  }
}
```

`impliedYes = (yesPool + seedYes) / (yesPool + noPool + seedYes + seedNo)`。`payoutX = totalPool / (xPool + seedX)`，保留两位小数。

#### `GET /public/leaderboard`

query：

- `type`：`assets|accuracy`，默认 `assets`。
- `season`：默认当前赛季。
- `limit`：默认 `50`，最大 `100`。

返回：

```jsonc
{
  "ok": true,
  "data": {
    "season": "2026-11",
    "type": "assets",
    "items": [
      { "rank": 1, "displayName": "鲸鱼A", "chips": 12800, "accuracy": 0.72, "samples": 18 }
    ]
  }
}
```

匿名接口不得返回 `user_key`。

### 7.2 用户接口（`auth: platform`）

身份一律取 JWT 的 `(iss, sub)`，忽略正文里的 user_id。首次请求可带 `displayName`，服务端只做长度和字符过滤，标记为展示名。

#### `GET /me`

返回：

```jsonc
{
  "ok": true,
  "data": {
    "displayName": "鲸鱼A",
    "chips": 1000,
    "season": "2026-11",
    "canClaim": true,
    "nextClaimAt": null,
    "stats": { "staked": 0, "payout": 0, "correct": 0, "total": 0, "accuracy": null }
  }
}
```

#### `POST /me/claim`

body：`{}`。按 `Asia/Shanghai` 日期判断，同一天重复调用返回 `claimed: false`。

```jsonc
{ "ok": true, "data": { "claimed": true, "chips": 1100, "amount": 100 } }
```

#### `GET /me/positions`

query：`status=open|settled`、`limit`、`cursor`。

返回按市场聚合的持仓：市场、方向、投入、状态、回报。

#### `GET /me/history`

query：`season`、`limit`、`cursor`。返回下注明细，仅本人。

#### `POST /bets`

body：

```jsonc
{
  "marketId": "m_v5_2026",
  "side": "yes",
  "amount": 100,
  "confidence": 72,
  "clientRequestId": "uuid-v4"
}
```

校验顺序：

1. `clientRequestId` 幂等：已存在则直接返回原结果。
2. 市场存在且 `status = open`、`deadline > now`。
3. `side ∈ {yes,no}`。
4. `amount >= bet_min`。
5. `amount <= floor(chips * max_bet_ratio)`。
6. `confidence ∈ [-100, 100]` 整数。

事务内：扣 `chips`、加池、插入 `bets`、写 `ledger`。返回最新余额与池。

```jsonc
{
  "ok": true,
  "data": {
    "betId": "b_…",
    "chips": 900,
    "market": { "id": "m_v5_2026", "yesPool": 1300, "noPool": 800, "impliedYes": 0.62 }
  }
}
```

#### `GET /me/rank`

query：`type`、`season`。返回本人排名、样本数；未上榜返回 `rank: null`。

### 7.3 管理接口（`Authorization: Bearer <ADMIN_TOKEN>`）

管理接口不经过 mapp manifest，供 curl/面板直接调用。

- `GET /admin/config`：全部配置。
- `PATCH /admin/config`：body 为键值对象，只允许第 6 节列出的键。
- `GET /admin/markets?status=`：含内部字段。
- `POST /admin/markets`：创建市场。

```jsonc
{
  "id": "m_v5_2026",
  "title": "V5 在 2026 年底前出现？",
  "description": "以官方 /models 的 name 字段为准。",
  "condition": { "kind": "name_regex", "regex": "DeepSeek[- ]?V5", "flags": "i" },
  "deadline": 1798732799000,
  "seedYes": 5000,
  "seedNo": 5000
}
```

- `PATCH /admin/markets/:id`：改标题、描述、截止、状态（仅 `open ↔ locked`）。
- `POST /admin/markets/:id/settle`：body `{ "outcome": "yes|no|void", "reason": "manual" }`。
- `POST /admin/markets/:id/reopen`：仅 `settled` 且无派奖时可回滚，需 `force: true`。
- `GET /admin/stats`：行数、池子总额、待结算数、存储估算。
- `POST /admin/maintenance`：执行第 11 节清理。
- `GET /admin/audit?limit=`：审计日志。

所有管理写操作写 `audit`。

## 8. mapp manifest endpoints

`app/manifest.json` 的 `endpoints` 必须与下表一致（URL 中的 `<API_ORIGIN>` 构建时替换）：

| 名称 | 方法 | 路径 | auth | 动态 query |
| ---- | ---- | ---- | ---- | ---------- |
| `publicConfig` | GET | `/public/config` | none | — |
| `publicMarkets` | GET | `/public/markets` | none | `id,status,limit,cursor` |
| `publicLeaderboard` | GET | `/public/leaderboard` | none | `type,season,limit` |
| `me` | GET | `/me` | platform | — |
| `claim` | POST | `/me/claim` | platform | — |
| `positions` | GET | `/me/positions` | platform | `status,limit,cursor` |
| `history` | GET | `/me/history` | platform | `season,limit,cursor` |
| `placeBet` | POST | `/bets` | platform | — |
| `myRank` | GET | `/me/rank` | platform | `type,season` |

权限：`user.read`、`network.request`、`storage.read`、`storage.write`、`theme.read`。

后端验签必须校验 `htu`（含固定 query 与动态 query 的边界）、`htm`、`query_keys`、`aud`、`app_id`、`channel`、`scopes`、`nbf`、`exp`。`OPTIONS` 预检放行并返回 CORS 头，不验 JWT；非预检请求才验签。

## 9. 结算引擎

`condition_json` 支持两种：

```jsonc
// 版本出现
{ "kind": "name_regex", "regex": "DeepSeek[- ]?V5", "flags": "i" }

// 字段阈值：先按 nameRegex 找到目标模型，再比较字段
{
  "kind": "field_threshold",
  "targetNameRegex": "DeepSeek[- ]?V5",
  "field": "context_window",
  "op": ">=",
  "value": 2097152
}
```

Cron（每 10 分钟）：

1. 读取 `config.models_url`，`Authorization: Bearer ${DEEPSEEK_API_KEY}`。
2. 解析 `data[]`。
3. 对每个 `status = open` 的市场求值：
   - `name_regex`：任一模型 `name` 命中。
   - `field_threshold`：存在模型 `name` 命中 `targetNameRegex`，且 `field` 满足 `op` / `value`。
4. 命中则 `hit_count += 1`，首次命中写 `first_seen_at`；`hit_count >= poll_confirmations` 时结算为 `yes`。
5. 未命中则 `hit_count = 0`。
6. `deadline <= now` 且未结算：结算为 `no`（`settle_reason = "deadline"`）。
7. 结算事务：
   - 赢方用户池 `winPool`，输方用户池 `losePool`，种子 `seedWin`、`seedLose`。
   - `total = winPool + losePool + seedWin + seedLose`。
   - 若 `winPool = 0`：全员退款（`void`）。
   - 否则每个赢方下注 `payout = floor(amount / (winPool + seedWin) * total)`，余数销毁。
   - 写 `bets.status`、`bets.payout`、`users.chips`、`ledger`、`season_stats`。
8. 结算后 `PRAGMA optimize`，写 `audit`。

Cron 另设每月 1 日 00:10（Asia/Shanghai）执行归档：见第 11 节。

## 10. 本地优先与缓存

前端 `localStorage` 键（前缀 `whale:v1:`）：

| 键 | 内容 | TTL |
| -- | ---- | --- |
| `prefs` | 滑块位置、默认金额、主题、上次市场 | 永久 |
| `draft:bet` | 未提交的市场/方向/金额/信心 | 永久 |
| `cache:config` | 公开配置 | 10 分钟 |
| `cache:markets` | 市场列表 + 时间戳 | 60 秒 |
| `cache:leaderboard` | 排行榜快照 | 60 秒 |
| `cache:me` | 本人快照，仅 UI 加速 | 30 秒 |
| `seen:version` | 已读公告版本 | 永久 |

规则：

- 先渲染缓存，再后台刷新；网络失败不清缓存，显示「离线数据」。
- 服务端返回的 `chips` 永远覆盖本地 `cache:me`。
- 下注成功后立即写回 `cache:me` 与 `draft:bet` 清空。
- 本地存储不得用于余额、持仓、结算的权威判定。

## 11. 存储保留策略

- `bets`：只保留最近 `retain_bet_seasons` 个赛季的明细；更早的聚合进 `season_stats` 后删除。
- `ledger`：删除 `created_at < now - retain_ledger_days`。
- `audit`：删除 `created_at < now - retain_audit_days`。
- `season_stats`、`users`、`markets`：永久。
- `POST /admin/maintenance` 手动触发同一逻辑，返回删除行数。
- 目标：单赛季百万级下注时 D1 仍 < 1 GB。

## 12. 安全与幂等

- 所有用户接口从 JWT `(iss, sub)` 取身份，绝不信任 body 的 `user_id`。
- `POST /bets` 以 `(user_key, client_request_id)` 唯一约束保证幂等。
- 扣款、加池、派奖必须在同一 D1 batch/事务内。
- 管理 token 常量时间比较；失败返回 401，不回显 token。
- CORS 只允许 `ALLOWED_ORIGINS`，错误响应也带 CORS 头。
- 日志中隐藏 `Authorization`、`mini_app_token`、`DEEPSEEK_API_KEY`。

## 13. 前端页面与交互

1. **市场页（首页）**：市场卡片列表、状态标签、预期回报、剩余时间、参与者数。
2. **市场详情**：滑块 −100（跌）~ +100（涨），小鲸鱼随强度进化（幼鲸 → 小鲸 → 鲸王 → 鲸祖），金额输入、预期回报、提交。
3. **排行榜**：总资产榜 / 准确率榜，赛季切换，本人高亮。
4. **我的**：鲸珠、每日领取、持仓、历史、排名。
5. **空态/离线/错误**：明确提示，不用 alert。
6. **嵌入尺寸**：适配 320–900px 宽，外层滚动，不固定 `100vh`。

视觉：深海蓝 + 荧光青，鲸鱼用内联 SVG 或 Canvas 绘制，不依赖远程素材。

## 14. 验收标准

- `server`：`bun test` 通过；覆盖结算（yes/no/void/退款/余数）、幂等下注、每日领取、JWT 拒绝、CORS。
- `app`：`bun run typecheck` 通过；`bun test` 通过；`bun run build` 产出 `dist/package/app.zip`。
- 手动：用 `wrangler dev` 起后端，前端连本地端点完成「领鲸珠 → 预测 → 管理端结算 → 排行榜变化」全流程。
