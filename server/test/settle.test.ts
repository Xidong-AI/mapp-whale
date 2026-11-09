// 结算引擎纯函数测试（契约第 9 节）：yes/no/void、赢方池为 0 退款、种子参与、余数销毁、多人按比例。
import { describe, expect, test } from 'bun:test';
import { computeSettlement, evaluateCondition, type BetLike, type ModelInfo } from '../src/settle';

const bet = (id: string, side: 'yes' | 'no', amount: number): BetLike => ({
  id,
  user_key: `u_${id}`,
  side,
  amount,
});

describe('computeSettlement', () => {
  test('yes 结算：按比例派奖，种子参与，余数销毁', () => {
    const bets = [bet('b1', 'yes', 300), bet('b2', 'yes', 100), bet('b3', 'no', 400)];
    // winPool=400, losePool=400, seedWin=0, seedLose=0 → total=800
    const r = computeSettlement('yes', bets, 0, 0);
    expect(r.outcome).toBe('yes');
    expect(r.payouts).toHaveLength(2);
    const b1 = r.payouts.find((p) => p.betId === 'b1')!;
    const b2 = r.payouts.find((p) => p.betId === 'b2')!;
    expect(b1.payout).toBe(Math.floor((300 / 400) * 800)); // 600
    expect(b2.payout).toBe(Math.floor((100 / 400) * 800)); // 200
    expect(r.destroyedRemainder).toBe(800 - 800);
    expect(r.loserBetIds).toEqual(['b3']);
  });

  test('余数销毁：除不尽时向下取整', () => {
    const bets = [bet('b1', 'yes', 333), bet('b2', 'no', 100)];
    // winPool=333, losePool=100, total=433 → 333/333*433 = 433
    const r = computeSettlement('yes', bets, 0, 0);
    expect(r.payouts[0]!.payout).toBe(433);
    expect(r.destroyedRemainder).toBe(0);
  });

  test('种子参与派奖分母', () => {
    const bets = [bet('b1', 'yes', 100), bet('b2', 'no', 100)];
    // winPool=100, seedWin=100, losePool=100, seedLose=100 → total=400
    const r = computeSettlement('yes', bets, 100, 100);
    expect(r.payouts[0]!.payout).toBe(Math.floor((100 / (100 + 100)) * 400)); // 200
    expect(r.outcome).toBe('yes');
  });

  test('no 结算：no 方为赢方', () => {
    const bets = [bet('b1', 'yes', 100), bet('b2', 'no', 100)];
    const r = computeSettlement('no', bets, 0, 0);
    expect(r.outcome).toBe('no');
    expect(r.payouts[0]!.betId).toBe('b2');
    expect(r.loserBetIds).toEqual(['b1']);
  });

  test('赢方池为 0：全员退款（void）', () => {
    // outcome 为 yes，但所有用户都投了 no：赢方用户池为 0，全员退款。
    const bets = [bet('b1', 'no', 100), bet('b2', 'no', 50)];
    const r = computeSettlement('yes', bets, 500, 0);
    expect(r.outcome).toBe('void');
    expect(r.payouts).toHaveLength(0);
    expect(r.refunds.map((x) => x.payout).sort((a, b) => a - b)).toEqual([50, 100]);
    expect(r.loserBetIds).toHaveLength(0);
    expect(r.destroyedRemainder).toBe(0);
  });

  test('显式 void：全员退款', () => {
    const bets = [bet('b1', 'yes', 100), bet('b2', 'no', 40)];
    const r = computeSettlement('void', bets, 500, 500);
    expect(r.outcome).toBe('void');
    expect(r.refunds).toHaveLength(2);
    expect(r.payouts).toHaveLength(0);
  });

  test('多人按比例：余数归属销毁', () => {
    const bets = [bet('b1', 'yes', 1), bet('b2', 'yes', 1), bet('b3', 'yes', 1), bet('b4', 'no', 5)];
    // winPool=3, losePool=5, total=8 → 每人 floor(8/3)=2，共 6，销毁 2
    const r = computeSettlement('yes', bets, 0, 0);
    expect(r.payouts.map((p) => p.payout)).toEqual([2, 2, 2]);
    expect(r.destroyedRemainder).toBe(2);
  });

  test('空注单：不崩溃', () => {
    const r = computeSettlement('yes', [], 0, 0);
    expect(r.outcome).toBe('void');
    expect(r.refunds).toHaveLength(0);
  });
});

describe('evaluateCondition', () => {
  const models: ModelInfo[] = [
    { name: 'deepseek-chat' },
    { name: 'DeepSeek-V5-Preview', context_window: 2097152, max_output_tokens: 65536 },
  ];

  test('name_regex 命中', () => {
    expect(evaluateCondition({ kind: 'name_regex', regex: 'DeepSeek[- ]?V5', flags: 'i' }, models)).toBe(true);
    expect(evaluateCondition({ kind: 'name_regex', regex: 'DeepSeek[- ]?V9', flags: 'i' }, models)).toBe(false);
  });

  test('field_threshold：先找目标模型再比较字段', () => {
    expect(
      evaluateCondition(
        { kind: 'field_threshold', targetNameRegex: 'DeepSeek[- ]?V5', field: 'context_window', op: '>=', value: 2097152 },
        models,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { kind: 'field_threshold', targetNameRegex: 'DeepSeek[- ]?V5', field: 'max_output_tokens', op: '>', value: 100000 },
        models,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { kind: 'field_threshold', targetNameRegex: 'DeepSeek[- ]?V9', field: 'context_window', op: '>=', value: 1 },
        models,
      ),
    ).toBe(false);
  });

  test('非法正则不抛异常返回 false', () => {
    expect(evaluateCondition({ kind: 'name_regex', regex: '(', flags: '' }, models)).toBe(false);
  });
});
