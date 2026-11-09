import type { Transport, TransportRequest } from "./api.ts";
import type { PlatformConnection } from "./platform.ts";
import type {
  BetInput,
  BetResult,
  HistoryRow,
  LeaderboardEntry,
  Market,
  MarketStatus,
  PositionRow,
  Side,
} from "./types.ts";

const SEASON = "2026-11";
const DAY = 86_400_000;

export function demoConnection(): PlatformConnection {
  return {
    sdk: null,
    mode: "connected",
    theme: null,
    user: {
      id: 568,
      username: "deep_observer",
      name: "深海观测员",
      initials: "深",
      trustLevel: 3,
      avatarUrl: null,
    },
  };
}

interface MarketSeed {
  id: string;
  title: string;
  description: string;
  status: MarketStatus;
  deadline: number;
  yesPool: number;
  noPool: number;
  seedYes?: number;
  seedNo?: number;
  outcome?: Market["outcome"];
  hitCount?: number;
  firstSeenAt?: number | null;
  settledAt?: number | null;
  settleReason?: string | null;
  participants?: number;
}

function makeMarket(seed: MarketSeed): Market {
  const seedYes = seed.seedYes ?? 5000;
  const seedNo = seed.seedNo ?? 5000;
  const total = seed.yesPool + seed.noPool + seedYes + seedNo;
  const yesTotal = seed.yesPool + seedYes;
  const noTotal = seed.noPool + seedNo;
  return {
    id: seed.id,
    title: seed.title,
    description: seed.description,
    deadline: seed.deadline,
    status: seed.status,
    outcome: seed.outcome ?? null,
    yesPool: seed.yesPool,
    noPool: seed.noPool,
    seedYes,
    seedNo,
    yesShare:
      seed.yesPool + seed.noPool > 0
        ? seed.yesPool / (seed.yesPool + seed.noPool)
        : 0.5,
    impliedYes: total > 0 ? yesTotal / total : 0.5,
    payoutYes: Math.round((total / yesTotal) * 100) / 100,
    payoutNo: Math.round((total / noTotal) * 100) / 100,
    hitCount: seed.hitCount ?? 0,
    firstSeenAt: seed.firstSeenAt ?? null,
    settledAt: seed.settledAt ?? null,
    settleReason: seed.settleReason ?? null,
    participants: seed.participants,
  };
}

const NAMES = [
  "蓝洞信号",
  "北冥有鱼",
  "潮汐记录者",
  "蓝鲸不失眠",
  "海沟信号",
  "盐度七分",
  "灯塔守夜人",
  "洋流预报员",
  "磷光浮游",
  "回声定位",
  "冷泉口",
  "远端声呐",
];

const ACCURACY_ORDER = [5, 1, 8, 0, 3, 9, 2, 6, 7, 10, 4, 11];

