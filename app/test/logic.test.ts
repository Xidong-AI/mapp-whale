import { describe, expect, test } from "bun:test";
import {
  accuracyPercent,
  applyOutcomePools,
  betIntentKey,
  betLimit,
  currentSeason,
  formatAccuracy,
  formatChips,
  formatConfidence,
  formatCountdown,
  formatDateTime,
  formatMultiplier,
  impliedPercent,
  marketPoolTotal,
  previewReturn,
  quickAmount,
  seasonOptions,
  sideFor,
  sortMarkets,
  stageFor,
  stageHint,
  validateAmount,
} from "../src/logic.ts";
import type { Market } from "../src/types.ts";

const base: Market = {
  id: "m1",
  title: "M1",
  description: "",
  deadline: 1_800_000_000_000,
  status: "open",
  settleMode: "exclusive",
  fallbackOutcomeId: null,
  winningOutcomeId: null,
  totalPool: 2000,
  outcomes: [
    { id: "a", label: "A", pool: 1000, seed: 500, implied: 0.75, payout: 1.33 },
    { id: "b", label: "B", pool: 500, seed: 500, implied: 0.5, payout: 2 },
  ],
  settledAt: null,
  settleReason: null,
};

describe("stage mapping", () => {
  test("separates directions and stages at the documented thresholds", () => {
    expect(stageFor(0)).toMatchObject({ direction: 0, index: 0, label: "幼鲸" });
    expect(stageFor(9)).toMatchObject({ direction: 1, index: 0, label: "幼鲸" });
    expect(stageFor(10)).toMatchObject({ direction: 1, index: 1, label: "小鲸" });
    expect(stageFor(34)).toMatchObject({ direction: 1, index: 1 });
    expect(stageFor(35)).toMatchObject({ direction: 1, index: 2, label: "涌鲸" });
    expect(stageFor(60)).toMatchObject({ direction: 1, index: 3, label: "鲸王" });
    expect(stageFor(85)).toMatchObject({ direction: 1, index: 4, label: "鲸祖" });
    expect(stageFor(100)).toMatchObject({ direction: 1, index: 4 });
    expect(stageFor(-9)).toMatchObject({ direction: -1, index: 0, label: "幼鲸" });
    expect(stageFor(-10)).toMatchObject({ direction: -1, index: 1, label: "潜鲸" });
    expect(stageFor(-35)).toMatchObject({ direction: -1, index: 2, label: "沉鲸" });
    expect(stageFor(-60)).toMatchObject({ direction: -1, index: 3, label: "渊鲸" });
    expect(stageFor(-85)).toMatchObject({ direction: -1, index: 4, label: "渊祖" });
    expect(stageFor(-100).intensity).toBe(1);
    expect(stageFor(50).intensity).toBeCloseTo(0.5);
  });

  test("returns a side only when the slider leaves neutral", () => {
    expect(sideFor(0)).toBeNull();
    expect(sideFor(1)).toBe("yes");
    expect(sideFor(-1)).toBe("no");
    expect(sideFor(120)).toBe("yes");
    expect(sideFor(-120)).toBe("no");
  });

  test("every stage has a hint and neutral has its own", () => {
    expect(stageHint(0, 0)).toContain("中性");
    for (const direction of [1, -1] as const) {
      for (let index = 0; index < 5; index += 1) {
        expect(stageHint(direction, index).length).toBeGreaterThan(2);
      }
    }
  });

  test("formats signed confidence with a true minus sign", () => {
    expect(formatConfidence(72)).toBe("+72");
    expect(formatConfidence(-72)).toBe("−72");
    expect(formatConfidence(0)).toBe("0");
    expect(formatConfidence(500)).toBe("+100");
  });
});

