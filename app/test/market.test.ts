import { describe, expect, test } from "bun:test";
import {
  applyOutcomePools,
  betIntentKey,
  defaultOutcomeId,
  marketPoolTotal,
  outcomeById,
  outcomeProgress,
  outcomeShare,
  selectableOutcomes,
  sortMarkets,
  topOutcomes,
} from "../src/logic.ts";
import { deadlineView, marketStatus } from "../src/market-status.ts";
import type { Market, Outcome } from "../src/types.ts";

function outcome(seed: Partial<Outcome> & { id: string }): Outcome {
  return {
    label: seed.id.toUpperCase(),
    pool: 0,
    seed: 0,
    implied: 0,
    payout: 1,
    ...seed,
  };
}

function market(seed: Partial<Market> = {}): Market {
  return {
    id: "m1",
    title: "M1",
    description: "",
    deadline: 1_800_000_000_000,
    status: "open",
    settleMode: "exclusive",
    fallbackOutcomeId: null,
    winningOutcomeId: null,
    totalPool: 0,
    outcomes: [],
    settledAt: null,
    settleReason: null,
    ...seed,
  };
}

const v5 = market({
  id: "m_v5_when",
  fallbackOutcomeId: "never",
  totalPool: 6000,
  outcomes: [
    outcome({ id: "2026q4", pool: 3000, seed: 1000, implied: 0.67, payout: 1.5 }),
    outcome({ id: "2027q1", pool: 1000, seed: 500, implied: 0.25, payout: 4 }),
    outcome({ id: "never", pool: 0, seed: 500, implied: 0.08, payout: 12 }),
  ],
});

describe("outcome selection", () => {
  test("defaults to the first non-fallback outcome", () => {
    expect(defaultOutcomeId(v5)).toBe("2026q4");
    expect(defaultOutcomeId(market({ outcomes: [] }))).toBeNull();
  });

  test("selectable outcomes hide the fallback unless it is the only one", () => {
    expect(selectableOutcomes(v5).map((item) => item.id)).toEqual([
      "2026q4",
      "2027q1",
    ]);
    const onlyFallback = market({
      fallbackOutcomeId: "never",
      outcomes: [outcome({ id: "never" })],
    });
    expect(selectableOutcomes(onlyFallback).map((item) => item.id)).toEqual([
      "never",
    ]);
  });

  test("falls back to the first outcome when a fallback is listed first", () => {
    const fallbackFirst = market({
      fallbackOutcomeId: "never",
      outcomes: [outcome({ id: "never", implied: 0.9 }), outcome({ id: "q1", implied: 0.1 })],
    });
    expect(defaultOutcomeId(fallbackFirst)).toBe("q1");
  });

  test("looks outcomes up by id and ignores unknown ids", () => {
    expect(outcomeById(v5, "2027q1")?.label).toBe("2027Q1");
    expect(outcomeById(v5, "nope")).toBeNull();
    expect(outcomeById(v5, null)).toBeNull();
    expect(outcomeById(v5, "")).toBeNull();
  });

  test("ranks by implied probability for summaries", () => {
    expect(topOutcomes(v5, 2).map((item) => item.id)).toEqual([
      "2026q4",
      "2027q1",
    ]);
    expect(topOutcomes(v5).length).toBe(3);
  });
});

