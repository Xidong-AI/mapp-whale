import type { Transport, TransportRequest } from "./api.ts";
import type { PlatformConnection } from "./platform.ts";
import type {
  BetInput,
  BetResult,
  HistoryRow,
  LeaderboardEntry,
  Market,
  MarketStatus,
  Outcome,
  PositionRow,
  SettleMode,
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

interface OutcomeSeed {
  id: string;
  label: string;
  pool?: number;
  seed?: number;
  hitCount?: number;
  firstSeenAt?: number | null;
}

interface MarketSeed {
  id: string;
  title: string;
  description: string;
  status: MarketStatus;
  deadline: number;
  settleMode?: SettleMode;
  fallbackOutcomeId?: string | null;
  winningOutcomeId?: string | null;
  outcomes: OutcomeSeed[];
  settledAt?: number | null;
  settleReason?: string | null;
  participants?: number;
}

/** 与 worker 的 marketView 同口径：totalPool = Σ(pool+seed)，implied/payout 由池子派生。 */
function reprice(market: Market): void {
  const total = market.outcomes.reduce(
    (sum, outcome) => sum + outcome.pool + outcome.seed,
    0
  );
  market.totalPool = total;
  for (const outcome of market.outcomes) {
    const base = outcome.pool + outcome.seed;
    outcome.implied =
      total === 0 ? 1 : Math.round((base / total) * 100) / 100;
    outcome.payout = base === 0 ? 1 : Math.round((total / base) * 100) / 100;
  }
}

function makeMarket(seed: MarketSeed): Market {
  const outcomes: Outcome[] = seed.outcomes.map((outcome) => ({
    id: outcome.id,
    label: outcome.label,
    pool: outcome.pool ?? 0,
    seed: outcome.seed ?? 0,
    implied: 0,
    payout: 0,
    hitCount: outcome.hitCount ?? 0,
    firstSeenAt: outcome.firstSeenAt ?? null,
  }));
  const market: Market = {
    id: seed.id,
    title: seed.title,
    description: seed.description,
    deadline: seed.deadline,
    status: seed.status,
    settleMode: seed.settleMode ?? "exclusive",
    fallbackOutcomeId: seed.fallbackOutcomeId ?? null,
    winningOutcomeId: seed.winningOutcomeId ?? null,
    totalPool: 0,
    outcomes,
    settledAt: seed.settledAt ?? null,
    settleReason: seed.settleReason ?? null,
    participants: seed.participants,
  };
  reprice(market);
  return market;
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
      id: "m_v5_when",
      title: "V5 什么时候发布？",
      description: "以 DeepSeek 官方 /models 中首次出现 V5 的季度为准，连续观察确认后结算。",
      status: "open",
      deadline: deadlines.v5,
      fallbackOutcomeId: "never",
      participants: 184,
      outcomes: [
        { id: "2026q4", label: "2026 Q4", pool: 3_000, seed: 1_250 },
        { id: "2027q1", label: "2027 Q1", pool: 1_800, seed: 1_200 },
        { id: "2027q2", label: "2027 Q2", pool: 700, seed: 900 },
        { id: "2027q3", label: "2027 Q3", pool: 300, seed: 600 },
        { id: "2027q4", label: "2027 Q4", pool: 150, seed: 400 },
        { id: "2028plus", label: "2028 及以后", pool: 0, seed: 300 },
        { id: "never", label: "截止前未出现", pool: 0, seed: 200 },
      ],
    }),
    makeMarket({
      id: "m_v5_context",
      title: "V5 的上下文档位落在哪里？",
      description: "按 /models 中 V5 的 context_window 字段分档，取首个匹配模型。",
      status: "open",
      deadline: deadlines.context,
      fallbackOutcomeId: "unknown",
      participants: 126,
      outcomes: [
        { id: "lt_1m", label: "< 1M", pool: 200, seed: 800 },
        { id: "1m_2m", label: "1M – 2M", pool: 2_600, seed: 1_500 },
        { id: "2m_4m", label: "2M – 4M", pool: 600, seed: 900 },
        { id: "gte_4m", label: "≥ 4M", pool: 120, seed: 300 },
        { id: "unknown", label: "未公开", pool: 0, seed: 200 },
      ],
    }),
    makeMarket({
      id: "m_v5_output",
      title: "V5 的输出上限落在哪一档？",
      description: "按官方模型清单中输出上限字段分档，达到或超过即计入上一档。",
      status: "open",
      deadline: deadlines.output,
      fallbackOutcomeId: "unknown",
      participants: 97,
      outcomes: [
        {
          id: "lt_128k",
          label: "< 128K",
          pool: 900,
          seed: 700,
          hitCount: 1,
          firstSeenAt: Date.now() - 4 * 3_600_000,
        },
        { id: "128k_256k", label: "128K – 256K", pool: 1_500, seed: 1_300 },
        { id: "256k_500k", label: "256K – 500K", pool: 300, seed: 800 },
        { id: "gte_500k", label: "≥ 500K", pool: 100, seed: 400 },
        { id: "unknown", label: "未公开", pool: 0, seed: 150 },
      ],
    }),
    makeMarket({
      id: "m_v41_rename",
      title: "V4 系列会在 11 月更名吗？",
      description: "官方模型清单中的名称发生变化，以连续两次观察为准。",
      status: "locked",
      deadline: deadlines.rename,
      participants: 64,
      outcomes: [
        { id: "oct", label: "10 月已更名", pool: 300, seed: 400 },
        { id: "nov", label: "11 月更名", pool: 1_100, seed: 900 },
        { id: "no", label: "未更名", pool: 700, seed: 600 },
      ],
    }),
    makeMarket({
      id: "m_native_multimodal",
      title: "V5 是否原生支持多模态？",
      description: "模型卡片或官方说明中明确列出原生多模态能力。",
      status: "settled",
      deadline: deadlines.multimodal,
      winningOutcomeId: "native",
      settledAt: Date.now() - 2 * DAY,
      settleReason: "condition",
      participants: 143,
      outcomes: [
        { id: "native", label: "原生多模态", pool: 2_400, seed: 900 },
        { id: "partial", label: "仅图片输入", pool: 600, seed: 700 },
        { id: "none", label: "不支持", pool: 200, seed: 400 },
      ],
    }),
    makeMarket({
      id: "m_agent_api",
      title: "会开放智能体工具接口吗？",
      description: "官方 API 文档新增可机读的智能体工具调用字段。",
      status: "void",
      deadline: deadlines.agent,
      settledAt: Date.now() - 5 * DAY,
      settleReason: "manual",
      participants: 21,
      outcomes: [
        { id: "tools", label: "新增工具接口", pool: 200, seed: 500 },
        { id: "none", label: "未新增", pool: 100, seed: 500 },
      ],
    }),
  ];

  const positions: PositionRow[] = [
    {
      marketId: "m_v5_when",
      title: markets[0].title,
      outcomeId: "2027q1",
      outcomeLabel: "2027 Q1",
      amount: 240,
      status: "open",
      payout: 0,
      createdAt: Date.now() - DAY,
    },
    {
      marketId: "m_v5_output",
      title: markets[2].title,
      outcomeId: "128k_256k",
      outcomeLabel: "128K – 256K",
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
      outcomeId: "native",
      outcomeLabel: "原生多模态",
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
      outcomeId: "tools",
      outcomeLabel: "新增工具接口",
      amount: 120,
      status: "refunded",
      payout: 120,
      createdAt: Date.now() - 7 * DAY,
      season: SEASON,
    },
    {
      id: "b_demo_3",
      marketId: "m_v5_context",
      title: markets[1].title,
      outcomeId: "gte_4m",
      outcomeLabel: "≥ 4M",
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
      outcomeId: "nov",
      outcomeLabel: "11 月更名",
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
        if (!input || typeof input.outcomeId !== "string") {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "INVALID_REQUEST", message: "" },
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
        const outcome = market.outcomes.find(
          (item) => item.id === input.outcomeId
        );
        if (!outcome) {
          return {
            status: 400,
            body: {
              ok: false,
              error: { code: "INVALID_OUTCOME", message: "" },
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
        outcome.pool += input.amount;
        reprice(market);
        betCounter += 1;
        const row: HistoryRow = {
          id: `b_demo_${betCounter + 10}`,
          marketId: market.id,
          title: market.title,
          outcomeId: outcome.id,
          outcomeLabel: outcome.label,
          amount: input.amount,
          status: "open",
          payout: 0,
          createdAt: Date.now(),
          season: SEASON,
        };
        history.unshift(row);
        const position = positions.find(
          (item) =>
            item.marketId === market.id && item.outcomeId === outcome.id
        );
        if (position) {
          position.amount += input.amount;
        } else {
          positions.unshift({
            marketId: market.id,
            title: market.title,
            outcomeId: outcome.id,
            outcomeLabel: outcome.label,
            amount: input.amount,
            status: "open",
            payout: 0,
            createdAt: Date.now(),
          });
        }
        const result: BetResult = {
          betId: row.id,
          chips,
          market: {
            id: market.id,
            totalPool: market.totalPool,
            outcomes: market.outcomes.map((item) => ({ ...item })),
          },
          marketFull: { ...market, outcomes: market.outcomes.map((item) => ({ ...item })) },
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
