import { STORAGE_PREFIX } from "./config.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CacheRead<T> {
  value: T;
  age: number;
  stale: boolean;
}

interface Envelope<T> {
  v: 1;
  at: number;
  data: T;
}

export const CACHE_KEYS = {
  prefs: "prefs",
  draft: "draft:bet",
  config: "cache:config",
  markets: "cache:markets",
  leaderboard: "cache:leaderboard",
  me: "cache:me",
  seenVersion: "seen:version",
} as const;

export class CacheStore {
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly prefix: string;

  constructor(
    storage: StorageLike | null,
    options: { now?: () => number; prefix?: string } = {}
  ) {
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
    this.prefix = options.prefix ?? STORAGE_PREFIX;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  read<T>(key: string, ttlMs?: number): CacheRead<T> | null {
    if (!this.storage) return null;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.fullKey(key));
    } catch {
      return null;
    }
    if (raw === null) return null;
    let envelope: Envelope<T>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { v?: unknown }).v !== 1 ||
        !("data" in parsed)
      ) {
        this.remove(key);
        return null;
      }
      envelope = parsed as Envelope<T>;
    } catch {
      this.remove(key);
      return null;
    }
    const at = Number(envelope.at);
    const age = Number.isFinite(at) ? Math.max(0, this.now() - at) : Number.POSITIVE_INFINITY;
    const stale =
      typeof ttlMs === "number" && Number.isFinite(ttlMs)
        ? age >= ttlMs
        : false;
    return { value: envelope.data, age, stale };
  }

  write<T>(key: string, value: T): boolean {
    if (!this.storage) return false;
    try {
      const envelope: Envelope<T> = { v: 1, at: this.now(), data: value };
      this.storage.setItem(this.fullKey(key), JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.fullKey(key));
    } catch {
      // Storage can be unavailable in privacy modes; caching is optional.
    }
  }
}

export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${STORAGE_PREFIX}probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function createCache(
  storage: StorageLike | null,
  options: { now?: () => number; prefix?: string } = {}
): CacheStore {
  return new CacheStore(storage, options);
}
