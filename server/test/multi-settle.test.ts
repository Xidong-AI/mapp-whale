// 多结果市场结算测试（契约第 4 节）：mode 选赢家、fallback、void、分账、余数销毁。
import { describe, expect, test } from 'bun:test';
import {
  chooseWinningOutcome,
  computeMultiSettlement,
  type BetInput,
  type OutcomeInput,
} from '../src/multi-settle';

const outcome = (id: string, pool: number, seed = 0, matched = false): OutcomeInput => ({
  id,
  pool,
  seed,
  matched,
});

const bet = (betId: string, outcomeId: string, amount: number, userKey?: string): BetInput => ({
  betId,
  userKey: userKey ?? `u_${betId}`,
  outcomeId,
  amount,
});

describe('chooseWinningOutcome: first_match', () => {
  test('按顺序第一个 matched', () => {
    const r = chooseWinningOutcome({
      mode: 'first_match',
      outcomes: [outcome('a', 100, 0, false), outcome('b', 100, 0, true), outcome('c', 0, 0, true)],
      deadlinePassed: false,
    });
    expect(r).toEqual({ outcomeId: 'b', void: false, reason: 'first_match' });
  });

  test('无命中且未截止 → 等待', () => {
    const r = chooseWinningOutcome({
      mode: 'first_match',
      outcomes: [outcome('a', 100), outcome('b', 100)],
      fallbackOutcomeId: 'b',
      deadlinePassed: false,
    });
    expect(r).toEqual({ outcomeId: null, void: false, reason: 'waiting' });
  });

  test('无命中已截止 → fallback', () => {
    const r = chooseWinningOutcome({
      mode: 'first_match',
      outcomes: [outcome('a', 100), outcome('b', 100)],
      fallbackOutcomeId: 'b',
      deadlinePassed: true,
    });
    expect(r).toEqual({ outcomeId: 'b', void: false, reason: 'fallback' });
  });

  test('无命中已截止且无 fallback → void', () => {
    const r = chooseWinningOutcome({
      mode: 'first_match',
      outcomes: [outcome('a', 100)],
      deadlinePassed: true,
    });
    expect(r).toEqual({ outcomeId: null, void: true, reason: 'no_fallback' });
  });

  test('fallback 不存在 → void', () => {
    const r = chooseWinningOutcome({
      mode: 'first_match',
      outcomes: [outcome('a', 100)],
      fallbackOutcomeId: 'ghost',
      deadlinePassed: true,
    });
    expect(r).toEqual({ outcomeId: null, void: true, reason: 'fallback_missing' });
  });
});

describe('chooseWinningOutcome: exclusive', () => {
  test('恰好一个 matched', () => {
    const r = chooseWinningOutcome({
      mode: 'exclusive',
      outcomes: [outcome('a', 100, 0, false), outcome('b', 0, 0, true)],
      deadlinePassed: false,
    });
    expect(r).toEqual({ outcomeId: 'b', void: false, reason: 'exclusive' });
  });

  test('多个 matched → void exclusive_conflict', () => {
    const r = chooseWinningOutcome({
      mode: 'exclusive',
      outcomes: [outcome('a', 100, 0, true), outcome('b', 0, 0, true)],
      deadlinePassed: false,
    });
    expect(r).toEqual({ outcomeId: null, void: true, reason: 'exclusive_conflict' });
  });

  test('零命中已截止 → fallback', () => {
    const r = chooseWinningOutcome({
      mode: 'exclusive',
      outcomes: [outcome('a', 100), outcome('b', 50)],
      fallbackOutcomeId: 'b',
      deadlinePassed: true,
    });
    expect(r).toEqual({ outcomeId: 'b', void: false, reason: 'fallback' });
  });

  test('零命中未截止 → 等待', () => {
    const r = chooseWinningOutcome({
      mode: 'exclusive',
      outcomes: [outcome('a', 100)],
      deadlinePassed: false,
    });
    expect(r).toEqual({ outcomeId: null, void: false, reason: 'waiting' });
  });
});

describe('chooseWinningOutcome: manual', () => {
  test('始终等待管理员，即使有命中', () => {
    const r = chooseWinningOutcome({
      mode: 'manual',
      outcomes: [outcome('a', 100, 0, true)],
      deadlinePassed: true,
    });
    expect(r).toEqual({ outcomeId: null, void: false, reason: 'waiting_admin' });
  });
});

