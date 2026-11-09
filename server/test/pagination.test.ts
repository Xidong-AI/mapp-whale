// 分页游标：/public/markets 带 cursor 不带 status 不报 500；/me/positions 第二页不丢数据。
import { describe, expect, test } from 'bun:test';
import { handlePublicMarkets } from '../src/routes/public';
import { handlePositions } from '../src/routes/me';
import { handlePlaceBet } from '../src/routes/bets';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';

const ISS = 'https://linux.do';
const SUB = '10001';
const USER_KEY = `${ISS}#${SUB}`;
const NOW = Date.now();

async function seedMarket(db: MemoryD1, id: string, createdAt: number): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, condition_json, deadline, status, seed_yes, seed_no, created_at, updated_at) " +
        "VALUES (?, 'T', '', '{}', ?, 'open', 0, 0, ?, ?)",
    )
    .run(id, NOW + 86_400_000, createdAt, createdAt);
}

describe('GET /public/markets 分页', () => {
  test('cursor 存在且不带 status：正常翻页不报 500', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, 'm1', NOW);
    await seedMarket(db, 'm2', NOW + 1);
    await seedMarket(db, 'm3', NOW + 2);

    const url = (q: string) => new URL(`https://whale.example.com/public/markets?${q}`);
    const page1 = (await handlePublicMarkets(env, url('limit=2'), NOW)) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page1.items.map((i) => i.id)).toEqual(['m3', 'm2']);
    expect(page1.nextCursor).toBe('m2');

    // 修复前：无 status 时 SQL 拼成 `FROM markets AND (...)` 抛 500。
    const page2 = (await handlePublicMarkets(env, url(`cursor=${page1.nextCursor}&limit=2`), NOW)) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page2.items.map((i) => i.id)).toEqual(['m1']);
    expect(page2.nextCursor).toBeNull();
  });

  test('cursor + status 组合仍正常', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, 'm1', NOW);
    await db.inner.prepare("UPDATE markets SET status = 'settled', updated_at = ? WHERE id = 'm1'").run(NOW);
    await seedMarket(db, 'm2', NOW + 1);
    await db.inner.prepare("UPDATE markets SET status = 'settled', updated_at = ? WHERE id = 'm2'").run(NOW);

    const url = new URL(`https://whale.example.com/public/markets?status=settled&cursor=m2`);
    const page = (await handlePublicMarkets(env, url, NOW)) as { items: { id: string }[]; nextCursor: string | null };
    expect(page.items.map((i) => i.id)).toEqual(['m1']);
    expect(page.nextCursor).toBeNull();
  });
});

describe('GET /me/positions 分页', () => {
  async function seedUserBets(env: ReturnType<typeof makeEnv>['env'], marketIds: string[], createdAt: number): Promise<void> {
    for (const marketId of marketIds) {
      await handlePlaceBet(
        env,
        ISS,
        SUB,
        null,
        { marketId, side: 'yes', amount: 100, confidence: 0, clientRequestId: `req_${marketId}` },
        createdAt,
      );
    }
  }

  test('同一 created_at 多个市场：第二页不丢数据、不重复', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, 'm1', NOW);
    await seedMarket(db, 'm2', NOW + 1);
    await seedMarket(db, 'm3', NOW + 2);
    await seedUserBets(env, ['m1', 'm2', 'm3'], NOW);

    const url = (q: string) => new URL(`https://whale.example.com/me/positions?${q}`);
    const page1 = (await handlePositions(env, USER_KEY, null, url('limit=2'), NOW)) as {
      items: { marketId: string; amount: number }[];
      nextCursor: string | null;
    };
    expect(page1.items.map((i) => i.marketId)).toEqual(['m3', 'm2']);
    expect(page1.nextCursor).toBe('m2');

    // 修复前：cursor(market_id) 被当成 bet id 去查 bets.id，子查询为 NULL，第二页恒为空。
    const page2 = (await handlePositions(env, USER_KEY, null, url(`limit=2&cursor=${page1.nextCursor}`), NOW)) as {
      items: { marketId: string; amount: number }[];
      nextCursor: string | null;
    };
    expect(page2.items.map((i) => i.marketId)).toEqual(['m1']);
    expect(page2.nextCursor).toBeNull();

    // 修复前的另一症状：cursor 指向的组（m2）在第二页重复出现。
    const all = [...page1.items, ...page2.items].map((i) => i.marketId);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  test('跨 created_at 翻页：按（组内最大下注时间，market_id）定位', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, 'm1', NOW);
    await seedMarket(db, 'm2', NOW + 1);
    await seedMarket(db, 'm3', NOW + 1);
    // m1 下注更早，m2/m3 同一时间。
    await seedUserBets(env, ['m1'], NOW);
    await seedUserBets(env, ['m2', 'm3'], NOW + 10_000);

    const url = (q: string) => new URL(`https://whale.example.com/me/positions?${q}`);
    const page1 = (await handlePositions(env, USER_KEY, null, url('limit=2'), NOW)) as {
      items: { marketId: string }[];
      nextCursor: string | null;
    };
    expect(page1.items.map((i) => i.marketId)).toEqual(['m3', 'm2']);
    const page2 = (await handlePositions(env, USER_KEY, null, url(`limit=2&cursor=${page1.nextCursor}`), NOW)) as {
      items: { marketId: string }[];
      nextCursor: string | null;
    };
    expect(page2.items.map((i) => i.marketId)).toEqual(['m1']);
    expect(page2.nextCursor).toBeNull();
  });

  test('组内多注聚合为一行：amount / payout 汇总正确', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, 'm1', NOW);
    await seedUserBets(env, ['m1'], NOW);
    await handlePlaceBet(
      env,
      ISS,
      SUB,
      null,
      { marketId: 'm1', side: 'yes', amount: 50, confidence: 0, clientRequestId: 'req_m1_again' },
      NOW + 1,
    );

    const page = (await handlePositions(env, USER_KEY, null, new URL('https://whale.example.com/me/positions'), NOW)) as {
      items: { marketId: string; amount: number }[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.amount).toBe(150);
    expect(page.nextCursor).toBeNull();
  });

  test('cursor 指向不存在的组：NOT_FOUND', async () => {
    const { env } = makeEnv();
    const url = new URL('https://whale.example.com/me/positions?cursor=missing');
    await expect(handlePositions(env, USER_KEY, null, url, NOW)).rejects.toThrow('NOT_FOUND');
  });
});
