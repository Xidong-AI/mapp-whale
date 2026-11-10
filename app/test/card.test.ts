import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCardView, type CardView } from "../src/views/card.ts";
import type { AppContext } from "../src/context.ts";
import type { Market, MarketPage } from "../src/types.ts";

function marketOf(overrides: Partial<Market> = {}): Market {
  return {
    id: "m_v5_when",
    title: "V5 什么时候发布？",
    description: "以官方 /models 为准。",
    deadline: Date.now() + 3 * 86_400_000,
    status: "open",
    settleMode: "exclusive",
    fallbackOutcomeId: null,
    winningOutcomeId: null,
    totalPool: 8750,
    outcomes: [
      { id: "a", label: "2026 Q4", pool: 3000, seed: 1250, implied: 0.49, payout: 2.05 },
      { id: "b", label: "2027 Q1", pool: 1800, seed: 1200, implied: 0.34, payout: 2.92 },
      { id: "c", label: "2027 Q2", pool: 700, seed: 900, implied: 0.18, payout: 5.48 },
    ],
    settledAt: null,
    settleReason: null,
    participants: 184,
    ...overrides,
  };
}

interface Harness {
  ctx: AppContext;
  view: CardView;
  root: HTMLElement;
  marketsCalls: Array<{ id?: string }>;
  respondWith: (
    handler: (query: { id?: string }) => MarketPage | Promise<MarketPage>
  ) => void;
}

function harness(): Harness {
  const root = document.createElement("section");
  root.id = "view-card";
  document.body.append(root);

  const marketsCalls: Array<{ id?: string }> = [];
  let handler: (query: { id?: string }) => MarketPage | Promise<MarketPage> = () => ({
    items: [marketOf()],
    nextCursor: null,
  });
  const ctx: AppContext = {
    api: {
      markets(query = {}) {
        marketsCalls.push(query);
        return Promise.resolve(handler(query));
      },
    } as unknown as AppContext["api"],
    cache: {} as AppContext["cache"],
    connection: { sdk: null, mode: "preview", user: null, theme: null },
    demo: false,
    toast() {},
    banner() {},
    getConfig: () => ({
      productName: "预言鲸",
      season: "2026-11",
      betMin: 10,
      maxBetRatio: 0.5,
      dailyChips: 100,
      initialChips: 1000,
      serverTime: 0,
    }),
    setConfig() {},
    getMe: () => null,
    setMe() {},
    getMarkets: () => [],
    setMarkets() {},
    upsertMarket() {},
    getMarket: () => undefined,
    serverNow: () => Date.now(),
    getPrefs: () => ({
      tab: "markets",
      lastMarketId: null,
      lastOutcomeId: null,
      confidence: 0,
      amount: null,
      theme: "abyss",
    }),
    setPrefs() {},
    getDraft: () => null,
    setDraft() {},
    goTab() {},
    openMarket() {},
    openLeaderboard() {},
    requestLogin() {},
    refreshMe: async () => {},
    isSignedIn: () => false,
    copyEmbedCode: async () => {},
  };
  return {
    ctx,
    view: createCardView(ctx),
    root,
    marketsCalls,
    respondWith(next) {
      handler = next;
    },
  };
}

const container = () => document.getElementById("view-card") as HTMLElement;

beforeEach(() => {
  const previous = document.getElementById("view-card");
  if (previous) previous.remove();
});

afterEach(() => {
  document.getElementById("view-card")?.remove();
});

describe("createCardView", () => {
  test("marketId 为 null 时渲染空态", async () => {
    const { view } = harness();
    await view.show(null);
    expect(container().querySelector(".card__empty")).not.toBeNull();
    expect(container().textContent).toContain("还没有指定市场");
    expect(container().querySelector(".card__dist")).toBeNull();
  });

  test("正常市场按 implied 降序渲染分布条", async () => {
    const { view, marketsCalls } = harness();
    await view.show("m_v5_when");
    expect(marketsCalls).toEqual([{ id: "m_v5_when" }]);
    expect(container().querySelector(".card__title")?.textContent).toBe(
      "V5 什么时候发布？"
    );
    const rows = [...container().querySelectorAll(".card__row")];
    expect(rows.length).toBe(3);
    const percents = rows.map(
      (row) => row.querySelector(".card__pct")?.textContent
    );
    expect(percents).toEqual(["49%", "34%", "18%"]);
    const widths = rows.map(
      (row) => (row.querySelector(".card__bar")?.firstElementChild as HTMLElement)?.style.width
    );
    expect(widths).toEqual(["49%", "34%", "18%"]);
    expect(container().querySelector(".card__foot")?.textContent).toContain("彩池");
  });

  test("请求失败时渲染错误态与重试按钮，点击重试重新请求", async () => {
    const { view, respondWith, marketsCalls } = harness();
    respondWith(() => {
      throw new Error("boom");
    });
    await view.show("m_v5_when");
    expect(container().querySelector(".card__error")).not.toBeNull();
    const retry = container().querySelector(
      ".card__error button"
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    respondWith(() => ({ items: [marketOf()], nextCursor: null }));
    const callsBefore = marketsCalls.length;
    retry!.click();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(marketsCalls.length).toBeGreaterThan(callsBefore);
  });

  test("响应 0 条市场时渲染空态", async () => {
    const { view, respondWith } = harness();
    respondWith(() => ({ items: [], nextCursor: null }));
    await view.show("m_v5_when");
    expect(container().querySelector(".card__empty")).not.toBeNull();
    expect(container().querySelector(".card__error")).toBeNull();
  });

  test("重复 show 时旧请求失效（竞态保护）", async () => {
    const { view, respondWith } = harness();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openGate = () => {
      if (release) {
        const done = release;
        release = null;
        done();
      }
    };
    respondWith(() => {
      const page: MarketPage = { items: [marketOf()], nextCursor: null };
      return gate.then(() => page, () => page);
    });
    const first = view.show("m_slow");
    const second = view.show("m_fast");
    openGate();
    await Promise.all([first, second]);
    expect(container().querySelector(".card__title")?.textContent).toBe(
      "V5 什么时候发布？"
    );
  });
});