describe('computeMultiSettlement', () => {
  test('多 outcome 分账：总池含 seed，按比例派奖', () => {
    const outcomes = [outcome('a', 300, 50), outcome('b', 100, 50)];
    const bets = [bet('b1', 'a', 200), bet('b2', 'a', 100), bet('b3', 'b', 100)];
    // total = 300+50+100+50 = 500；winPool = 300，winSeed = 50。
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.void).toBe(false);
    expect(r.winningOutcomeId).toBe('a');
    expect(r.totalPool).toBe(500);
    const p1 = r.payouts.find((p) => p.betId === 'b1')!;
    const p2 = r.payouts.find((p) => p.betId === 'b2')!;
    expect(p1.payout).toBe(Math.floor((200 / 350) * 500)); // 285
    expect(p2.payout).toBe(Math.floor((100 / 350) * 500)); // 142
    expect(r.refunds).toHaveLength(0);
    // 派出 285+142=427，余 73 销毁（payout 字段不体现，由调用方对账）。
  });

  test('余数向下取整：除不尽时销毁', () => {
    const outcomes = [outcome('a', 0), outcome('b', 1000)];
    const bets = [bet('b1', 'a', 333), bet('b2', 'b', 100)];
    // total = 1000；winPool = 333 → 333/333*1000 = 1000（恰好）。
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.payouts[0]!.payout).toBe(1000);
    expect(r.void).toBe(false);
  });

  test('余数销毁：多个赢家合计不足 total', () => {
    const outcomes = [outcome('a', 0), outcome('b', 1000)];
    const bets = [bet('b1', 'a', 1), bet('b2', 'a', 1), bet('b3', 'b', 100)];
    // total = 1000；winPool = 2 → 各 floor(1/2*1000) = 500，合计 1000。
    // 换 winPool=3 验证销毁：3 个赢家各 1。
    const bets2 = [bet('b1', 'a', 1), bet('b2', 'a', 1), bet('b3', 'a', 1)];
    const r = computeMultiSettlement({ outcomes, bets: bets2, winningOutcomeId: 'a' });
    // winPool=3 → 各 floor(1/3*1000) = 333，合计 999，销毁 1。
    expect(r.payouts.map((p) => p.payout)).toEqual([333, 333, 333]);
  });

  test('winningOutcomeId null → void 全额退款', () => {
    const outcomes = [outcome('a', 300, 50), outcome('b', 100, 50)];
    const bets = [bet('b1', 'a', 200), bet('b2', 'b', 100)];
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: null });
    expect(r.void).toBe(true);
    expect(r.winningOutcomeId).toBeNull();
    expect(r.totalPool).toBe(500);
    expect(r.payouts).toHaveLength(0);
    expect(r.refunds.map((x) => [x.betId, x.payout])).toEqual([
      ['b1', 200],
      ['b2', 100],
    ]);
  });

  test('winPool = 0 → void 全员退款（含 seed）', () => {
    const outcomes = [outcome('a', 0, 100), outcome('b', 500, 0)];
    const bets = [bet('b1', 'b', 200), bet('b2', 'b', 300)];
    // 赢家 outcome a 无用户下注，winPool = 0 → 全员退款。
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.void).toBe(true);
    expect(r.winningOutcomeId).toBe('a');
    expect(r.payouts).toHaveLength(0);
    expect(r.refunds.map((x) => x.payout).sort((x, y) => x - y)).toEqual([200, 300]);
  });

  test('赢家 amount 为 0 的下注 payout 为 0', () => {
    const outcomes = [outcome('a', 0), outcome('b', 100)];
    const bets = [bet('b1', 'a', 0), bet('b2', 'b', 100)];
    // winPool = 0 → void。
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.void).toBe(true);
  });

  test('非赢家无退款', () => {
    const outcomes = [outcome('a', 100), outcome('b', 100)];
    const bets = [bet('b1', 'a', 50), bet('b2', 'b', 100)];
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.refunds).toHaveLength(0);
    expect(r.payouts.map((p) => p.betId)).toEqual(['b1']);
  });

  test('赢家 seed 参与分母但不改变总池', () => {
    const outcomes = [outcome('a', 0, 100), outcome('b', 200, 0)];
    const bets = [bet('b1', 'a', 100)];
    // total = 300；winPool = 100，winSeed = 100 → floor(100/200*300) = 150。
    const r = computeMultiSettlement({ outcomes, bets, winningOutcomeId: 'a' });
    expect(r.payouts[0]!.payout).toBe(150);
  });
});
