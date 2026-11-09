import type { Market, MarketStatus, Outcome, Prefs, Side } from "./types.ts";

export type Direction = -1 | 0 | 1;

export interface StageInfo {
  direction: Direction;
  index: number;
  magnitude: number;
  intensity: number;
  label: string;
}

const STAGE_FLOORS = [0, 10, 35, 60, 85] as const;

const STAGE_LABELS = {
  positive: ["幼鲸", "小鲸", "涌鲸", "鲸王", "鲸祖"],
  negative: ["幼鲸", "潜鲸", "沉鲸", "渊鲸", "渊祖"],
} as const;

const STAGE_HINTS = {
  neutral: "中性水域，尚未选择方向",
  positive: [
    "微光在鳍边聚集",
    "潮汐回应了你的判断",
    "洋流开始为你让路",
    "深海的王座正在升温",
    "传说中的鲸祖浮出水面",
  ],
  negative: [
    "暗流在脚下缓慢移动",
    "重量开始拖住尾鳍",
    "光线在身后合拢",
    "沉入无光的深处",
    "渊祖在海底睁开眼",
  ],
} as const;

export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function confidenceMagnitude(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return clampInteger(Math.abs(confidence), 0, 100);
}

export function confidenceDirection(confidence: number): Direction {
  if (!Number.isFinite(confidence)) return 0;
  const value = Math.trunc(confidence);
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function stageIndexFor(confidence: number): number {
  const magnitude = confidenceMagnitude(confidence);
  for (let index = STAGE_FLOORS.length - 1; index >= 1; index -= 1) {
    if (magnitude >= STAGE_FLOORS[index]) return index;
  }
  return 0;
}

export function stageFor(confidence: number): StageInfo {
  const direction = confidenceDirection(confidence);
  const magnitude = confidenceMagnitude(confidence);
  const index = stageIndexFor(confidence);
  const label =
    direction < 0 ? STAGE_LABELS.negative[index] : STAGE_LABELS.positive[index];
  return {
    direction,
    index,
    magnitude,
    intensity: magnitude / 100,
    label,
  };
}

export function stageHint(direction: Direction, index: number): string {
  if (direction === 0) return STAGE_HINTS.neutral;
  const bucket = direction < 0 ? STAGE_HINTS.negative : STAGE_HINTS.positive;
  return bucket[clampInteger(index, 0, bucket.length - 1)];
}

export function sideFor(confidence: number): Side | null {
  const direction = confidenceDirection(confidence);
  if (direction === 0) return null;
  return direction > 0 ? "yes" : "no";
}

export function betLimit(chips: number, ratio: number): number {
  const safeChips = Number.isFinite(chips) && chips > 0 ? Math.floor(chips) : 0;
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  return Math.max(0, Math.floor(safeChips * safeRatio));
}

export type AmountError =
  | "INVALID_AMOUNT"
  | "BET_TOO_SMALL"
  | "BET_TOO_LARGE"
  | "CHIPS_TOO_LOW";

export interface AmountCheck {
  ok: boolean;
  amount: number;
  max: number;
  min: number;
  code?: AmountError;
}

export function validateAmount(
  raw: unknown,
  chips: number,
  betMin: number,
  maxBetRatio: number
): AmountCheck {
  const min = Number.isFinite(betMin) && betMin > 0 ? Math.floor(betMin) : 10;
  const max = betLimit(chips, maxBetRatio);
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;

  const base = { amount: parsed, max, min };
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ...base, ok: false, code: "INVALID_AMOUNT" };
  }
  if (max < min) {
    return { ...base, ok: false, code: "CHIPS_TOO_LOW" };
  }
  if (parsed < min) {
    return { ...base, ok: false, code: "BET_TOO_SMALL" };
  }
  if (parsed > max) {
    return { ...base, ok: false, code: "BET_TOO_LARGE" };
  }
  return { ...base, ok: true };
}

export function quickAmount(
  kind: "min" | "half" | "max",
  chips: number,
  betMin: number,
  maxBetRatio: number
): number {
  const min = Number.isFinite(betMin) && betMin > 0 ? Math.floor(betMin) : 10;
  const max = betLimit(chips, maxBetRatio);
  if (kind === "min") return min;
  if (kind === "half") return Math.min(max, Math.max(min, Math.floor(max / 2)));
  return Math.max(0, max);
}

export function formatConfidence(value: number): string {
  const clamped = clampInteger(value, -100, 100);
  if (clamped > 0) return `+${clamped}`;
  if (clamped < 0) return `−${Math.abs(clamped)}`;
  return "0";
}

export function applyOutcomePools(
  market: Market,
  pools: Record<string, number>
): Market {
  const outcomes = market.outcomes.map((outcome) => ({
    ...outcome,
    pool: Math.max(0, Math.floor(pools[outcome.id] ?? outcome.pool)),
  }));
  const total = outcomes.reduce((sum, outcome) => sum + outcome.pool + outcome.seed, 0);
  return {
    ...market,
    totalPool: total,
    outcomes: outcomes.map((outcome) => {
      const base = outcome.pool + outcome.seed;
      return {
        ...outcome,
        implied: total > 0 ? base / total : 1 / Math.max(1, outcomes.length),
        payout: base > 0 ? Math.round((total / base) * 100) / 100 : 1,
      };
    }),
  };
}

