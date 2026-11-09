import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { t } from "../src/copy.ts";

const root = join(import.meta.dir, "..");

function walk(directory: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) output.push(...walk(path));
    else output.push(path);
  }
  return output;
}

const sourceFiles = walk(join(root, "src")).filter((path) =>
  /\.(ts|json|html|css)$/.test(path)
);
const sourceText = sourceFiles
  .map((path) => `${relative(root, path)}\n${readFileSync(path, "utf8")}`)
  .join("\n");
const template = readFileSync(join(root, "src/template.html"), "utf8");
const style = readFileSync(join(root, "src/style.css"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(root, "manifest.json"), "utf8")
) as {
  format: number;
  id: string;
  version: string;
  entry: string;
  script: string;
  style: string;
  permissions: string[];
  endpoints: Record<
    string,
    {
      url: string;
      method: string;
      auth?: string;
      query?: string[];
    }
  >;
};
const configSource = readFileSync(join(root, "src/config.ts"), "utf8");

describe("contract endpoints", () => {
  const expected: Record<
    string,
    { method: string; path: string; auth: string; query: string[] }
  > = {
    publicConfig: {
      method: "GET",
      path: "/public/config",
      auth: "none",
      query: [],
    },
    publicMarkets: {
      method: "GET",
      path: "/public/markets",
      auth: "none",
      query: ["id", "status", "limit", "cursor"],
    },
    publicLeaderboard: {
      method: "GET",
      path: "/public/leaderboard",
      auth: "none",
      query: ["type", "season", "limit"],
    },
    me: { method: "GET", path: "/me", auth: "platform", query: [] },
    claim: { method: "POST", path: "/me/claim", auth: "platform", query: [] },
    positions: {
      method: "GET",
      path: "/me/positions",
      auth: "platform",
      query: ["status", "limit", "cursor"],
    },
    history: {
      method: "GET",
      path: "/me/history",
      auth: "platform",
      query: ["season", "limit", "cursor"],
    },
    placeBet: { method: "POST", path: "/bets", auth: "platform", query: [] },
    myRank: {
      method: "GET",
      path: "/me/rank",
      auth: "platform",
      query: ["type", "season"],
    },
  };

  test("manifest declares exactly the contract endpoints", () => {
    expect(Object.keys(manifest.endpoints).sort()).toEqual(
      Object.keys(expected).sort()
    );
    for (const [name, spec] of Object.entries(expected)) {
      const endpoint = manifest.endpoints[name];
      const parsed = new URL(endpoint.url);
      expect(endpoint.method).toBe(spec.method);
      expect(parsed.pathname).toBe(spec.path);
      expect(endpoint.auth).toBe(spec.auth);
      expect(endpoint.query ?? []).toEqual(spec.query);
    }
  });

  test("config defines a valid https API origin", () => {
    const origin = /export const API_ORIGIN = "([^"]+)"/.exec(configSource)?.[1];
    expect(origin).toMatch(/^https:\/\/[^/]+$/);
    for (const endpoint of Object.values(manifest.endpoints)) {
      expect(endpoint.url.startsWith("https://")).toBe(true);
    }
  });

  test("manifest identity and permissions match the contract", () => {
    expect(manifest.format).toBe(1);
    expect(manifest.id).toBe("00000000-0000-7000-8000-000000000000");
    expect(manifest.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.entry).toBe("index.html");
    expect(manifest.script).toBe("app.js");
    expect(manifest.style).toBe("app.css");
    expect([...manifest.permissions].sort()).toEqual(
      [
        "network.request",
        "storage.read",
        "storage.write",
        "theme.read",
        "user.read",
      ].sort()
    );
  });
});

describe("copy and markup", () => {
  test("every data-text key resolves", () => {
    const keys = new Set<string>();
    for (const match of template.matchAll(/data-text="([^"]+)"/g)) {
      keys.add(match[1]);
    }
    for (const match of template.matchAll(/data-aria-label="([^"]+)"/g)) {
      keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(30);
    const missing = [...keys].filter((key) => t(key) === key);
    expect(missing).toEqual([]);
  });

  test("interpolates placeholders", () => {
    expect(t("markets.deadlineLeft", { time: "01:00" })).toBe("剩余 01:00");
    expect(t("me.claim", { amount: 100 })).toBe("领取 100 鲸珠");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  test("template has no scripts, inline styles or event attributes", () => {
    expect(template).not.toMatch(/<script[\s>]/i);
    expect(template).not.toMatch(/\sstyle\s*=/i);
    expect(template).not.toMatch(/\son[a-z]+\s*=/i);
    expect(template.toLowerCase()).not.toContain("javascript:");
    expect(template).not.toMatch(/https?:\/\//i);
  });

  test("styles and markup load no remote assets", () => {
    expect(style).not.toMatch(/@import/i);
    expect(style).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(template).not.toMatch(/<link[\s>]/i);
    expect(template).not.toMatch(/<img[^>]+src=["']https?:/i);
  });

  test("no alert and no innerHTML in the runtime", () => {
    expect(sourceText).not.toMatch(/\balert\s*\(/);
    expect(sourceText).not.toMatch(/\.innerHTML\b/);
  });

  test("no prohibited copy terms appear in the app", () => {
    const banned = [
      "赌",
      "下注",
      "押注",
      "赌博",
      "赔率",
      "盘口",
      "开奖",
      "派彩",
      "赌池",
      "买大",
      "买小",
      "余额宝",
      "现金",
    ];
    const hits = banned.filter((term) => sourceText.includes(term));
    expect(hits).toEqual([]);
  });

  test("offline and error states have explicit copy", () => {
    for (const key of [
      "errors.offline",
      "errors.timeout",
      "markets.emptyTitle",
      "markets.errorTitle",
      "leaderboard.emptyTitle",
      "me.positionsEmpty",
      "me.guestTitle",
    ]) {
      expect(t(key)).not.toBe(key);
    }
  });
});
