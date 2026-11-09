// 测试环境：应用迁移后的内存 D1 + 合成 Env。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryD1 } from './d1';
import type { Env } from '../../src/types';

const migrationsDir = join(import.meta.dir, '..', '..', 'migrations');

export function loadMigrations(db: MemoryD1, files: string[]): void {
  for (const f of files) {
    db.applySchema(readFileSync(join(migrationsDir, f), 'utf-8'));
  }
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; db: MemoryD1 } {
  const db = new MemoryD1();
  loadMigrations(db, ['0001_init.sql', '0002_guards.sql', '0003_outcomes.sql', '0004_seed_markets.sql']);
  const env: Env = {
    DB: db as unknown as Env['DB'],
    DEEPSEEK_API_KEY: 'test-deepseek-key',
    ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
    PLATFORM_ISSUER: 'https://linux.do',
    PLATFORM_APP_ID: 'test-app-id',
    PLATFORM_AUDIENCE: 'https://whale.example.com',
    ALLOWED_ORIGINS: 'https://linux.do,https://preview.linux.do',
    DEEPSEEK_MODELS_URL: 'https://api.deepseek.com/models',
    ...overrides,
  };
  return { env, db };
}

/** 清除 0004 种子市场与 outcomes（需要空库隔离的测试用）。 */
export function clearSeedMarkets(db: MemoryD1): void {
  db.inner.exec('DELETE FROM outcomes; DELETE FROM markets;');
}
