# 预言鲸 · 技术契约 v2（多结果市场）

本文件替代 v1 的二元市场契约。前端 `app/` 与后端 `server/` 以此为准。

## 1. 目标

- Linux.do 微应用，虚拟鲸珠预测市场。
- 一个市场有多个 outcome（结果），每个 outcome 独立彩池。
- 每个 outcome 的判定条件、范围、验证方式可配置；使用声明式条件 DSL，不执行任意用户脚本。
- V5 发布时间按季度分档；上下文、输出各一个多结果市场。
- 滑块“信念强度”保留，仅作展示与排行榜参考，不影响彩池或赔率。

## 2. 数据模型（D1）

```sql
CREATE TABLE markets (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  deadline           INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open', -- open|locked|settling|settled|void
  settle_mode        TEXT NOT NULL DEFAULT 'exclusive', -- first_match|exclusive|manual
  fallback_outcome_id TEXT,
  winning_outcome_id TEXT,
  settled_at         INTEGER,
  settle_reason      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE outcomes (
  id             TEXT NOT NULL,
  market_id      TEXT NOT NULL,
  label          TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  pool           INTEGER NOT NULL DEFAULT 0,
  seed           INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (market_id, id)
);
CREATE INDEX idx_outcomes_market ON outcomes(market_id, sort_order);

CREATE TABLE bets (
  id                TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  market_id         TEXT NOT NULL,
  outcome_id        TEXT NOT NULL,
  user_key          TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  confidence        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open', -- open|won|lost|refunded
  payout            INTEGER NOT NULL DEFAULT 0,
  season            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (user_key, client_request_id)
);
```

`users`、`ledger`、`season_stats`、`config`、`audit` 沿用 v1，`ledger.market_id` 保留，新增 `ledger.outcome_id`。

## 3. 条件 DSL

每个 outcome 一个条件对象：

```jsonc
{ "kind": "always" }
{ "kind": "never" }
{ "kind": "name_regex", "regex": "DeepSeek[- ]?V5", "flags": "i" }
{ "kind": "first_seen_between", "regex": "DeepSeek[- ]?V5", "flags": "i", "start": 1798732800000, "end": 1814371200000 }
{ "kind": "field_range", "targetNameRegex": "DeepSeek[- ]?V5", "flags": "i", "field": "context_window", "min": 1048576, "max": 2097152, "selector": "first" }
{ "kind": "field_includes", "targetNameRegex": "DeepSeek[- ]?V5", "flags": "i", "field": "input_modalities", "value": "image", "selector": "first" }
{ "kind": "manual" }
{ "kind": "all", "of": [Condition, ...] }
{ "kind": "any", "of": [Condition, ...] }
```

语义：

- `first_seen_between`：`/models` 中任一 `name` 匹配，记录首次观测时间；`first_seen_at ∈ [start, end)` 为真。`end = null` 表示无上限。
- `field_range`：取 `selector` 选中的模型（`first` 按 API 顺序首个匹配；`max`/`min` 取字段最大/最小），字段值落在 `[min, max)` 为真。`min`/`max` 可为 `null`。
- `field_includes`：数组字段包含 `value`。
- `always`/`never`/`manual`：常量或人工。
- `all`/`any`：组合条件。

限制：不支持任意 JS/脚本执行；需要新算子时在 `settle.ts` 中添加并写测试。

## 4. 结算

Cron 每 10 分钟拉取 `/models`，对每个 open/locked 市场：

1. 对每个 outcome 求值，累计 `hit_count`、记录 `first_seen_at`。
2. 连续 `poll_confirmations`（默认 2）次命中视为有效命中。
3. 按 `settle_mode` 选赢家：
   - `first_match`：按 `sort_order` 第一个有效命中。
   - `exclusive`：恰好一个有效命中 → 该 outcome；多个命中 → `void`（退款）并写审计；零命中且已到截止 → `fallback_outcome_id`；无 fallback → `void`。
   - `manual`：仅管理员结算。