export function createDemoTransport(
  options: { empty?: boolean } = {}
): Transport {
  let chips = 1337;
  let canClaim = true;
  let nextClaimAt: number | null = null;
  let betCounter = 0;
  const deadlines = {
    v5: Date.now() + 21 * DAY + 4 * 3_600_000,
    context: Date.now() + 9 * DAY + 3 * 3_600_000,
    output: Date.now() + 2 * DAY + 4 * 3_600_000,
    rename: Date.now() - 2 * 3_600_000,
    multimodal: Date.now() - 3 * DAY,
    agent: Date.now() - 6 * DAY,
  };

  const markets: Market[] = [
    makeMarket({
      id: "m_v5_2026",
      title: "V5 在 2026 年底前出现？",
      description: "以 DeepSeek 官方 /models 的 name 字段为准，连续观察确认后结算。",
      status: "open",
      deadline: deadlines.v5,
      yesPool: 12_400,
      noPool: 5_600,
      participants: 184,
    }),
    makeMarket({
      id: "m_context_2m",
      title: "V5 的上下文窗口达到 2M？",
      description: "按字段阈值比对 context_window，目标模型名称以官方清单为准。",
      status: "open",
      deadline: deadlines.context,
      yesPool: 8_200,
      noPool: 6_100,
      participants: 126,
    }),
    makeMarket({
      id: "m_output_128k",
      title: "输出上限提升到 128K？",
      description: "官方模型清单中的输出上限字段达到或超过目标值。",
      status: "open",
      deadline: deadlines.output,
      yesPool: 4_200,
      noPool: 3_800,
      participants: 97,
      hitCount: 1,
      firstSeenAt: Date.now() - 4 * 3_600_000,
    }),
    makeMarket({
      id: "m_v41_rename",
      title: "V4 系列在 11 月更名？",
      description: "官方模型清单中的名称发生变化，以连续两次观察为准。",
      status: "locked",
      deadline: deadlines.rename,
      yesPool: 3_000,
      noPool: 4_700,
      participants: 64,
    }),
    makeMarket({
      id: "m_native_multimodal",
      title: "原生多模态进入 V5？",
      description: "模型卡片或官方说明中明确列出原生多模态能力。",
      status: "settled",
      deadline: deadlines.multimodal,
      yesPool: 9_000,
      noPool: 2_200,
      outcome: "yes",
      settledAt: Date.now() - 2 * DAY,
      settleReason: "condition",
      participants: 143,
    }),
    makeMarket({
      id: "m_agent_api",
      title: "开放智能体工具接口？",
      description: "官方 API 文档新增可机读的智能体工具调用字段。",
      status: "settled",
      deadline: deadlines.agent,
      yesPool: 0,
      noPool: 1_800,
      outcome: "void",
      settledAt: Date.now() - 5 * DAY,
      settleReason: "manual",
      participants: 21,
    }),
  ];

  const positions: PositionRow[] = [
    {
      marketId: "m_v5_2026",
      title: markets[0].title,
      side: "yes",
      amount: 240,
      status: "open",
      payout: 0,
      createdAt: Date.now() - DAY,
    },
    {
      marketId: "m_output_128k",
      title: markets[2].title,
      side: "yes",
      amount: 160,
      status: "open",
      payout: 0,
      createdAt: Date.now() - 8 * 3_600_000,
    },
  ];

  const history: HistoryRow[] = [
    {
      id: "b_demo_1",
      marketId: "m_native_multimodal",
      title: markets[4].title,
      side: "yes",
      amount: 200,
      status: "won",
      payout: 318,
      createdAt: Date.now() - 4 * DAY,
      season: SEASON,
    },
    {
      id: "b_demo_2",
      marketId: "m_agent_api",
      title: markets[5].title,
      side: "no",
      amount: 120,
      status: "refunded",
      payout: 120,
      createdAt: Date.now() - 7 * DAY,
      season: SEASON,
    },
    {
      id: "b_demo_3",
      marketId: "m_context_2m",
      title: markets[1].title,
      side: "no",
      amount: 80,
      status: "lost",
      payout: 0,
      createdAt: Date.now() - 10 * DAY,
      season: SEASON,
    },
    {
      id: "b_demo_4",
      marketId: "m_v41_rename",
      title: markets[3].title,
      side: "yes",
      amount: 60,
      status: "open",
      payout: 0,
      createdAt: Date.now() - 12 * 3_600_000,
      season: SEASON,
    },
  ];

  // The current worker returns only rank/displayName/chips for the assets board.
  const assets: LeaderboardEntry[] = NAMES.map((displayName, index) => ({
    rank: index + 1,
    displayName,
    chips: 18_400 - index * 1_180 + (index % 3) * 70,
    accuracy: null,
    samples: null,
  }));
  assets[3] = {
    ...assets[3],
    displayName: "深海观测员",
    chips,
  };

  const accuracy: LeaderboardEntry[] = ACCURACY_ORDER.map(
    (nameIndex, index) => ({
      rank: index + 1,
      displayName: NAMES[nameIndex],
      chips: assets[nameIndex].chips,
      accuracy: 0.86 - index * 0.045,
      samples: 18 - Math.floor(index / 2),
    })
  );
  accuracy[3] = {
    ...accuracy[3],
    displayName: "深海观测员",
    chips,
    accuracy: 0.545,
    samples: 11,
  };

  const stats = () => ({
    staked: 1_260,
    payout: 1_120,
    correct: 6,
    total: 11,
    accuracy: 6 / 11,
  });

  function findMarket(id: string): Market | undefined {
    return markets.find((market) => market.id === id);
  }

  function reprice(market: Market): void {
    const total =
      market.yesPool + market.noPool + market.seedYes + market.seedNo;
    market.impliedYes = total > 0 ? (market.yesPool + market.seedYes) / total : 0.5;
    market.yesShare =
      market.yesPool + market.noPool > 0
        ? market.yesPool / (market.yesPool + market.noPool)
        : 0.5;
    market.payoutYes =
      Math.round((total / (market.yesPool + market.seedYes)) * 100) / 100;
    market.payoutNo =
      Math.round((total / (market.noPool + market.seedNo)) * 100) / 100;
  }

  const delay = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });

  return async (
    endpoint: string,
    request: TransportRequest
  ): Promise<{ status: number; body: unknown }> => {
    await delay();
    const query = request.query ?? {};

    switch (endpoint) {
      case "publicConfig":
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              productName: "预言鲸",
              season: SEASON,
              betMin: 10,
              maxBetRatio: 0.5,
              dailyChips: 100,
              initialChips: 1000,
              serverTime: Date.now(),
            },
          },
        };
      case "publicMarkets": {
        const id = typeof query.id === "string" ? query.id : null;
        const status = typeof query.status === "string" ? query.status : null;
        const limit = Number(query.limit ?? 20);
        const items = options.empty
          ? []
          : markets
              .filter((market) => (id ? market.id === id : true))
              .filter((market) => (status ? market.status === status : true))
              .slice(0, Number.isFinite(limit) ? limit : 20);
        return {
          status: 200,
          body: { ok: true, data: { items, nextCursor: null } },
        };
      }
      case "publicLeaderboard": {
        const type = query.type === "accuracy" ? "accuracy" : "assets";
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              season: SEASON,
              type,
              items: options.empty
                ? []
                : type === "accuracy"
                  ? accuracy
                  : assets,
            },
          },
        };
      }
      case "me":
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              displayName: "深海观测员",
              chips,
              season: SEASON,
              canClaim,
              nextClaimAt,
              stats: stats(),
            },
          },
        };
      case "claim": {
        if (!canClaim) {
          return {
            status: 200,
            body: {
              ok: true,
              data: { claimed: false, chips, amount: 0 },
            },
          };
        }
        canClaim = false;
        chips += 100;
        nextClaimAt = Date.now() + DAY;
        return {
          status: 200,
          body: {
            ok: true,
            data: { claimed: true, chips, amount: 100 },
          },
        };
      }
      case "positions": {
        const status = typeof query.status === "string" ? query.status : null;
        const items = options.empty
          ? []
          : positions.filter((row) =>
              status === "settled"
                ? row.status !== "open"
                : row.status === "open"
            );
        return {
          status: 200,
          body: { ok: true, data: { items, nextCursor: null } },
        };
      }
      case "history":
        return {
          status: 200,
          body: {
            ok: true,
            data: { items: options.empty ? [] : history, nextCursor: null },
          },
        };
      case "myRank": {
        const type = query.type === "accuracy" ? "accuracy" : "assets";
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              rank: 4,
              samples: type === "accuracy" ? 11 : null,
              season: SEASON,
              type,
            },
          },
        };
      }
      case "placeBet": {
        const input = request.json as BetInput | undefined;
        if (!input) {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "INVALID_AMOUNT", message: "" },
            },
          };
        }
        const market = findMarket(input.marketId);
        if (!market || market.status !== "open") {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "MARKET_CLOSED", message: "" },
            },
          };
        }
        const max = Math.floor(chips * 0.5);
        if (input.amount > max) {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "BET_TOO_LARGE", message: "" },
            },
          };
        }
        if (input.amount < 10) {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "BET_TOO_SMALL", message: "" },
            },
          };
        }
        chips -= input.amount;
        if (input.side === "yes") market.yesPool += input.amount;
        else market.noPool += input.amount;
        reprice(market);
        betCounter += 1;
        const row: HistoryRow = {
          id: `b_demo_${betCounter + 10}`,
          marketId: market.id,
          title: market.title,
          side: input.side as Side,
          amount: input.amount,
          status: "open",
          payout: 0,
          createdAt: Date.now(),
          season: SEASON,
        };
        history.unshift(row);
        positions.unshift({
          marketId: market.id,
          title: market.title,
          side: input.side,
          amount: input.amount,
          status: "open",
          payout: 0,
          createdAt: Date.now(),
        });
        const result: BetResult = {
          betId: row.id,
          chips,
          market: {
            id: market.id,
            yesPool: market.yesPool,
            noPool: market.noPool,
            impliedYes: market.impliedYes,
          },
        };
        return { status: 200, body: { ok: true, data: result } };
      }
      default:
        return {
          status: 404,
          body: {
            ok: false,
            error: { code: "ENDPOINT_NOT_FOUND", message: "" },
          },
        };
    }
  };
}