describe("outcome pools", () => {
  test("shares include seeds and sum to one", () => {
    const shares = v5.outcomes.map((item) => outcomeShare(v5, item));
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(outcomeShare(v5, v5.outcomes[0])).toBeCloseTo(4000 / 6000, 6);
  });

  test("empty pools split evenly instead of dividing by zero", () => {
    const empty = market({
      outcomes: [outcome({ id: "a" }), outcome({ id: "b" })],
    });
    expect(outcomeShare(empty, empty.outcomes[0])).toBeCloseTo(0.5, 6);
  });

  test("applying a bet reprices only the touched outcome and the total", () => {
    const updated = applyOutcomePools(v5, { "2027q1": 2000 });
    expect(updated.outcomes[0].pool).toBe(3000);
    expect(updated.outcomes[1].pool).toBe(2000);
    // total = 4000 + 2500 + 500 = 7000
    expect(updated.totalPool).toBe(7000);
    expect(updated.outcomes[1].implied).toBeCloseTo(2500 / 7000, 6);
    expect(updated.outcomes[1].payout).toBeCloseTo(2.8, 2);
    expect(updated.id).toBe("m_v5_when");
  });

  test("pool total prefers the server number and falls back to seeds", () => {
    expect(marketPoolTotal(v5)).toBe(6000);
    const noTotal = market({
      totalPool: 0,
      outcomes: [outcome({ id: "a", pool: 100, seed: 50 })],
    });
    expect(marketPoolTotal(noTotal)).toBe(150);
  });

  test("request keys bind the chosen outcome", () => {
    expect(betIntentKey("m1", "q1", 100, 50)).not.toBe(
      betIntentKey("m1", "q2", 100, 50)
    );
    expect(betIntentKey("m1", "q1", 100, 50)).toBe(
      betIntentKey("m1", "q1", 100, 50)
    );
  });
});

describe("market status and settlement", () => {
  // 基准时间早于 deadline（1_800_000_000_000），避免「已截止」抢先生效。
  const now = 1_790_000_000_000;

  test("open markets report a countdown and open tone", () => {
    const view = marketStatus(v5, now);
    expect(view).toMatchObject({ tone: "open", label: "进行中" });
    expect(deadlineView({ ...v5, deadline: now + 3_600_000 }, now)).toMatchObject({
      closed: false,
    });
  });

  test("locked, past-deadline and settling markets cannot be entered", () => {
    expect(marketStatus({ ...v5, status: "locked" }, now).tone).toBe("locked");
    expect(marketStatus({ ...v5, deadline: now - 1 }, now).label).toBe("待结算");
    expect(marketStatus({ ...v5, status: "settling" }, now).label).toBe("结算中");
    expect(deadlineView({ ...v5, status: "settling" }, now).closed).toBe(true);
  });

  test("settled markets highlight the winning outcome", () => {
    const settled = {
      ...v5,
      status: "settled" as const,
      winningOutcomeId: "2027q1",
      settledAt: now - 60_000,
    };
    const view = marketStatus(settled, now);
    expect(view.tone).toBe("yes");
    expect(view.label).toContain("已结算");
    expect(view.label).toContain("2027Q1");
    expect(deadlineView(settled, now).closed).toBe(true);
  });

  test("void markets ask for no result and refund", () => {
    const voided = { ...v5, status: "void" as const, settledAt: now };
    expect(marketStatus(voided, now)).toMatchObject({ tone: "void", label: "已取消" });
    const noWinner = { ...v5, status: "settled" as const, winningOutcomeId: null };
    expect(marketStatus(noWinner, now).tone).toBe("void");
  });

  test("settling sorts between locked and settled", () => {
    const list = [
      market({ id: "settled", status: "settled", settledAt: 5 }),
      market({ id: "settling", status: "settling" }),
      market({ id: "locked", status: "locked" }),
      market({ id: "open", deadline: 10 }),
    ];
    expect(sortMarkets(list).map((item) => item.id)).toEqual([
      "open",
      "locked",
      "settling",
      "settled",
    ]);
  });

  test("watch progress aggregates hits and the earliest sighting", () => {
    const tracked = market({
      outcomes: [
        outcome({ id: "a", hitCount: 2, firstSeenAt: now - 5000 }),
        outcome({ id: "b", hitCount: 1, firstSeenAt: now - 9000 }),
        outcome({ id: "c" }),
      ],
    });
    expect(outcomeProgress(tracked)).toEqual({
      hitCount: 2,
      firstSeenAt: now - 9000,
    });
    expect(outcomeProgress(market({ outcomes: [] }))).toEqual({
      hitCount: 0,
      firstSeenAt: null,
    });
  });
});
