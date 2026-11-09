# 预言鲸 · 市场定义

线上数据存在 D1 `whale` 的 `markets` 表，本文用于复现、审计和重建。管理操作走 `/admin/markets`，需要 `ADMIN_TOKEN`。

## 当前市场

| ID              | 标题                      | 判定条件                                                                 | 截止（北京时间）    | 状态   |
| --------------- | ------------------------- | ------------------------------------------------------------------------ | ------------------- | ------ |
| `m_v41pro_2026`   | V4.1 Pro 在 12 月前发布？ | `name` 匹配 `/DeepSeek[- ]?V4\.1[- ]?Pro/i`                                 | 2026-12-01 00:00    | open   |
| `m_v5_2026`       | V5 在 2026 年底前出现？   | `name` 匹配 `/DeepSeek[- ]?V5/i`                                            | 2026-12-31 23:59:59 | open   |
| `m_v41pro_1m`     | V4.1 Pro 上下文达到 1M？  | `name` 匹配 V4.1 Pro 的模型 `context_window >= 1048576`                      | 2027-03-31 23:59:59 | open   |
| `m_ctx_2m`        | V5 上下文达到 2M？        | `name` 匹配 V5 的模型 `context_window >= 2097152`                            | 2027-06-30 23:59:59 | open   |
| `m_ctx_4m`        | V5 上下文达到 4M？        | `name` 匹配 V5 的模型 `context_window >= 4194304`                            | 2027-06-30 23:59:59 | open   |
| `m_out_256k`      | V5 输出上限达到 256K？    | `name` 匹配 V5 的模型 `max_output_tokens >= 262144`                          | 2027-06-30 23:59:59 | open   |
| `m_out_500k`      | V5 输出上限达到 500K？    | `name` 匹配 V5 的模型 `max_output_tokens >= 512000`                          | 2027-06-30 23:59:59 | open   |
| `m_v5_2027h1`     | V5 在 2027 上半年出现？   | `name` 匹配 `/DeepSeek[- ]?V5/i`（当前与 `m_v5_2026` 重叠）                    | 2027-06-30 23:59:59 | locked |

## 条件 JSON

```jsonc
// name_regex
{ "kind": "name_regex", "regex": "DeepSeek[- ]?V5", "flags": "i" }

// field_threshold
{
  "kind": "field_threshold",
  "targetNameRegex": "DeepSeek[- ]?V5",
  "field": "context_window",
  "op": ">=",
  "value": 2097152
}
```

`name_regex` 匹配 `/models` 返回项的 `name` 字段，不匹配稳定别名 `id`。

## 已知重叠

`m_v5_2026` 和 `m_v5_2027h1` 都是“截止前 `name` 出现 V5”。如果 V5 在 2026 年发布：

- `m_v5_2026` 命中，结算为「是」；
- `m_v5_2027h1` 也会命中，同样结算为「是」。

这不是“后者失效”，而是两个池重复计奖。`m_v5_2027h1` 已先 `locked`，暂停下注。

正确做法是给长期池加首次出现时间窗口：

```jsonc
{
  "kind": "first_seen_between",
  "regex": "DeepSeek[- ]?V5",
  "flags": "i",
  "start": 1798732800000, // 2027-01-01 00:00 +08
  "end": 1814371200000   // 2027-07-01 00:00 +08
}
```

判定语义：

- 首次观测到匹配模型时写入 `first_seen_at`；
- `first_seen_at` 落在 `[start, end)` 内 → 「是」；
- `first_seen_at < start`（提前发布）→ 「否」；
- 截止时仍未出现 → 「否」。

这样 `m_v5_2026` 和 `m_v5_2027h1` 互斥，不会双赢。

## 重建方式

```sh
export BASE=https://mapp-whale.pj568.eu.org
export ADMIN_TOKEN=...

curl -X POST "$BASE/admin/markets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "m_ctx_4m",
    "title": "V5 的上下文窗口达到 4M？",
    "description": "北京时间 2027-06-30 23:59:59 前，官方 /models 中任一 name 匹配 /DeepSeek[- ]?V5/i 的模型，其 context_window 字段大于等于 4194304（4M）。后台连续两次轮询命中即结算为「是」；截止时未命中结算为「否」。",
    "condition": { "kind": "field_threshold", "targetNameRegex": "DeepSeek[- ]?V5", "field": "context_window", "op": ">=", "value": 4194304 },
    "deadline": 1814371199000,
    "seedYes": 5000,
    "seedNo": 5000
  }'
```

## 结算约定

- Cron 每 10 分钟拉取 `https://api.deepseek.com/models`。
- 连续 `poll_confirmations`（默认 2）次命中才结算为「是」。
- 截止时未命中结算为「否」。
- 彩池为 parimutuel：赢方按投入比例瓜分总池，系统种子参与分账，余数销毁。
- 预期回报随下注实时变化，最终以结算时池子为准。
