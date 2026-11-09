import { describe, expect, test } from "bun:test";
import {
  CACHE_KEYS,
  CacheStore,
  type StorageLike,
} from "../src/cache.ts";

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  failReads = false;
  failWrites = false;
  reads: string[] = [];

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("read denied");
    this.reads.push(key);
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("write denied");
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("CacheStore", () => {
  test("writes envelopes under the whale prefix", () => {
    const storage = new MemoryStorage();
    let now = 1000;
    const cache = new CacheStore(storage, { now: () => now });
    expect(cache.write(CACHE_KEYS.markets, { items: [1, 2] })).toBe(true);
    const raw = storage.data.get("whale:v1:cache:markets");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ v: 1, at: 1000 });
    now = 2000;
    const read = cache.read<{ items: number[] }>(CACHE_KEYS.markets, 5000);
    expect(read).toMatchObject({ value: { items: [1, 2] }, age: 1000, stale: false });
  });

  test("keeps stale values instead of deleting them", () => {
    const storage = new MemoryStorage();
    let now = 0;
    const cache = new CacheStore(storage, { now: () => now });
    cache.write(CACHE_KEYS.config, { season: "2026-11" });
    now = 600_000;
    const read = cache.read<{ season: string }>(CACHE_KEYS.config, 600_000);
    expect(read?.stale).toBe(true);
    expect(read?.value.season).toBe("2026-11");
    expect(storage.data.size).toBe(1);
  });

  test("persistent reads ignore ttl", () => {
    const storage = new MemoryStorage();
    let now = 10;
    const cache = new CacheStore(storage, { now: () => now });
    cache.write(CACHE_KEYS.prefs, { tab: "me" });
    now = 10_000_000;
    expect(cache.read<{ tab: string }>(CACHE_KEYS.prefs)?.stale).toBe(false);
  });

  test("drops malformed payloads and unknown envelope versions", () => {
    const storage = new MemoryStorage();
    const cache = new CacheStore(storage, { now: () => 1 });
    storage.data.set("whale:v1:cache:markets", "{not json");
    expect(cache.read(CACHE_KEYS.markets)).toBeNull();
    expect(storage.data.has("whale:v1:cache:markets")).toBe(false);

    storage.data.set(
      "whale:v1:cache:markets",
      JSON.stringify({ v: 2, at: 1, data: { items: [] } })
    );
    expect(cache.read(CACHE_KEYS.markets)).toBeNull();
    expect(storage.data.has("whale:v1:cache:markets")).toBe(false);
  });

  test("survives unavailable storage", () => {
    const cache = new CacheStore(null);
    expect(cache.read("cache:markets")).toBeNull();
    expect(cache.write("cache:markets", [])).toBe(false);
    expect(() => cache.remove("cache:markets")).not.toThrow();

    const broken = new MemoryStorage();
    broken.failReads = true;
    broken.failWrites = true;
    const brokenCache = new CacheStore(broken, { now: () => 1 });
    expect(brokenCache.read("cache:me")).toBeNull();
    expect(brokenCache.write("cache:me", {})).toBe(false);
    expect(() => brokenCache.remove("cache:me")).not.toThrow();
  });

  test("isolates prefixes", () => {
    const storage = new MemoryStorage();
    const first = new CacheStore(storage, { prefix: "a:" });
    const second = new CacheStore(storage, { prefix: "b:" });
    first.write("x", 1);
    expect(second.read("x")).toBeNull();
    expect(storage.reads.at(-1)).toBe("b:x");
  });

  test("removes values explicitly", () => {
    const storage = new MemoryStorage();
    const cache = new CacheStore(storage);
    cache.write("draft:bet", { marketId: "m1" });
    cache.remove("draft:bet");
    expect(cache.read("draft:bet")).toBeNull();
  });
});
