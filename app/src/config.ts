/**
 * Change API_ORIGIN here before building for a real deployment.
 * scripts/package.ts reads this exact constant and rewrites manifest.json.
 */
export const API_ORIGIN = "https://mapp-whale.pj568.eu.org";

export const REQUEST_TIMEOUT_MS = 12_000;
export const STORAGE_PREFIX = "whale:v1:";

export const ENDPOINTS = {
  publicConfig: { method: "GET", path: "/public/config" },
  publicMarkets: { method: "GET", path: "/public/markets" },
  publicLeaderboard: { method: "GET", path: "/public/leaderboard" },
  me: { method: "GET", path: "/me" },
  claim: { method: "POST", path: "/me/claim" },
  positions: { method: "GET", path: "/me/positions" },
  history: { method: "GET", path: "/me/history" },
  placeBet: { method: "POST", path: "/bets" },
  myRank: { method: "GET", path: "/me/rank" },
} as const satisfies Record<
  string,
  { method: "GET" | "POST"; path: string }
>;

export type EndpointName = keyof typeof ENDPOINTS;

export const FALLBACK_CONFIG = {
  productName: "预言鲸",
  season: "",
  betMin: 10,
  maxBetRatio: 0.5,
  dailyChips: 100,
  initialChips: 1000,
  serverTime: 0,
} as const;

export const CACHE_TTL = {
  config: 10 * 60_000,
  markets: 60_000,
  leaderboard: 60_000,
  me: 30_000,
} as const;

export const PAGE_SIZE = 20;
