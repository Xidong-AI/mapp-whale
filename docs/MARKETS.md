# 预言鲸 · 市场定义（多结果市场）

线上数据在 D1 `whale`，本文记录当前 3 个市场及其 outcome 条件。所有截止均为北京时间。

## 1. `m_v5_when` V5 什么时候发布？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `never`
- 条件：`first_seen_between`，regex `DeepSeek[- ]?V5`，flags `i`

| outcome | 标签 | 窗口 |
| ------- | ---- | ---- |
| `2026q4` | 2026 Q4 | 2026-10-01 ~ 2027-01-01 |
| `2027q1` | 2027 Q1 | 2027-01-01 ~ 2027-04-01 |
| `2027q2` | 2027 Q2 | 2027-04-01 ~ 2027-07-01 |
| `2027q3` | 2027 Q3 | 2027-07-01 ~ 2027-10-01 |
| `2027q4` | 2027 Q4 | 2027-10-01 ~ 2028-01-01 |
| `2028plus` | 2028 及以后 | 2028-01-01 起，无上限 |
| `never` | 未发布 | fallback |

## 2. `m_v5_context` V5 的上下文窗口有多大？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `unknown`
- 条件：`field_range`，`targetNameRegex` `DeepSeek[- ]?V5`，`field` `context_window`，`selector` `first`

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

| outcome | 标签 | 区间 |
| ------- | ---- | ---- |
| `lt-128k` | < 128K | `[null, 131072)` |
| `128k-256k` | 128K – 256K | `[131072, 262144)` |
| `256k-500k` | 256K – 500K | `[262144, 512000)` |
| `ge-500k` | ≥ 500K | `[512000, null)` |
| `unknown` | 无法判定 | fallback |

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
