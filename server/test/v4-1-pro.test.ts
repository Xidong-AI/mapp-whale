// V4.1 Pro 二元池与 V5 发布时间池 2028plus 收窄的行为验证。
//
// 注意：first_seen_between 的正则匹配发生在结算路径 updateOutcomeHits
// 记录 first_seen_at 的环节；evaluateCondition 只校验时间窗。
// 因此名字命中与时间边界均通过 updateOutcomeHits（生产语义）验证。
import { describe, expect, test } from 'bun:test';
import { evaluateCondition, parseCondition } from '../src/conditions';
import { updateOutcomeHits } from '../src/settle';
import type { ModelRow } from '../src/conditions';
import { makeEnv } from './helpers/env';

const { env, db } = makeEnv();

// 北京时间 2026-12-01 00:00:00 = 1796054400000。
const DEC_FIRST_MS = 1796054400000;
const MARKET_ID = 'm_v4_1_pro_before_dec';

const model = (name: string): ModelRow => ({ id: `m_${name}`, name });

type Row = { condition_json: string; label: string };
type HitRow = { id: string; condition_json: string; hit_count: number; first_seen_at: number | null };

function outcomeRow(marketId: string, outcomeId: string): Row {
  const row = db
    .prepare('SELECT condition_json, label FROM outcomes WHERE market_id = ? AND id = ?')
    .bind(marketId, outcomeId)
    .first<Row>();
  expect(row).not.toBeNull();
  return row!;
}

/** 两轮连续观测（poll_confirmations=2）后 before-dec 是否有效命中；每轮从 DB 读最新状态。 */
async function hitAfterTwoPolls(modelName: string, now: number): Promise<boolean> {
  const models = [model(modelName)];
  // 重置观测状态，避免跨测试污染（模拟全新观测历史）。
  await db
    .prepare("UPDATE outcomes SET hit_count = 0, first_seen_at = NULL WHERE market_id = ? AND id = 'before-dec'")
    .bind(MARKET_ID)
    .run();
  const readRows = async (): Promise<HitRow[]> =>
    (
      await db
        .prepare('SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = ? ORDER BY sort_order')
        .bind(MARKET_ID)
        .all<HitRow>()
    ).results;
  await updateOutcomeHits(env, MARKET_ID, await readRows(), models, 2, now);
  const hits = await updateOutcomeHits(env, MARKET_ID, await readRows(), models, 2, now);
  return hits.includes('before-dec');
}

describe('m_v4_1_pro_before_dec', () => {
  const cond = parseCondition(JSON.parse(outcomeRow(MARKET_ID, 'before-dec').condition_json));

  test('条件结构：first_seen_between，窗口 [0, 截止)，regex 含 V4.1 与 Pro', () => {
    expect(cond.kind).toBe('first_seen_between');
    if (cond.kind !== 'first_seen_between') return;
    expect(cond.start).toBe(0);
    expect(cond.end).toBe(DEC_FIRST_MS);
    expect(cond.flags).toBe('i');
    const re = new RegExp(cond.regex, cond.flags ?? '');
    expect(re.test('DeepSeek-V4.1-Pro')).toBe(true);
    expect(re.test('DeepSeek-V4.1-Flash')).toBe(false);
    expect(re.test('DeepSeek-V4-Pro')).toBe(false);
  });

  test('V4.1 Pro 命中（连续两轮观测）', async () => {
    for (const name of ['DeepSeek-V4.1-Pro', 'deepseek v4.1 pro', 'DeepSeek-V4.1Pro', 'DeepSeek-V4.1_Pro']) {
      expect(await hitAfterTwoPolls(name, DEC_FIRST_MS - 1)).toBe(true);
    }
  });

  test('现有模型与其它版本不命中', async () => {
    for (const name of ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4.1', 'DeepSeek-V5']) {
      expect(await hitAfterTwoPolls(name, DEC_FIRST_MS - 1)).toBe(false);
    }
  });

  test('边界严格：严格早于截止命中，截止及以后不命中', async () => {
    expect(await hitAfterTwoPolls('DeepSeek-V4.1-Pro', DEC_FIRST_MS - 1)).toBe(true);
    expect(await hitAfterTwoPolls('DeepSeek-V4.1-Pro', DEC_FIRST_MS)).toBe(false);
    expect(await hitAfterTwoPolls('DeepSeek-V4.1-Pro', DEC_FIRST_MS + 1)).toBe(false);
  });

  test('firstSeenAt 为 null 时不命中（evaluateCondition 语义）', () => {
    expect(evaluateCondition(cond, { models: [model('DeepSeek-V4.1-Pro')], firstSeenAt: null })).toBe(false);
    expect(evaluateCondition(cond, { models: [model('DeepSeek-V4.1-Pro')] })).toBe(false);
  });

  test('not-before-dec 是 manual，任何输入都不命中', () => {
    const fallback = parseCondition(JSON.parse(outcomeRow(MARKET_ID, 'not-before-dec').condition_json));
    expect(fallback.kind).toBe('manual');
    expect(evaluateCondition(fallback, { models: [model('DeepSeek-V4.1-Pro')], firstSeenAt: DEC_FIRST_MS - 1 })).toBe(false);
    expect(evaluateCondition(fallback, { models: [], firstSeenAt: null })).toBe(false);
  });
});

describe('m_v5_when 2028plus 收窄', () => {
  test('end 收窄到池截止时刻 1861891199000，标签为「2028 年内（截止前）」', () => {
    const row = outcomeRow('m_v5_when', '2028plus');
    const cond = parseCondition(JSON.parse(row.condition_json));
    expect(cond.kind).toBe('first_seen_between');
    if (cond.kind !== 'first_seen_between') return;
    expect(cond.start).toBe(1830268800000);
    expect(cond.end).toBe(1861891199000);
    expect(row.label).toBe('2028 年内（截止前）');
  });
});