export function previewReturn(amount: number, multiplier: number): number {
  if (
    !Number.isFinite(amount) ||
    !Number.isFinite(multiplier) ||
    amount <= 0 ||
    multiplier <= 0
  ) {
    return 0;
  }
  return Math.floor(amount * multiplier);
}

const chipFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

export function formatChips(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return chipFormatter.format(Math.trunc(value));
}

export function formatMultiplier(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value <= 0) return "—";
  return `×${value.toFixed(2)}`;
}

export function impliedPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 50;
  }
  return clampInteger(Math.round(value * 100), 0, 100);
}

export function accuracyPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) return 0;
  if (value <= 1) return Math.min(100, Math.round(value * 100));
  return Math.min(100, Math.round(value));
}

export function formatAccuracy(value: number | null | undefined): string {
  const percent = accuracyPercent(value);
  return percent === null ? "—" : `${percent}%`;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function formatCountdown(
  target: number | null | undefined,
  now: number,
  compact = false
): string {
  if (
    target === null ||
    target === undefined ||
    !Number.isFinite(target) ||
    !Number.isFinite(now)
  ) {
    return "—";
  }
  const remaining = target - now;
  if (remaining <= 0) return "已截止";
  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return compact
      ? `${days} 天 ${pad(hours)}:${pad(minutes)}`
      : `${days} 天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return compact
    ? `${pad(hours)}:${pad(minutes)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const parts = dateTimeFormatter.formatToParts(new Date(value));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

const seasonFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
});

export function currentSeason(now = Date.now()): string {
  const parts = seasonFormatter.formatToParts(new Date(now));
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export function seasonOptions(current: string, count = 6): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(current);
  if (!match) return current ? [current] : [];
  let year = Number(match[1]);
  let month = Number(match[2]);
  const options: string[] = [];
  for (let index = 0; index < Math.max(1, count); index += 1) {
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    if (month > 12) month = 12;
    options.push(`${year}-${pad(month)}`);
    month -= 1;
  }
  return options;
}

const STATUS_PRIORITY: Record<MarketStatus, number> = {
  open: 0,
  locked: 1,
  settling: 2,
  settled: 3,
  void: 4,
};

export function sortMarkets(items: readonly Market[]): Market[] {
  return [...items].sort((left, right) => {
    const priority =
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (priority !== 0) return priority;
    if (left.status === "settled" || left.status === "void") {
      return (right.settledAt ?? 0) - (left.settledAt ?? 0);
    }
    return left.deadline - right.deadline;
  });
}

export function marketPoolTotal(market: Market): number {
  return Math.max(0, market.totalPool);
}

/** 可选的 outcome（排除 fallback 兜底项）；全为兜底时退回全部。 */
export function selectableOutcomes(market: Market): Outcome[] {
  const selectable = market.outcomes.filter(
    (outcome) => outcome.id !== market.fallbackOutcomeId
  );
  return selectable.length > 0 ? selectable : market.outcomes;
}

/** 默认选中：第一个非 fallback 结果。 */
export function defaultOutcomeId(market: Market): string | null {
  return selectableOutcomes(market)[0]?.id ?? null;
}

export function outcomeById(
  market: Market,
  id: string | null | undefined
): Outcome | null {
  if (!id) return null;
  return market.outcomes.find((outcome) => outcome.id === id) ?? null;
}

/** 按隐含概率降序取前 N 个结果（卡片摘要与共识面板）。 */
export function topOutcomes(market: Market, count = 3): Outcome[] {
  return [...market.outcomes]
    .sort((left, right) => right.implied - left.implied)
    .slice(0, Math.max(1, count));
}

/** 单个 outcome 在总池中的份额（0–1，含种子）。 */
export function outcomeShare(market: Market, outcome: Outcome): number {
  const total = market.outcomes.reduce(
    (sum, item) => sum + Math.max(0, item.pool) + Math.max(0, item.seed),
    0
  );
  if (total <= 0) {
    return market.outcomes.length > 0 ? 1 / market.outcomes.length : 0;
  }
  return (Math.max(0, outcome.pool) + Math.max(0, outcome.seed)) / total;
}

export interface OutcomeProgress {
  hitCount: number;
  firstSeenAt: number | null;
}

/** 聚合各 outcome 的观察进度，供详情时间线使用。 */
export function outcomeProgress(market: Market): OutcomeProgress {
  let hitCount = 0;
  let firstSeenAt: number | null = null;
  for (const outcome of market.outcomes) {
    if ((outcome.hitCount ?? 0) > 0) hitCount += 1;
    const seen = outcome.firstSeenAt ?? null;
    if (seen !== null && (firstSeenAt === null || seen < firstSeenAt)) {
      firstSeenAt = seen;
    }
  }
  return { hitCount, firstSeenAt };
}

export function betIntentKey(
  marketId: string,
  outcomeId: string,
  amount: number,
  confidence: number
): string {
  return `${marketId}|${outcomeId}|${amount}|${confidence}`;
}

export function defaultPrefs(): Prefs {
  return {
    tab: "markets",
    lastMarketId: null,
    lastOutcomeId: null,
    confidence: 0,
    amount: null,
    theme: "abyss",
  };
}
