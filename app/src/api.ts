import { ENDPOINTS, REQUEST_TIMEOUT_MS, type EndpointName } from "./config.ts";
import { ApiError } from "./errors.ts";
import type {
  BetInput,
  BetResult,
  ClaimResult,
  HistoryRow,
  Leaderboard,
  LeaderboardEntry,
  LeaderboardType,
  Market,
  MarketOutcome,
  MarketPage,
  MarketStatus,
  Me,
  MyRank,
  Page,
  PositionRow,
  PublicConfig,
  Side,
} from "./types.ts";

export interface TransportRequest {
  method: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export type Transport = (
  endpoint: EndpointName,
  request: TransportRequest
) => Promise<TransportResponse>;

export interface MarketsQuery {
  id?: string;
  status?: MarketStatus;
  limit?: number;
  cursor?: string | null;
}

export interface Api {
  config(): Promise<PublicConfig>;
  markets(query?: MarketsQuery): Promise<MarketPage>;
  leaderboard(query: {
    type: LeaderboardType;
    season: string;
    limit?: number;
  }): Promise<Leaderboard>;
  me(): Promise<Me>;
  claim(displayName?: string): Promise<ClaimResult>;
  positions(query?: {
    status?: "open" | "settled";
    limit?: number;
    cursor?: string | null;
  }): Promise<Page<PositionRow>>;
  history(query?: {
    season?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<Page<HistoryRow>>;
  placeBet(input: BetInput): Promise<BetResult>;
  myRank(query: { type: LeaderboardType; season: string }): Promise<MyRank>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOf(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerOf(value: unknown, fallback = 0): number {
  return Math.trunc(numberOf(value, fallback));
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sideOf(value: unknown): Side {
  return typeof value === "string" && value.toLowerCase() === "no"
    ? "no"
    : "yes";
}

const STATUSES = new Set<MarketStatus>(["open", "locked", "settled", "void"]);

function statusOf(value: unknown): MarketStatus {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return STATUSES.has(normalized as MarketStatus)
    ? (normalized as MarketStatus)
    : "open";
}

function outcomeOf(value: unknown): MarketOutcome | null {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized === "yes" || normalized === "no" || normalized === "void"
    ? normalized
    : null;
}

export function normalizeMarket(value: unknown): Market {
  const raw = record(value) ?? {};
  return {
    id: stringOf(raw.id),
    title: stringOf(raw.title, "未命名市场"),
    description: stringOf(raw.description),
    deadline: numberOf(raw.deadline),
    status: statusOf(raw.status),
    outcome: outcomeOf(raw.outcome),
    yesPool: integerOf(raw.yesPool),
    noPool: integerOf(raw.noPool),
    seedYes: integerOf(raw.seedYes),
    seedNo: integerOf(raw.seedNo),
    yesShare: numberOf(raw.yesShare),
    impliedYes: numberOf(raw.impliedYes, 0.5),
    payoutYes: numberOf(raw.payoutYes),
    payoutNo: numberOf(raw.payoutNo),
    hitCount: integerOf(raw.hitCount),
    firstSeenAt: nullableNumber(raw.firstSeenAt),
    settledAt: nullableNumber(raw.settledAt),
    settleReason: nullableString(raw.settleReason),
    participants: nullableNumber(raw.participants ?? raw.participantCount),
  };
}

function extractItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const raw = record(data);
  if (!raw) return [];
  for (const key of ["items", "positions", "history", "bets", "markets"]) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return [];
}

function extractCursor(data: unknown): string | null {
  const raw = record(data);
  return raw ? nullableString(raw.nextCursor) : null;
}

function normalizeEntry(value: unknown): LeaderboardEntry {
  const raw = record(value) ?? {};
  return {
    rank: Math.max(1, integerOf(raw.rank, 1)),
    displayName: stringOf(raw.displayName, "鲸友"),
    chips: integerOf(raw.chips),
    accuracy: nullableNumber(raw.accuracy),
    samples: nullableNumber(raw.samples),
  };
}

const MARKET_KEYS = ["marketId", "market_id", "id"] as const;

function positionOf(value: unknown): PositionRow {
  const raw = record(value) ?? {};
  const market = record(raw.market);
  const marketId =
    MARKET_KEYS.map((key) => raw[key]).find(
      (entry): entry is string => typeof entry === "string" && entry.length > 0
    ) ?? stringOf(market?.id);
  return {
    marketId,
    title:
      nullableString(raw.title) ??
      nullableString(raw.marketTitle) ??
      nullableString(raw.market_title) ??
      nullableString(market?.title),
    side: sideOf(raw.side),
    amount: integerOf(raw.amount ?? raw.stake ?? raw.staked ?? raw.total),
    status: stringOf(raw.status, "open"),
    payout: integerOf(raw.payout ?? raw.returned ?? raw.return),
    createdAt: nullableNumber(raw.createdAt ?? raw.created_at),
  };
}

function historyOf(value: unknown): HistoryRow {
  const raw = record(value) ?? {};
  const position = positionOf(value);
  return {
    id: stringOf(raw.betId ?? raw.id),
    marketId: position.marketId,
    title: position.title,
    side: position.side,
    amount: position.amount,
    status: position.status,
    payout: position.payout,
    createdAt: position.createdAt,
    season: nullableString(raw.season),
  };
}

function normalizeMe(value: unknown): Me {
  const raw = record(value) ?? {};
  const stats = record(raw.stats) ?? {};
  return {
    displayName: nullableString(raw.displayName),
    chips: integerOf(raw.chips),
    season: stringOf(raw.season),
    canClaim: raw.canClaim === true,
    nextClaimAt: nullableNumber(raw.nextClaimAt),
    stats: {
      staked: integerOf(stats.staked),
      payout: integerOf(stats.payout),
      correct: integerOf(stats.correct),
      total: integerOf(stats.total),
      accuracy: nullableNumber(stats.accuracy),
    },
  };
}

function normalizeBet(value: unknown): BetResult {
  const raw = record(value) ?? {};
  const market = record(raw.market) ?? {};
  const result: BetResult = {
    betId: stringOf(raw.betId),
    chips: integerOf(raw.chips),
    market: {
      id: stringOf(market.id),
      yesPool: integerOf(market.yesPool),
      noPool: integerOf(market.noPool),
      impliedYes: numberOf(market.impliedYes, 0.5),
    },
  };
  if (typeof market.status === "string" || typeof market.deadline === "number") {
    result.marketFull = normalizeMarket(market);
  }
  return result;
}

function normalizeConfig(value: unknown): PublicConfig {
  const raw = record(value) ?? {};
  return {
    productName: stringOf(raw.productName, "预言鲸"),
    season: stringOf(raw.season),
    betMin: integerOf(raw.betMin, 10),
    maxBetRatio: numberOf(raw.maxBetRatio, 0.5),
    dailyChips: integerOf(raw.dailyChips, 100),
    initialChips: integerOf(raw.initialChips, 1000),
    pageSize: nullableNumber(raw.pageSize) ?? undefined,
    accuracyMinSamples: nullableNumber(raw.accuracyMinSamples) ?? undefined,
    serverTime: integerOf(raw.serverTime),
  };
}

function compactQuery(
  query: Record<string, string | number | undefined> | undefined
): Record<string, string> | undefined {
  if (!query) return undefined;
  const entries = Object.entries(query).filter(
    (entry): entry is [string, string | number] =>
      entry[1] !== undefined && entry[1] !== null && entry[1] !== ""
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function unwrap<T>(response: TransportResponse): T {
  const body = record(response.body);
  if (body && body.ok === true) {
    return body.data as T;
  }
  if (body && body.ok === false) {
    const error = record(body.error);
    const code = stringOf(error?.code, "UNKNOWN").toUpperCase();
    throw new ApiError(code, stringOf(error?.message), response.status);
  }
  if (response.status === 401) {
    throw new ApiError("UNAUTHORIZED", "", response.status);
  }
  if (response.status === 403) {
    throw new ApiError("FORBIDDEN", "", response.status);
  }
  if (response.status === 429) {
    throw new ApiError("RATE_LIMIT", "", response.status);
  }
  if (response.status >= 500) {
    throw new ApiError("HTTP_ERROR", "", response.status);
  }
  if (response.status >= 400) {
    throw new ApiError(`HTTP_${response.status}`, "", response.status);
  }
  throw new ApiError("BAD_RESPONSE", "", response.status);
}

const TRANSPORT_CODES = new Set([
  "TIMEOUT",
  "PERMISSION_DENIED",
  "APP_UNLOADED",
  "USER_CANCELLED",
  "RATE_LIMIT",
  "NETWORK_ERROR",
  "OFFLINE",
]);

function toTransportError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  const raw =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown }).code
      : undefined;
  const code = typeof raw === "string" ? raw : "";
  if (TRANSPORT_CODES.has(code)) {
    return new ApiError(code, "", 0, { cause });
  }
  if (
    typeof DOMException !== "undefined" &&
    cause instanceof DOMException &&
    cause.name === "AbortError"
  ) {
    return new ApiError("TIMEOUT", "", 0, { cause });
  }
  return new ApiError("OFFLINE", "", 0, { cause });
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createApi(
  transport: Transport,
  options: { retryDelayMs?: number } = {}
): Api {
  const retryDelayMs = options.retryDelayMs ?? 650;

  async function call(
    endpoint: EndpointName,
    request: Omit<TransportRequest, "method" | "timeoutMs"> & {
      timeoutMs?: number;
    } = {}
  ): Promise<TransportResponse> {
    try {
      return await transport(endpoint, {
        method: ENDPOINTS[endpoint].method,
        query: request.query,
        json: request.json,
        timeoutMs: request.timeoutMs ?? REQUEST_TIMEOUT_MS,
      });
    } catch (cause) {
      throw toTransportError(cause);
    }
  }

  return {
    async config() {
      const response = await call("publicConfig");
      return normalizeConfig(unwrap(response));
    },

    async markets(query = {}) {
      const response = await call("publicMarkets", {
        query: compactQuery({
          id: query.id,
          status: query.status,
          limit: query.limit,
          cursor: query.cursor ?? undefined,
        }),
      });
      const data = unwrap<unknown>(response);
      const raw = record(data);
      const items = extractItems(data).map(normalizeMarket);
      if (items.length === 0 && raw && typeof raw.id === "string") {
        items.push(normalizeMarket(raw));
      }
      return {
        items,
        nextCursor: extractCursor(data),
      };
    },

    async leaderboard(query) {
      const response = await call("publicLeaderboard", {
        query: compactQuery({
          type: query.type,
          season: query.season,
          limit: query.limit,
        }),
      });
      const data = unwrap<unknown>(response);
      const raw = record(data);
      const type: LeaderboardType =
        raw?.type === "accuracy" ? "accuracy" : query.type;
      return {
        season: stringOf(raw?.season, query.season),
        type,
        items: extractItems(data).map(normalizeEntry),
      };
    },

    async me() {
      const response = await call("me");
      return normalizeMe(unwrap(response));
    },

    async claim(displayName) {
      const response = await call("claim", {
        json: displayName ? { displayName } : {},
      });
      const raw = record(unwrap<unknown>(response)) ?? {};
      return {
        claimed: raw.claimed === true,
        chips: integerOf(raw.chips),
        amount: integerOf(raw.amount),
      };
    },

    async positions(query = {}) {
      const response = await call("positions", {
        query: compactQuery({
          status: query.status,
          limit: query.limit,
          cursor: query.cursor ?? undefined,
        }),
      });
      const data = unwrap<unknown>(response);
      return {
        items: extractItems(data).map(positionOf),
        nextCursor: extractCursor(data),
      };
    },

    async history(query = {}) {
      const response = await call("history", {
        query: compactQuery({
          season: query.season,
          limit: query.limit,
          cursor: query.cursor ?? undefined,
        }),
      });
      const data = unwrap<unknown>(response);
      return {
        items: extractItems(data).map(historyOf),
        nextCursor: extractCursor(data),
      };
    },

    async placeBet(input) {
      const attempt = () =>
        call("placeBet", {
          json: input,
        }).then((response) => normalizeBet(unwrap<unknown>(response)));
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof ApiError && error.code === "OFFLINE") {
          await wait(retryDelayMs);
          return attempt();
        }
        throw error;
      }
    },

    async myRank(query) {
      const response = await call("myRank", {
        query: compactQuery({ type: query.type, season: query.season }),
      });
      const raw = record(unwrap<unknown>(response)) ?? {};
      const rank = integerOf(raw.rank, 0);
      return {
        rank: rank > 0 ? rank : null,
        samples: nullableNumber(raw.samples),
        season: nullableString(raw.season) ?? query.season,
        type: raw.type === "accuracy" ? "accuracy" : query.type,
      };
    },
  };
}