describe("amount validation", () => {
  test("accepts integers inside the server bounds", () => {
    expect(validateAmount(10, 1000, 10, 0.5)).toMatchObject({
      ok: true,
      max: 500,
      min: 10,
    });
    expect(validateAmount("500", 1000, 10, 0.5).ok).toBe(true);
    expect(betLimit(999, 0.5)).toBe(499);
  });

  test("rejects invalid, too small and too large amounts", () => {
    expect(validateAmount("", 1000, 10, 0.5).code).toBe("INVALID_AMOUNT");
    expect(validateAmount("10.5", 1000, 10, 0.5).code).toBe("INVALID_AMOUNT");
    expect(validateAmount(-5, 1000, 10, 0.5).code).toBe("INVALID_AMOUNT");
    expect(validateAmount(9, 1000, 10, 0.5).code).toBe("BET_TOO_SMALL");
    expect(validateAmount(501, 1000, 10, 0.5).code).toBe("BET_TOO_LARGE");
  });

  test("reports a low balance before an oversized amount", () => {
    expect(validateAmount(10, 15, 10, 0.5)).toMatchObject({
      ok: false,
      code: "CHIPS_TOO_LOW",
      max: 7,
    });
    expect(validateAmount(10, 0, 10, 0.5).code).toBe("CHIPS_TOO_LOW");
    expect(validateAmount(10, 1000, 10, 0).code).toBe("CHIPS_TOO_LOW");
  });

  test("quick amounts stay inside the limit", () => {
    expect(quickAmount("min", 1000, 10, 0.5)).toBe(10);
    expect(quickAmount("half", 1000, 10, 0.5)).toBe(250);
    expect(quickAmount("max", 1000, 10, 0.5)).toBe(500);
    expect(quickAmount("max", 15, 10, 0.5)).toBe(7);
  });

  test("previews returns with floor, matching the settlement rule", () => {
    expect(previewReturn(100, 1.83)).toBe(183);
    expect(previewReturn(99, 2.75)).toBe(272);
    expect(previewReturn(0, 2)).toBe(0);
    expect(previewReturn(10, Number.NaN)).toBe(0);
  });
});

describe("formatting", () => {
  test("chips, multipliers and percentages", () => {
    expect(formatChips(12800)).toBe("12,800");
    expect(formatChips(null)).toBe("—");
    expect(formatMultiplier(1.8)).toBe("×1.80");
    expect(formatMultiplier(undefined)).toBe("—");
    expect(impliedPercent(0.6)).toBe(60);
    expect(impliedPercent(1.4)).toBe(100);
    expect(accuracyPercent(0.72)).toBe(72);
    expect(accuracyPercent(72)).toBe(72);
    expect(formatAccuracy(null)).toBe("—");
  });

  test("countdowns switch to closed at the deadline", () => {
    const now = 1_800_000_000_000;
    expect(formatCountdown(now - 1, now)).toBe("已截止");
    expect(formatCountdown(now + 3_600_000, now)).toBe("01:00:00");
    expect(formatCountdown(now + 3_600_000, now, true)).toBe("01:00");
    const twoDays = now + 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000;
    expect(formatCountdown(twoDays, now, true)).toBe("2 天 03:04");
    expect(formatCountdown(twoDays, now)).toBe("2 天 03:04:00");
  });

  test("formats Asia/Shanghai time", () => {
    const epoch = Date.UTC(2026, 10, 30, 15, 59);
    expect(formatDateTime(epoch)).toBe("2026-11-30 23:59");
    expect(formatDateTime(null)).toBe("—");
  });

  test("season helpers roll across years", () => {
    expect(seasonOptions("2026-01", 3)).toEqual([
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
    expect(
      currentSeason(Date.UTC(2026, 10, 9, 16, 30))
    ).toBe("2026-11");
  });
});

describe("market helpers", () => {
  test("sorts open before settled and open by deadline", () => {
    const markets: Market[] = [
      { ...base, id: "settled", status: "settled", settledAt: 5 },
      { ...base, id: "late", deadline: 30 },
      { ...base, id: "soon", deadline: 10 },
      { ...base, id: "locked", status: "locked" },
    ];
    expect(sortMarkets(markets).map((market) => market.id)).toEqual([
      "soon",
      "late",
      "locked",
      "settled",
    ]);
  });

  test("pool total includes seeds", () => {
    expect(marketPoolTotal(base)).toBe(2000);
  });

  test("pool updates recompute odds without touching identity", () => {
    const updated = applyOutcomePools(base, { a: 1200 });
    expect(updated.outcomes[0]!.pool).toBe(1200);
    expect(updated.totalPool).toBe(2700);
    expect(updated.outcomes[0]!.payout).toBeCloseTo(1.59, 2);
    expect(updated.outcomes[1]!.payout).toBeCloseTo(2.7, 2);
  });

  test("request keys bind the exact intent", () => {
    const first = betIntentKey("m1", "a", 100, 50);
    expect(first).toBe(betIntentKey("m1", "a", 100, 50));
    expect(first).not.toBe(betIntentKey("m1", "a", 101, 50));
  });
});
