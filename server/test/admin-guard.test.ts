// 管理端守卫：config 数值范围校验（越界 INVALID_CONFIG）与 ADMIN_TOKEN 强度要求。
import { describe, expect, test } from 'bun:test';
import { handleAdminPatchConfig, requireAdmin } from '../src/routes/admin';
import { makeEnv } from './helpers/env';

const NOW = Date.now();

describe('PATCH /admin/config 数值范围校验', () => {
  const rejected: [string, Record<string, unknown>][] = [
    ['max_bet_ratio = 0 被拒', { max_bet_ratio: 0 }],
    ['max_bet_ratio = 1.5 被拒', { max_bet_ratio: 1.5 }],
    ['max_bet_ratio = -0.1 被拒', { max_bet_ratio: -0.1 }],
    ['max_bet_ratio 非数字字符串被拒', { max_bet_ratio: 'abc' }],
    ['bet_min = 0 被拒', { bet_min: 0 }],
    ['bet_min = -5 被拒', { bet_min: -5 }],
    ['seed_per_side = -1 被拒', { seed_per_side: -1 }],
    ['retain_bet_seasons = 0 被拒', { retain_bet_seasons: 0 }],
    ['daily_chips = -1 被拒', { daily_chips: -1 }],
    ['initial_chips = -1 被拒', { initial_chips: -1 }],
    ['poll_confirmations = 0 被拒', { poll_confirmations: 0 }],
  ];

  test.each(rejected)('%s', async (_name, patch) => {
    const { env, db } = makeEnv();
    await expect(handleAdminPatchConfig(env, patch, NOW)).rejects.toThrow('INVALID_CONFIG');
    // 越界值不落库：config 表保持种子值。
    for (const key of Object.keys(patch)) {
      const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
      expect(row?.value).not.toBe(String(patch[key]));
    }
  });

  test('混合合法与越界：整批拒绝，合法项也不落库', async () => {
    const { env, db } = makeEnv();
    await expect(
      handleAdminPatchConfig(env, { daily_chips: 200, bet_min: 0 }, NOW),
    ).rejects.toThrow('INVALID_CONFIG');
    const daily = await db.prepare("SELECT value FROM config WHERE key = 'daily_chips'").first<{ value: string }>();
    expect(daily?.value).toBe('100');
    const betMin = await db.prepare("SELECT value FROM config WHERE key = 'bet_min'").first<{ value: string }>();
    expect(betMin?.value).toBe('10');
  });

  test('边界值全部合法：写入成功并生效', async () => {
    const { env } = makeEnv();
    const cfg = (await handleAdminPatchConfig(
      env,
      {
        max_bet_ratio: 1,
        bet_min: 1,
        seed_per_side: 0,
        retain_bet_seasons: 1,
        daily_chips: 0,
        initial_chips: 0,
        poll_confirmations: 1,
      },
      NOW,
    )) as Record<string, unknown>;
    expect(cfg.max_bet_ratio).toBe(1);
    expect(cfg.bet_min).toBe(1);
    expect(cfg.seed_per_side).toBe(0);
    expect(cfg.retain_bet_seasons).toBe(1);
    expect(cfg.daily_chips).toBe(0);
    expect(cfg.initial_chips).toBe(0);
    expect(cfg.poll_confirmations).toBe(1);
  });

  test('合法值正常写入', async () => {
    const { env } = makeEnv();
    const cfg = (await handleAdminPatchConfig(env, { bet_min: 5, daily_chips: 200, max_bet_ratio: 0.8 }, NOW)) as Record<string, unknown>;
    expect(cfg.bet_min).toBe(5);
    expect(cfg.daily_chips).toBe(200);
    expect(cfg.max_bet_ratio).toBe(0.8);
  });
});

describe('requireAdmin ADMIN_TOKEN 强度校验', () => {
  function req(token: string): Request {
    return new Request('https://whale.example.com/admin/config', {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  test('空串配置：空 Bearer 被拒', async () => {
    const { env } = makeEnv({ ADMIN_TOKEN: '' });
    await expect(requireAdmin(req(''), env)).rejects.toThrow('UNAUTHORIZED');
  });

  test('短 token（< 32）：即使 token 正确也一律被拒', async () => {
    for (const token of ['short-token', 'a'.repeat(31)]) {
      const { env } = makeEnv({ ADMIN_TOKEN: token });
      await expect(requireAdmin(req(token), env)).rejects.toThrow('UNAUTHORIZED');
    }
  });

  test('未配置（undefined）：任何请求被拒', async () => {
    const { env } = makeEnv({ ADMIN_TOKEN: undefined });
    await expect(requireAdmin(req('anything'), env)).rejects.toThrow('UNAUTHORIZED');
  });

  test('长度 32 的正确 token 可通过', async () => {
    const token = 'a'.repeat(32);
    const { env } = makeEnv({ ADMIN_TOKEN: token });
    await expect(requireAdmin(req(token), env)).resolves.toBeUndefined();
  });

  test('长度 32 但值不匹配被拒', async () => {
    const { env } = makeEnv({ ADMIN_TOKEN: 'a'.repeat(32) });
    await expect(requireAdmin(req('b'.repeat(32)), env)).rejects.toThrow('UNAUTHORIZED');
  });
});
