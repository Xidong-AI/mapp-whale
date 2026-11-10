# 预言鲸 · 市场定义（多结果市场）

线上数据在 D1 `whale`，本文记录当前 4 个市场及其 outcome 条件。所有截止均为北京时间。

## 1. `m_v5_when` V5 什么时候发布？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `never`
- 条件：`first_seen_between`，regex `DeepSeek[- ]?V5`，flags `i`
- 描述：截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models），以列表中每个模型的名称（name 字段）为准。从本池创建后第一次看到名称包含「V5」的模型起算（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），看它第一次出现的时间落在哪个季度；例如 2026 Q4 指北京时间 2026-10-01 00:00 至 2027-01-01 00:00。为避免接口抖动，连续两次检查都看到才会确认已出现。若到截止时仍未出现，选「截止前未发布」。注意：这里看的是预言鲸第一次观测到的时间，不是模型的真实首发日期。

| outcome | 标签 | 窗口 |
| ------- | ---- | ---- |
| `2026q4` | 2026 Q4 | 2026-10-01 ~ 2027-01-01 |
| `2027q1` | 2027 Q1 | 2027-01-01 ~ 2027-04-01 |
| `2027q2` | 2027 Q2 | 2027-04-01 ~ 2027-07-01 |
| `2027q3` | 2027 Q3 | 2027-07-01 ~ 2027-10-01 |
| `2027q4` | 2027 Q4 | 2027-10-01 ~ 2028-01-01 |
| `2028plus` | 2028 年内（截止前） | 2028-01-01 ~ 2028-12-31 23:59:59 |
| `never` | 截止前未发布 | fallback |

## 2. `m_v5_context` V5 的上下文窗口有多大？

- 截止：2028-12-31 23:59:59
- 结算：`exclusive`，fallback `unknown`
- 条件：`field_range`，`targetNameRegex` `DeepSeek[- ]?V5`，`field` `context_window`，`selector` `first`
- 描述：截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models）。如果列表里出现了名称包含「V5」的模型（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），就取列表中排在最前面的那个 V5 系列模型，读取它的上下文窗口数值（context_window，单位是 token），看落在哪个区间。区间含下限、不含上限；例如 1M – 2M 指 1,048,576 至 2,097,151 个 token。若到截止时仍没有 V5，或该模型没有提供这个数值，选「无法判定」。

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
- 描述：截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models）。如果列表里出现了名称包含「V5」的模型（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），就取列表中排在最前面的那个 V5 系列模型，读取它的单次输出上限数值（max_output_tokens，单位是 token），看落在哪个区间。区间含下限、不含上限；例如 128K – 256K 指 131,072 至 262,143 个 token。若到截止时仍没有 V5，或该模型没有提供这个数值，选「无法判定」。

| outcome | 标签 | 区间 |
| ------- | ---- | ---- |
| `lt-128k` | < 128K | `[null, 131072)` |
| `128k-256k` | 128K – 256K | `[131072, 262144)` |
| `256k-500k` | 256K – 500K | `[262144, 512000)` |
| `ge-500k` | ≥ 500K | `[512000, null)` |
| `unknown` | 无法判定 | fallback |

## 4. `m_v4_1_pro_before_dec` DeepSeek V4.1 Pro 会在 12 月前发布吗？

- 截止：2026-12-01 00:00:00（1796054400000）
- 结算：`exclusive`，fallback `not-before-dec`
- 条件：`first_seen_between`，regex `DeepSeek[-_ ]?V4[.]1[-_ ]?Pro`，flags `i`，窗口 `[0, 1796054400000)`
- 判定：模型 name 需同时包含「V4.1」与「Pro」（不区分大小写、分隔符不限）；现有 `DeepSeek-V4.1-Flash`、`DeepSeek-V4-Pro` 不算。边界严格：首次观测时间严格早于截止才算命中。

| outcome | 标签 | 条件 |
| ------- | ---- | ---- |
| `before-dec` | 12 月前发布 | `first_seen_between`，截止前首次观测到 V4.1 Pro |
| `not-before-dec` | 12 月前未发布 | fallback（`manual`，截止仍未出现时结算） |

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
