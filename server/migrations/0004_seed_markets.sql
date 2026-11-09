-- 首批多结果市场。截止统一为北京时间 2028-12-31 23:59:59。
INSERT OR REPLACE INTO markets
  (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at)
VALUES
  ('m_v5_when', 'V5 什么时候发布？', '以官方 /models 的 name 字段为准，首次出现时间落在哪个季度；截止前未出现则「未发布」胜。', 1861891199000, 'open', 'exclusive', 'never', NULL, NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('m_v5_context', 'V5 的上下文窗口有多大？', '取 /models 中首个 name 匹配 /DeepSeek[- ]?V5/i 的模型，比较 context_window。', 1861891199000, 'open', 'exclusive', 'unknown', NULL, NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('m_v5_output', 'V5 的输出上限有多大？', '取 /models 中首个 name 匹配 /DeepSeek[- ]?V5/i 的模型，比较 max_output_tokens。', 1861891199000, 'open', 'exclusive', 'unknown', NULL, NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

INSERT OR REPLACE INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) VALUES
  ('2026q4', 'm_v5_when', '2026 Q4', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1790784000000,"end":1798732800000}', 0, 1250, 0, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2027q1', 'm_v5_when', '2027 Q1', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1798732800000,"end":1806508800000}', 0, 1250, 1, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2027q2', 'm_v5_when', '2027 Q2', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1806508800000,"end":1814371200000}', 0, 1250, 2, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2027q3', 'm_v5_when', '2027 Q3', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1814371200000,"end":1822320000000}', 0, 1250, 3, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2027q4', 'm_v5_when', '2027 Q4', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1822320000000,"end":1830268800000}', 0, 1250, 4, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2028plus', 'm_v5_when', '2028 及以后', '{"kind":"first_seen_between","regex":"DeepSeek[- ]?V5","flags":"i","start":1830268800000,"end":null}', 0, 1250, 5, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('never', 'm_v5_when', '未发布', '{"kind":"manual"}', 0, 1250, 6, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('lt-1m', 'm_v5_context', '< 1M', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"context_window","min":null,"max":1048576,"selector":"first"}', 0, 1000, 0, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('1m-2m', 'm_v5_context', '1M – 2M', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"context_window","min":1048576,"max":2097152,"selector":"first"}', 0, 1000, 1, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('2m-4m', 'm_v5_context', '2M – 4M', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"context_window","min":2097152,"max":4194304,"selector":"first"}', 0, 1000, 2, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('ge-4m', 'm_v5_context', '≥ 4M', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"context_window","min":4194304,"max":null,"selector":"first"}', 0, 1000, 3, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('unknown_ctx', 'm_v5_context', '无法判定', '{"kind":"manual"}', 0, 1000, 4, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),

  ('lt-128k', 'm_v5_output', '< 128K', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"max_output_tokens","min":null,"max":131072,"selector":"first"}', 0, 1000, 0, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('128k-256k', 'm_v5_output', '128K – 256K', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"max_output_tokens","min":131072,"max":262144,"selector":"first"}', 0, 1000, 1, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('256k-500k', 'm_v5_output', '256K – 500K', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"max_output_tokens","min":262144,"max":512000,"selector":"first"}', 0, 1000, 2, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('ge-500k', 'm_v5_output', '≥ 500K', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"max_output_tokens","min":512000,"max":null,"selector":"first"}', 0, 1000, 3, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('unknown_out', 'm_v5_output', '无法判定', '{"kind":"manual"}', 0, 1000, 4, 0, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
