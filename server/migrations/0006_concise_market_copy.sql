-- 2026-11-10：精简池描述，统一中文引号，删去括号解释与举例。

UPDATE markets SET description = '北京时间 2028 年 12 月 31 日 23:59:59 前，预言鲸每 10 分钟查询一次 DeepSeek 官方模型列表。自本池创建后首次出现名称含 V5 的模型时，按其首次观测时间所在季度结算；名称匹配不区分大小写，连续两次查询都看到才确认。截止前未出现则“截止前未发布”胜。首次观测时间不等于模型真实首发日期。' WHERE id = 'm_v5_when';

UPDATE markets SET description = '北京时间 2028 年 12 月 31 日 23:59:59 前，DeepSeek 官方模型列表出现名称含 V5 的模型后，取列表中第一个 V5 模型的上下文窗口 token 数，按区间结算；名称匹配不区分大小写。区间含下限、不含上限；未出现或无此数值则“无法判定”胜。' WHERE id = 'm_v5_context';

UPDATE markets SET description = '北京时间 2028 年 12 月 31 日 23:59:59 前，DeepSeek 官方模型列表出现名称含 V5 的模型后，取列表中第一个 V5 模型的单次输出上限 token 数，按区间结算；名称匹配不区分大小写。区间含下限、不含上限；未出现或无此数值则“无法判定”胜。' WHERE id = 'm_v5_output';

UPDATE markets SET description = '北京时间 2026 年 12 月 1 日 00:00:00 前，预言鲸每 10 分钟查询 DeepSeek 官方模型列表。本池创建后首次出现名称同时含 V4.1 和 Pro 的模型时，“12 月前发布”胜；名称不区分大小写，连续两次查询都看到才确认。截止前未出现则“12 月前未发布”胜。首次观测时间不等于真实首发日期；本池只判定 12 月前是否出现。' WHERE id = 'm_v4_1_pro_before_dec';

UPDATE outcomes SET label = '2028 年内' WHERE market_id = 'm_v5_when' AND id = '2028plus';