4. 结算事务：
   - 总池 `total = Σ(pool + seed)`。
   - 赢家用户池 `winPool`；赢家种子 `winSeed`。
   - `winPool = 0` → 全员退款（`void`）。
   - 否则每条赢家下注 `payout = floor(amount / (winPool + winSeed) * total)`，余数销毁。
   - 写 `bets.status/payout`、`users.chips`、`ledger`、`season_stats`、`markets.winning_outcome_id`。
5. 状态机：`open/locked → settling` 抢占，`settling → settled/void`；`settling` 超时幂等重试。

## 5. API

统一 `{ok,data}` / `{ok,error}`。

### 公开

`GET /public/markets?id=&status=&limit=&cursor=`

```jsonc
{
  "id": "m_v5_when",
  "title": "V5 什么时候发布？",
  "description": "首次出现在 /models 的季度。",
  "deadline": 1861891199000,
  "status": "open",
  "settleMode": "exclusive",
  "fallbackOutcomeId": "never",
  "winningOutcomeId": null,
  "totalPool": 8750,
  "participantCount": 0,
  "outcomes": [
    { "id": "2026q4", "label": "2026 Q4", "pool": 0, "seed": 1250, "implied": 0.143, "payout": 7.0 }
  ]
}
```

`implied = (pool + seed) / totalPool`；`payout = totalPool / (pool + seed)`；空池按 1.0。

`GET /public/leaderboard?type=assets|accuracy&season=&limit=` 沿用。

### 用户

- `GET /me`、`POST /me/claim`、`GET /me/history`、`GET /me/rank` 沿用。
- `GET /me/positions`：按 `market_id + outcome_id` 聚合。
- `POST /bets`：

```jsonc
{ "marketId": "m_v5_when", "outcomeId": "2026q4", "amount": 100, "confidence": 72, "clientRequestId": "uuid" }
```

`confidence` 仅记录，不影响池子。

### 管理

- `POST /admin/markets`：

```jsonc
{
  "id": "m_v5_when",
  "title": "V5 什么时候发布？",
  "description": "...",
  "deadline": 1861891199000,
  "settleMode": "exclusive",
  "fallbackOutcomeId": "never",
  "outcomes": [
    { "id": "2026q4", "label": "2026 Q4", "seed": 1250, "condition": { "kind": "first_seen_between", "regex": "DeepSeek[- ]?V5", "flags": "i", "start": 1790784000000, "end": 1798732800000 } }
  ]
}
```

- `PATCH /admin/markets/:id`：title/description/deadline/status；`condition` 仅在无下注时允许。
- `POST /admin/markets/:id/settle`：`{ "outcomeId": "..." }` 或 `{ "outcome": "void" }`。
- `GET /admin/stats`、`POST /admin/maintenance`、`GET /admin/audit` 沿用。

## 6. 市场定义

### V5 发布时间 `m_v5_when`

- 截止：北京时间 2028-12-31 23:59:59。
- 结算：`exclusive`，fallback `never`。
- outcomes：
  - `2026q4`：2026-10-01 ~ 2027-01-01
  - `2027q1`：2027-01-01 ~ 2027-04-01
  - `2027q2`：2027-04-01 ~ 2027-07-01
  - `2027q3`：2027-07-01 ~ 2027-10-01
  - `2027q4`：2027-10-01 ~ 2028-01-01
  - `2028plus`：2028-01-01 ~ 2028-12-31 23:59:59，标签「2028 年内（截止前）」
  - `never`：fallback，截止未出现，标签「截止前未发布」
- 条件统一 `first_seen_between`，`2028plus` 的 `end = 1861891199000`（收窄到池截止时刻），`never` 用 `manual`。

### V5 上下文 `m_v5_context`

- 截止：北京时间 2028-12-31 23:59:59。
- 结算：`exclusive`，fallback `unknown`。
- outcomes：
  - `<1m`：`field_range` max 1048576
  - `1m-2m`：1048576 ~ 2097152
  - `2m-4m`：2097152 ~ 4194304
  - `>=4m`：min 4194304
  - `unknown`：fallback
