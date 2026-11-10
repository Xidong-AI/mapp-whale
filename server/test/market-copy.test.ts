// 市场文案风格：中文引号、无多余括号与举例、描述精简。
import { describe, expect, test } from "bun:test";
import { makeEnv } from "./helpers/env";

type MarketRow = { id: string; title: string; description: string };
type OutcomeRow = { id: string; market_id: string; label: string };

const { db } = makeEnv();
const markets = (
  await db.prepare("SELECT id, title, description FROM markets ORDER BY id").all<MarketRow>()
).results;
const outcomes = (
  await db
    .prepare("SELECT id, market_id, label FROM outcomes ORDER BY market_id, sort_order")
    .all<OutcomeRow>()
).results;

const BANNED = ["「", "」", "（", "）"] as const;

describe("市场文案风格", () => {
  test("描述非空且不超过 180 字", () => {
    expect(markets.length).toBeGreaterThan(0);
    for (const market of markets) {
      expect(market.description.length).toBeGreaterThan(0);
      expect(market.description.length).toBeLessThanOrEqual(180);
    }
  });

  test("描述不使用直角引号、圆括号与举例提示", () => {
    for (const market of markets) {
      for (const ch of BANNED) {
        expect(market.description.includes(ch)).toBe(false);
      }
      expect(market.description.includes("例如")).toBe(false);
    }
  });

  test("描述写明北京时间", () => {
    for (const market of markets) {
      expect(market.description).toContain("北京时间");
    }
  });

  test("选项标签不使用直角引号或圆括号", () => {
    for (const outcome of outcomes) {
      for (const ch of BANNED) {
        expect(outcome.label.includes(ch)).toBe(false);
      }
    }
  });
});
