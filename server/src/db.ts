// D1 helpers、config 读取（表值 → 代码默认）、用户初始化、Asia/Shanghai 日期。

import type { Env, UserRow } from './types';

export interface AppConfig {
  product_name: string;
  season: string;
  initial_chips: number;
  daily_chips: number;
  bet_min: number;
  max_bet_ratio: number;
  seed_per_side: number;
  models_url: string;
  poll_confirmations: number;
  accuracy_min_samples: number;
  page_size: number;
  retain_bet_seasons: number;
  retain_ledger_days: number;
  retain_audit_days: number;
}

export const CONFIG_VALUE_KEYS: readonly (keyof AppConfig)[] = [
  'product_name',
  'season',
  'initial_chips',
  'daily_chips',
  'bet_min',
  'max_bet_ratio',
  'seed_per_side',
  'models_url',
  'poll_confirmations',
  'accuracy_min_samples',
  'page_size',
  'retain_bet_seasons',
  'retain_ledger_days',
  'retain_audit_days',
];

const STRING_KEYS: ReadonlySet<keyof AppConfig> = new Set(['product_name', 'season', 'models_url']);

// ---- Asia/Shanghai 时间 ----

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Asia/Shanghai 的 YYYY-MM-DD。 */
export function shanghaiDate(ms: number): string {
  return dateFmt.format(new Date(ms));
}

/** Asia/Shanghai 的 YYYY-MM（赛季）。 */
export function shanghaiMonth(ms: number): string {
  return shanghaiDate(ms).slice(0, 7);
}

/** 下一个 Asia/Shanghai 零点的 epoch ms（每日补给的 nextClaimAt）。 */
export function shanghaiNextMidnight(ms: number): number {
  const today = shanghaiDate(ms);
  // 12:00 UTC = 上海 20:00 当天不会越过次日；用逐小时推进找次日零点。
  let t = ms;
  for (let i = 0; i < 25; i++) {
    t += 60 * 60 * 1000;
    if (shanghaiDate(t) !== today) {
      // 回退到该小时内零点附近再精确到分钟
      let lo = t - 60 * 60 * 1000;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (shanghaiDate(mid) !== today) hi = mid;
        else lo = mid;
      }
      return hi;
    }
  }
  return ms;
}

// ---- config ----

export function defaultConfig(env: Env, now: number): AppConfig {
  return {
    product_name: '预言鲸',
    season: shanghaiMonth(now),
    initial_chips: 1000,
    daily_chips: 100,
    bet_min: 10,
    max_bet_ratio: 0.5,
    seed_per_side: 5000,
    models_url: env.DEEPSEEK_MODELS_URL ?? 'https://api.deepseek.com/models',
    poll_confirmations: 2,
    accuracy_min_samples: 5,
    page_size: 20,
    retain_bet_seasons: 2,
    retain_ledger_days: 90,
    retain_audit_days: 180,
  };
}

/** 每次请求从 config 表读取（允许热改），缺失的键回退到代码默认值。 */
export async function getConfig(env: Env, now: number): Promise<AppConfig> {
  const cfg = defaultConfig(env, now);
  const { results } = await env.DB.prepare('SELECT key, value FROM config').all<{
    key: string;
    value: string;
  }>();
  for (const row of results) {
    const key = row.key as keyof AppConfig;
    if (!CONFIG_VALUE_KEYS.includes(key)) continue;
    if (STRING_KEYS.has(key)) {
      (cfg[key] as string) = row.value;
    } else {
      const num = Number(row.value);
      if (Number.isFinite(num)) (cfg[key] as number) = num;
    }
  }
  return cfg;
}

export async function setConfigValue(env: Env, key: string, value: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
    .bind(key, value, now)
    .run();
}

// ---- 用户 ----

export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 只做长度和字符过滤：去掉控制字符与空白首尾，最长 24 字符。
  const cleaned = raw.replace(/\p{C}/gu, '').trim();
  if (cleaned.length === 0) return null;
  return [...cleaned].slice(0, 24).join('');
}

export function userKeyOf(iss: string, sub: string): string {
  return `${iss}#${sub}`;
}

/**
 * 用户初始化：首次请求发放 initial_chips，幂等（INSERT OR IGNORE + 变更判定）。
 */
export async function ensureUser(
  env: Env,
  userKey: string,
  displayName: unknown,
  cfg: AppConfig,
  now: number,
): Promise<UserRow> {
  const name = sanitizeDisplayName(displayName);
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO users (user_key, display_name, chips, last_claim_day, created_at, updated_at) ' +
      'VALUES (?, ?, ?, NULL, ?, ?)',
  )
    .bind(userKey, name, cfg.initial_chips, now, now)
    .run();
  if ((inserted.meta.changes ?? 0) > 0) {
    await env.DB.prepare(
      'INSERT INTO ledger (user_key, market_id, bet_id, delta, reason, season, created_at) ' +
        'VALUES (?, NULL, NULL, ?, ?, ?, ?)',
    )
      .bind(userKey, cfg.initial_chips, 'claim', cfg.season, now)
      .run();
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE user_key = ?')
    .bind(userKey)
    .first<UserRow>();
  if (!row) throw new Error('user row missing after ensureUser');
  return row;
}

export async function writeAudit(
  env: Env,
  action: string,
  actor: string,
  target: string | null,
  detail: string | null,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit (action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(action, actor, target, detail, now)
    .run();
}

/** season_stats 累加 upsert（下注 / 派奖共用）。 */
export function upsertSeasonStats(
  env: Env,
  season: string,
  userKey: string,
  delta: { startChips?: number; endChips: number; staked?: number; payout?: number; correct?: number; total?: number },
): D1PreparedStatement {
  const startChips = delta.startChips ?? delta.endChips;
  return env.DB.prepare(
    'INSERT INTO season_stats (season, user_key, start_chips, end_chips, staked, payout, correct, total, peak_chips) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(season, user_key) DO UPDATE SET ' +
      'end_chips = excluded.end_chips, ' +
      'staked = staked + excluded.staked, ' +
      'payout = payout + excluded.payout, ' +
      'correct = correct + excluded.correct, ' +
      'total = total + excluded.total, ' +
      'peak_chips = MAX(peak_chips, excluded.peak_chips)',
  ).bind(
    season,
    userKey,
    startChips,
    delta.endChips,
    delta.staked ?? 0,
    delta.payout ?? 0,
    delta.correct ?? 0,
    delta.total ?? 0,
    delta.endChips,
  );
}
