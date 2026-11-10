// 市场选项并集覆盖全域的自动化测试：每个池的日期窗口/数值区间必须首尾相接、
// 无缺口、无重叠，且恰好一个 manual fallback 等于 markets.fallback_outcome_id。
import { describe, expect, test } from 'bun:test';
import { parseCondition } from '../src/conditions';
import { makeEnv } from './helpers/env';

type MarketRow = {
  id: string;
  deadline: number;
  created_at: number;
  fallback_outcome_id: string | null;
};

type OutcomeRow = {
  id: string;
  market_id: string;
  label: string;
  condition_json: string;
  sort_order: number;
};

const { db } = makeEnv();

const markets = (
  await db
    .prepare('SELECT id, deadline, created_at, fallback_outcome_id FROM markets ORDER BY id')
    .all<MarketRow>()
).results;
const outcomes = (
  await db
    .prepare('SELECT id, market_id, label, condition_json, sort_order FROM outcomes')
    .all<OutcomeRow>()
).results;

describe('市场选项并集覆盖全域', () => {
  test('存在市场与 outcome 数据', () => {
    expect(markets.length).toBeGreaterThan(0);
    expect(outcomes.length).toBeGreaterThan(0);
  });

  for (const market of markets) {
    describe(`market ${market.id}`, () => {
      const rows = outcomes.filter((o) => o.market_id === market.id);

      test('至少有一个 outcome', () => {
        expect(rows.length).toBeGreaterThan(0);
      });

      test('label 非空且 sort_order 在本市场内唯一', () => {
        const seen = new Set<number>();
        for (const o of rows) {
          expect(o.label.length).toBeGreaterThan(0);
          expect(seen.has(o.sort_order)).toBe(false);
          seen.add(o.sort_order);
        }
      });

      test('恰好一个 manual outcome，且 id 等于 fallback_outcome_id', () => {
        const manual = rows.filter((o) => parseCondition(JSON.parse(o.condition_json)).kind === 'manual');
        expect(manual.length).toBe(1);
        const fallbackId = market.fallback_outcome_id;
        expect(fallbackId).not.toBeNull();
        expect(manual[0]!.id).toBe(fallbackId!);
      });

      test('非 manual 条件同形态同参且首尾相接、无缺口、无重叠', () => {
        const conditions = rows
          .filter((o) => o.id !== market.fallback_outcome_id)
          .map((o) => ({ outcomeId: o.id, condition: parseCondition(JSON.parse(o.condition_json)) }));

        expect(conditions.length).toBeGreaterThan(0);

        const kinds = new Set(conditions.map((c) => c.condition.kind));
        expect(kinds.size).toBe(1);
        const kind = conditions[0]!.condition.kind;

        if (kind === 'first_seen_between') {
          const all = conditions.map((c) => c.condition as Extract<typeof c.condition, { kind: 'first_seen_between' }>);
          const regexes = new Set(all.map((c) => c.regex));
          expect(regexes.size).toBe(1);
          const flagss = new Set(all.map((c) => c.flags ?? ''));
          expect(flagss.size).toBe(1);

          const sorted = [...all].sort((a, b) => a.start - b.start);
          // 首档从市场创建时刻起覆盖。
          expect(sorted[0]!.start).toBeLessThanOrEqual(market.created_at);
          // 相邻窗口首尾相接（半开区间 [start, end)）。
          for (let i = 0; i < sorted.length - 1; i++) {
            expect(sorted[i]!.end).not.toBeNull();
            expect(sorted[i]!.end).toBe(sorted[i + 1]!.start);
          }
          // 最后一档必须收口到市场截止时刻，不允许 null。
          const last = sorted[sorted.length - 1]!;
          expect(last.end).not.toBeNull();
          expect(last.end).toBe(market.deadline);
        } else if (kind === 'field_range') {
          const all = conditions.map((c) => c.condition as Extract<typeof c.condition, { kind: 'field_range' }>);
          const regexes = new Set(all.map((c) => c.targetNameRegex));
          expect(regexes.size).toBe(1);
          const flagss = new Set(all.map((c) => c.flags ?? ''));
          expect(flagss.size).toBe(1);
          const fields = new Set(all.map((c) => c.field));
          expect(fields.size).toBe(1);

          const sorted = [...all].sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
          // 首档下界为 null（无下限）。
          expect(sorted[0]!.min).toBeNull();
          // 相邻区间首尾相接（[min, max)）。
          for (let i = 0; i < sorted.length - 1; i++) {
            expect(sorted[i]!.max).not.toBeNull();
            expect(sorted[i]!.max).toBe(sorted[i + 1]!.min);
          }
          // 最后一档上界为 null（无上限）。
          const last = sorted[sorted.length - 1]!;
          expect(last.max).toBeNull();
        } else {
          // 其它条件形态必须在此显式处理，防止新增池悄悄绕过覆盖校验。
          throw new Error(
            `market ${market.id} 使用未处理的条件 kind：${kind}；` +
              `outcomes：${conditions.map((c) => `${c.outcomeId}(${c.condition.kind})`).join(', ')}`,
          );
        }
      });
    });
  }

  test('V4.1 Pro 二元池 m_v4_1_pro_before_dec 存在且结构正确', () => {
    const market = markets.find((m) => m.id === 'm_v4_1_pro_before_dec');
    expect(market).toBeDefined();
    expect(market!.fallback_outcome_id).toBe('not-before-dec');

    const rows = outcomes.filter((o) => o.market_id === 'm_v4_1_pro_before_dec');
    expect(rows.length).toBe(2);
    const ids = rows.map((o) => o.id).sort();
    expect(ids).toEqual(['before-dec', 'not-before-dec']);
  });
});
