// 每日领取（契约 7.2）：同日幂等、跨日可领、Asia/Shanghai 边界。
import { describe, expect, test } from 'bun:test';
import { handleClaim } from '../src/routes/me';
import { shanghaiDate, shanghaiMonth } from '../src/db';
import { makeEnv } from './helpers/env';

const ISS = 'https://linux.do';
const SUB = '10001';
const USER_KEY = `${ISS}#${SUB}`;

// 上海时区 = UTC+8（无夏令时）。
const beforeMidnightUTC = Date.UTC(2026, 0, 1, 15, 59, 0); // 上海 2026-01-01 23:59
const afterMidnightUTC = Date.UTC(2026, 0, 1, 16, 1, 0); // 上海 2026-01-02 00:01

describe('shanghaiDate / shanghaiMonth', () => {
  test('UTC 15:59 与 16:01 分属两天', () => {
    expect(shanghaiDate(beforeMidnightUTC)).toBe('2026-01-01');
    expect(shanghaiDate(afterMidnightUTC)).toBe('2026-01-02');
  });
  test('月份边界', () => {
    expect(shanghaiMonth(Date.UTC(2026, 10, 30, 16, 0, 0))).toBe('2026-12');
    expect(shanghaiMonth(Date.UTC(2026, 0, 1, 15, 0, 0))).toBe('2026-01');
  });
});

describe('POST /me/claim', () => {
  test('首次领取 initial + daily，返回 claimed: true', async () => {
    const { env, db } = makeEnv();
    const r = (await handleClaim(env, USER_KEY, '鲸鱼 A', beforeMidnightUTC)) as {
      claimed: boolean;
      chips: number;
      amount: number;
    };
    expect(r.claimed).toBe(true);
    expect(r.amount).toBe(100);
    expect(r.chips).toBe(1100); // initial 1000 + daily 100

    const user = await db.prepare('SELECT chips, last_claim_day FROM users WHERE user_key = ?')
      .bind(USER_KEY)
      .first<{ chips: number; last_claim_day: string }>();
    expect(user?.last_claim_day).toBe('2026-01-01');
  });

  test('同日重复领取幂等', async () => {
    const { env } = makeEnv();
    await handleClaim(env, USER_KEY, null, beforeMidnightUTC);
    const r = (await handleClaim(env, USER_KEY, null, beforeMidnightUTC + 30_000)) as {
      claimed: boolean;
      chips: number;
    };
    expect(r.claimed).toBe(false);
    expect(r.chips).toBe(1100);
  });

  test('跨日（上海时间）可再领', async () => {
    const { env } = makeEnv();
    await handleClaim(env, USER_KEY, null, beforeMidnightUTC);
    const r = (await handleClaim(env, USER_KEY, null, afterMidnightUTC)) as {
      claimed: boolean;
      chips: number;
    };
    expect(r.claimed).toBe(true);
    expect(r.chips).toBe(1200);
  });

  test('UTC 边界：UTC 当天未变但上海已跨日', async () => {
    const { env } = makeEnv();
    // 上海 2026-01-01 23:59 领取
    await handleClaim(env, USER_KEY, null, beforeMidnightUTC);
    // UTC 同日 16:01，但上海已是 1 月 2 日 → 可领
    const r = (await handleClaim(env, USER_KEY, null, afterMidnightUTC)) as { claimed: boolean };
    expect(r.claimed).toBe(true);
  });
});
