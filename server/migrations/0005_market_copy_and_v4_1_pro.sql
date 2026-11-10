-- 2026-11-10：面向非程序员的池描述；V5 最后一档收窄到截止时刻；新增 V4.1 Pro 12 月前发布池。
-- 线上当前 0 名参与者，改描述/标签/窗口上界不影响已有注单。

UPDATE markets SET description = '截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models），以列表中每个模型的名称（name 字段）为准。从本池创建后第一次看到名称包含「V5」的模型起算（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），看它第一次出现的时间落在哪个季度；例如 2026 Q4 指北京时间 2026-10-01 00:00 至 2027-01-01 00:00。为避免接口抖动，连续两次检查都看到才会确认已出现。若到截止时仍未出现，选「截止前未发布」。注意：这里看的是预言鲸第一次观测到的时间，不是模型的真实首发日期。' WHERE id = 'm_v5_when';

UPDATE markets SET description = '截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models）。如果列表里出现了名称包含「V5」的模型（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），就取列表中排在最前面的那个 V5 系列模型，读取它的上下文窗口数值（context_window，单位是 token），看落在哪个区间。区间含下限、不含上限；例如 1M – 2M 指 1,048,576 至 2,097,151 个 token。若到截止时仍没有 V5，或该模型没有提供这个数值，选「无法判定」。' WHERE id = 'm_v5_context';

UPDATE markets SET description = '截止时间为北京时间 2028 年 12 月 31 日 23:59:59。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models）。如果列表里出现了名称包含「V5」的模型（不区分大小写，V5、v5、DeepSeek-V5、DeepSeek-V5.1 都算），就取列表中排在最前面的那个 V5 系列模型，读取它的单次输出上限数值（max_output_tokens，单位是 token），看落在哪个区间。区间含下限、不含上限；例如 128K – 256K 指 131,072 至 262,143 个 token。若到截止时仍没有 V5，或该模型没有提供这个数值，选「无法判定」。' WHERE id = 'm_v5_output';

UPDATE outcomes SET label = '截止前未发布' WHERE market_id = 'm_v5_when' AND id = 'never';

UPDATE outcomes SET label = '2028 年内（截止前）', condition_json = '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1830268800000,"end":1861891199000}' WHERE market_id = 'm_v5_when' AND id = '2028plus';

INSERT OR IGNORE INTO markets
  (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at)
VALUES
  ('m_v4_1_pro_before_dec', 'DeepSeek V4.1 Pro 会在 12 月前发布吗？', '截止时间为北京时间 2026 年 12 月 1 日 00:00:00，严格早于这个时刻才算「12 月前发布」。预言鲸大约每 10 分钟查看一次 DeepSeek 官方公开的模型列表（https://api.deepseek.com/models），以列表中每个模型的名称（name 字段）为准。从本池创建后第一次看到名称同时包含「V4.1」和「Pro」的模型起算（不区分大小写，DeepSeek-V4.1-Pro、DeepSeek V4.1 Pro、deepseek-v4.1pro 都算；现有的 DeepSeek-V4.1-Flash、DeepSeek-V4-Pro 不算），选「12 月前发布」。为避免接口抖动，连续两次检查都看到才会确认已出现。若到 2026-12-01 00:00:00 仍未出现，选「12 月前未发布」。注意：这里看的是预言鲸第一次观测到的时间，不是模型的真实首发日期；本池只回答 12 月前是否出现，不代表之后不会发布。', 1796054400000, 'open', 'exclusive', 'not-before-dec', NULL, NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) VALUES
  ('before-dec', 'm_v4_1_pro_before_dec', '12 月前发布', '{"kind":"first_seen_between","regex":"DeepSeek[-_ ]?V4[.]1[-_ ]?Pro","flags":"i","start":0,"end":1796054400000}', 0, 1250, 0, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('not-before-dec', 'm_v4_1_pro_before_dec', '12 月前未发布', '{"kind":"manual"}', 0, 1250, 1, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