- `field_range` 的 `selector` 为 `first`，即 `/models` 中首个 name 匹配 V5 的模型。

### V5 输出 `m_v5_output`

- 截止：北京时间 2028-12-31 23:59:59。
- 结算：`exclusive`，fallback `unknown`。
- outcomes：
  - `<128k`：max 131072
  - `128k-256k`：131072 ~ 262144
  - `256k-500k`：262144 ~ 512000
  - `>=500k`：min 512000
  - `unknown`：fallback

### DeepSeek V4.1 Pro 12 月前发布 `m_v4_1_pro_before_dec`

- 截止：北京时间 2026-12-01 00:00:00（1796054400000）。
- 结算：`exclusive`，fallback `not-before-dec`。
- outcomes：
  - `before-dec`：标签「12 月前发布」，条件 `first_seen_between`，regex `DeepSeek[-_ ]?V4[.]1[-_ ]?Pro`，flags `i`，窗口 `[0, 1796054400000)`。name 需同时包含「V4.1」与「Pro」（现有 `DeepSeek-V4.1-Flash`、`DeepSeek-V4-Pro` 不算）；首次观测时间严格早于截止才命中。
  - `not-before-dec`：标签「12 月前未发布」，fallback（`manual`，截止仍未出现时结算）。

## 7. 前端

- 市场卡片：显示 title、deadline、前 3 个 outcome 的 label + implied%，更多折叠。
- 详情：outcome 单选列表（label、payout、implied）、金额输入、信心滑块（仅展示）、提交。
- 结算后：高亮 winning outcome；`void` 显示退款。
- 持仓/历史：按 outcome 显示。
- 文案避开“下注/赔率/赌博”，用“预测/投入/彩池/预期回报/结算”。

## 7.1 嵌入卡片启动参数

应用支持以只读卡片模式嵌入论坛帖子：

```html
<iframe src="https://linux.do/apps/<appId>?embed_mode=true&card=1&market=<marketId>" width="100%" height="340" frameborder="0" allow="clipboard-write" loading="lazy"></iframe>
```

启动参数（由 SDK `launch.getParameters()` 透传，需要 `launch.read` 权限；应用内同时兼容 `location.search`，本地 dev 无 SDK 时可用）：

| 参数         | 语义                                                         |
| ------------ | ------------------------------------------------------------ |
| `embed_mode` | 任意非空值即进入嵌入模式                                     |
| `card`       | 任意非空值即渲染卡片视图                                     |
| `market`     | 目标市场 ID，取第一个值；空串视为缺失                        |

行为约定：

- 三者任一存在即进入卡片模式；卡片模式只读展示单个市场的当前分布条形图，不加载用户态、配置与 tabs 路由。
- `market` 缺失、为空串、超过 128 字符或含 `[A-Za-z0-9_.-]` 之外字符时按缺失处理，渲染空态。
- 请求失败或市场返回 0 条时渲染错误态（带重试）或空态；不弹 toast、不写缓存。
- 无新增 HTTP 端点：卡片复用 `GET /public/markets?id=<marketId>`。
- 高度随结果数自适应（`340–640px`），嵌入方也可固定高度。

## 8. 迁移

- 生产当前 0 笔下注，可直接重建。
- `0003_outcomes.sql`：创建 `outcomes`，重建 `markets`/`bets`，新增 `ledger.outcome_id`。
- `0004_seed_markets.sql`：插入三个多结果市场及 outcomes。
- 旧的 8 个二元市场不再保留。

## 9. 验收

- `bun run typecheck`、`bun test` 全绿。
- 覆盖：多 outcome 结算、exclusive 多命中 void、fallback、first_seen_between、field_range、并发幂等、沙箱只读。
- `wrangler d1 migrations apply whale --local` 成功。
- 前端 `typecheck`、`test`、`build` 通过。
- 市场 API 返回 outcomes 数组，下注按 outcome 记账。
