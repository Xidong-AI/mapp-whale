# 预言鲸 · 市场定义（多结果市场）

线上数据在 D1 `whale`，本文记录当前 4 个市场及其 outcome 条件。所有截止均为北京时间。

## 1. `m_v5_when` V5 什么时候发布？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `never`
- 条件：`first_seen_between`，regex `DeepSeek[- ]?V5`，flags `i`
- 描述：北京时间 2028 年 12 月 31 日 23:59:59 前，预言鲸每 10 分钟查询一次 DeepSeek 官方模型列表。自本池创建后首次出现名称含 V5 的模型时，按其首次观测时间所在季度结算；名称匹配不区分大小写，连续两次查询都看到才确认。截止前未出现则“截止前未发布”胜。首次观测时间不等于模型真实首发日期。

| outcome | 标签 | 窗口 |
| ------- | ---- | ---- |
| `2026q4` | 2026 Q4 | 2026-10-01 ~ 2027-01-01 |
| `2027q1` | 2027 Q1 | 2027-01-01 ~ 2027-04-01 |
| `2027q2` | 2027 Q2 | 2027-04-01 ~ 2027-07-01 |
| `2027q3` | 2027 Q3 | 2027-07-01 ~ 2027-10-01 |
| `2027q4` | 2027 Q4 | 2027-10-01 ~ 2028-01-01 |
| `2028plus` | 2028 年内 | 2028-01-01 ~ 2028-12-31 23:59:59 |
| `never` | 截止前未发布 | fallback |

## 2. `m_v5_context` V5 的上下文窗口有多大？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `unknown`
- 条件：`field_range`，`targetNameRegex` `DeepSeek[- ]?V5`，`field` `context_window`，`selector` `first`
- 描述：北京时间 2028 年 12 月 31 日 23:59:59 前，DeepSeek 官方模型列表出现名称含 V5 的模型后，取列表中第一个 V5 模型的上下文窗口 token 数，按区间结算；名称匹配不区分大小写。区间含下限、不含上限；未出现或无此数值则“无法判定”胜。

| outcome | 标签 | 区间 |
| ------- | ---- | ---- |
| `lt-1m` | < 1M | `[null, 1048576)` |
| `1m-2m` | 1M – 2M | `[1048576, 2097152)` |
| `2m-4m` | 2M – 4M | `[2097152, 4194304)` |
| `ge-4m` | ≥ 4M | `[4194304, null)` |
| `unknown` | 无法判定 | fallback |

## 3. `m_v5_output` V5 的输出上限有多大？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `unknown`
- 条件：`field_range`，`field` `max_output_tokens`，`selector` `first`
- 描述：北京时间 2028 年 12 月 31 日 23:59:59 前，DeepSeek 官方模型列表出现名称含 V5 的模型后，取列表中第一个 V5 模型的单次输出上限 token 数，按区间结算；名称匹配不区分大小写。区间含下限、不含上限；未出现或无此数值则“无法判定”胜。

| outcome | 标签 | 区间 |
| ------- | ---- | ---- |
| `lt-128k` | < 128K | `[null, 131072)` |
| `128k-256k` | 128K – 256K | `[131072, 262144)` |
| `256k-500k` | 256K – 500K | `[262144, 512000)` |
| `ge-500k` | ≥ 500K | `[512000, null)` |
| `unknown` | 无法判定 | fallback |

## 4. `m_v4_1_pro_before_dec` DeepSeek V4.1 Pro 会在 12 月前发布吗？

- 截止：2026-12-01 00:00:00，时间戳 1796054400000
- 结算：`exclusive`，fallback `not-before-dec`
- 条件：`first_seen_between`，regex `DeepSeek[-_ ]?V4[.]1[-_ ]?Pro`，flags `i`，窗口 `[0, 1796054400000)`
- 判定：模型 name 需同时包含“V4.1”与“Pro”，不区分大小写，分隔符不限；现有 `DeepSeek-V4.1-Flash`、`DeepSeek-V4-Pro` 不算。边界严格：首次观测时间严格早于截止才算命中。

| outcome | 标签 | 条件 |
| ------- | ---- | ---- |
| `before-dec` | 12 月前发布 | `first_seen_between`，截止前首次观测到 V4.1 Pro |
| `not-before-dec` | 12 月前未发布 | fallback |

## 覆盖性校验

`server/test/market-coverage.test.ts` 对每个池做自动化覆盖校验：

- 恰好一个 `manual` outcome，且其 id 等于 `markets.fallback_outcome_id`。
- 日期窗口（`first_seen_between`）按 start 升序首尾相接（无缺口、无重叠），首档从市场创建时刻起，最后一档收口到市场截止时刻（不允许 `end = null`）。
- 数值区间（`field_range`）按 min 升序首尾相接，首档 `min = null`、最后一档 `max = null`。
- 其它条件形态会使测试失败，强制新增池时显式处理。

## 条件 DSL

```jsonc
// 时间窗口
{ "kind": "first_seen_between", "regex": "DeepSeek[- ]?V5", "flags": "i", "start": 1790784000000, "end": 1798732800000 }

// 数值区间
{ "kind": "field_range", "targetNameRegex": "DeepSeek[- ]?V5", "flags": "i", "field": "context_window", "min": 1048576, "max": 2097152, "selector": "first" }

// 模态数组
{ "kind": "field_includes", "targetNameRegex": "DeepSeek[- ]?V5", "flags": "i", "field": "input_modalities", "value": "image", "selector": "first" }
```

结算时按 `settle_mode` 选 outcome：

- `first_match`：按 `sort_order` 第一个命中。
- `exclusive`：恰好一个命中；多个命中 → `void` 退款；零命中且到截止 → fallback。
- `manual`：仅管理员结算。

## 重建

```sh
cd server
bunx wrangler d1 migrations apply whale --remote
```

或通过管理 API：

```sh
curl -X POST https://mapp-whale.pj568.eu.org/admin/markets \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "m_v5_context",
    "title": "V5 的上下文窗口有多大？",
    "description": "取 /models 中首个 name 匹配 V5 的模型，比较 context_window。",
    "deadline": 1861891199000,
    "settleMode": "exclusive",
    "fallbackOutcomeId": "unknown",
    "outcomes": [
      { "id": "lt-1m", "label": "< 1M", "seed": 1000, "condition": { "kind": "field_range", "targetNameRegex": "DeepSeek[- ]?V5", "flags": "i", "field": "context_window", "min": null, "max": 1048576, "selector": "first" } }
    ]
  }'
```

## 结算

- Cron 每 10 分钟拉取 `https://api.deepseek.com/models`。
- 连续 `poll_confirmations`（默认 2）次命中才视为有效。
- 每个 outcome 一个池；赢家按投入比例瓜分总池，系统种子参与分账，余数销毁。
- 预期回报随下注实时变化，最终以结算时池子为准。
