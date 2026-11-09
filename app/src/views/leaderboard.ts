import { CACHE_KEYS } from "../cache.ts";
import { CACHE_TTL } from "../config.ts";
import type { AppContext } from "../context.ts";
import { t } from "../copy.ts";
import { byId, clear, el, makeButton, setText, show } from "../dom.ts";
import { describeError } from "../errors.ts";
import {
  currentSeason,
  formatAccuracy,
  formatChips,
  formatDateTime,
  seasonOptions,
} from "../logic.ts";
import type {
  LeaderboardEntry,
  LeaderboardType,
  MyRank,
} from "../types.ts";

export interface LeaderboardView {
  show(): void;
  load(force?: boolean): Promise<void>;
}

interface CachedBoard {
  type: LeaderboardType;
  season: string;
  items: LeaderboardEntry[];
}

function initial(name: string): string {
  const trimmed = name.trim();
  return (trimmed ? Array.from(trimmed)[0] : undefined) ?? "鲸";
}

export function createLeaderboardView(ctx: AppContext): LeaderboardView {
  const typeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#board-types [data-board]")
  );
  const seasonTabs = byId("season-tabs");
  const myRankBox = byId("my-rank");
  const myRankValue = byId("my-rank-value");
  const myRankHint = byId("my-rank-hint");
  const podium = byId("podium");
  const rankList = byId("rank-list");
  const loadingEl = byId("leaderboard-loading");
  const emptyEl = byId("leaderboard-empty");
  const errorEl = byId("leaderboard-error");
  const errorText = byId("leaderboard-error-text");
  const errorRetry = byId<HTMLButtonElement>("leaderboard-error-retry");
  const refreshButton = byId<HTMLButtonElement>("leaderboard-refresh");
  const eyebrow = byId("leaderboard-eyebrow");

  let type: LeaderboardType = "assets";
  let season = ctx.getConfig().season || currentSeason();
  let seasonTouched = false;
  let items: LeaderboardEntry[] = [];
  let myRank: MyRank | null = null;
  let rankFailed = false;
  let loading = false;
  let error: string | null = null;
  let lastFetch = 0;
  let loadingKey: string | null = null;
  let token = 0;
  let rankToken = 0;

  function isMe(entry: LeaderboardEntry): boolean {
    if (!ctx.isSignedIn()) return false;
    if (myRank?.rank !== null && myRank?.rank === entry.rank) return true;
    const name = ctx.getMe()?.displayName;
    return Boolean(name && entry.displayName === name);
  }

  function renderSeasons(): void {
    const base = ctx.getConfig().season || currentSeason();
    const options = seasonOptions(base, 6);
    if (!options.includes(season)) options.unshift(season);
    clear(seasonTabs);
    for (const value of options) {
      const button = makeButton(value, "", () => {
        if (season === value) return;
        season = value;
        seasonTouched = true;
        items = [];
        myRank = null;
        void load(true);
      });
      button.setAttribute("aria-pressed", String(value === season));
      seasonTabs.append(button);
    }
  }

  function metricOf(entry: LeaderboardEntry): string {
    return type === "assets"
      ? formatChips(entry.chips)
      : formatAccuracy(entry.accuracy);
  }

  function subOf(entry: LeaderboardEntry): string {
    return entry.samples !== null && entry.samples > 0
      ? t("leaderboard.samples", { count: entry.samples })
      : "";
  }

  function podiumCard(entry: LeaderboardEntry): HTMLElement {
    const card = el("article", "podium-card");
    card.dataset.place = String(entry.rank);
    if (isMe(entry)) card.classList.add("is-me");
    const rank = el("span", "podium-card__rank", `#${entry.rank}`);
    const avatar = el("span", "podium-card__avatar", initial(entry.displayName));
    avatar.setAttribute("aria-hidden", "true");
    const name = el("strong", "podium-card__name", entry.displayName);
    const value = el("span", "podium-card__value", metricOf(entry));
    card.append(rank, avatar, name, value);
    const sub = subOf(entry);
    if (sub) card.append(el("span", "podium-card__sub", sub));
    return card;
  }

  function rankRow(entry: LeaderboardEntry): HTMLElement {
    const row = el("div", "rank-row");
    if (isMe(entry)) row.classList.add("is-me");
    const rank = el("span", "rank-row__rank", String(entry.rank));
    const avatar = el("span", "rank-row__avatar", initial(entry.displayName));
    avatar.setAttribute("aria-hidden", "true");
    const who = el("div", "rank-row__who");
    who.append(el("span", "rank-row__name", entry.displayName));
    const sub = subOf(entry);
    if (sub) who.append(el("span", "rank-row__sub", sub));
    const value = el("span", "rank-row__value");
    value.append(
      document.createTextNode(metricOf(entry)),
      el(
        "small",
        "",
        type === "assets" ? t("common.chips") : t("leaderboard.accuracyValue")
      )
    );
    row.append(rank, avatar, who, value);
    return row;
  }

  function renderRankStrip(): void {
    show(myRankBox, true);
    myRankBox.classList.remove("my-rank--none");
    if (!ctx.isSignedIn()) {
      myRankBox.classList.add("my-rank--none");
      setText(myRankValue, "—");
      setText(myRankHint, t("leaderboard.loginHint"));
      return;
    }
    if (rankFailed && !myRank) {
      myRankBox.classList.add("my-rank--none");
      setText(myRankValue, "—");
      setText(myRankHint, t("errors.loadRank"));
      return;
    }
    if (myRank && myRank.rank !== null) {
      setText(myRankValue, t("me.rankValue", { rank: myRank.rank }));
      setText(
        myRankHint,
        myRank.samples !== null && myRank.samples > 0
          ? t("leaderboard.samples", { count: myRank.samples })
          : ""
      );
      return;
    }
    myRankBox.classList.add("my-rank--none");
    setText(myRankValue, t("leaderboard.notRanked"));
    setText(myRankHint, t("leaderboard.notRankedHint"));
  }

  function render(): void {
    const config = ctx.getConfig();
    setText(
      eyebrow,
      items.length > 0
        ? `${t("leaderboard.eyebrow", { season })} · ${t("leaderboard.summary", {
            count: items.length,
          })}`
        : t("leaderboard.eyebrow", { season: season || config.season || "—" })
    );
    for (const button of typeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.board === type));
    }
    renderSeasons();
    renderRankStrip();

    clear(podium);
    clear(rankList);
    const top = items.slice(0, 3);
    for (const entry of top) podium.append(podiumCard(entry));
    for (const entry of items.slice(3)) rankList.append(rankRow(entry));

    show(loadingEl, loading && items.length === 0);
    show(emptyEl, !loading && !error && items.length === 0);
    show(errorEl, Boolean(error) && items.length === 0);
    setText(errorText, error ?? "");
    refreshButton.disabled = loading;
  }

  async function loadRank(): Promise<void> {
    rankToken += 1;
    const mine = rankToken;
    if (!ctx.isSignedIn()) {
      myRank = null;
      rankFailed = false;
      renderRankStrip();
      return;
    }
    try {
      const rank = await ctx.api.myRank({ type, season });
      if (mine !== rankToken) return;
      myRank = rank;
      rankFailed = false;
      renderRankStrip();
    } catch {
      if (mine !== rankToken) return;
      rankFailed = true;
      renderRankStrip();
    }
  }

  async function load(force = false): Promise<void> {
    const config = ctx.getConfig();
    if (!seasonTouched && config.season && config.season !== season) {
      season = config.season;
      items = [];
    }

    const cached = ctx.cache.read<CachedBoard>(
      CACHE_KEYS.leaderboard,
      CACHE_TTL.leaderboard
    );
    if (
      cached &&
      cached.value.type === type &&
      cached.value.season === season &&
      Array.isArray(cached.value.items)
    ) {
      items = cached.value.items;
      render();
    }

    const key = `${type}|${season}`;
    if (!force && loadingKey === key) return;
    if (
      !force &&
      items.length > 0 &&
      Date.now() - lastFetch < CACHE_TTL.leaderboard
    ) {
      render();
      return;
    }

    loadingKey = key;
    loading = true;
    error = null;
    token += 1;
    const mine = token;
    render();

    try {
      const board = await ctx.api.leaderboard({ type, season, limit: 50 });
      if (mine !== token) return;
      items = board.items;
      cacheWrite();
      lastFetch = Date.now();
      error = null;
      ctx.banner(null);
      render();
      void loadRank();
    } catch (cause) {
      if (mine !== token) return;
      if (items.length > 0) {
        ctx.banner(
          t("common.offlineData", {
            time: formatDateTime(Date.now() - (cached?.age ?? 0)),
          }),
          { tone: "offline", retry: () => void load(true) }
        );
        error = null;
      } else {
        error = describeError(cause);
      }
    } finally {
      if (mine === token) {
        loadingKey = null;
        loading = false;
        render();
      }
    }
  }

  function cacheWrite(): void {
    ctx.cache.write(CACHE_KEYS.leaderboard, {
      type,
      season,
      items,
    } satisfies CachedBoard);
  }

  function resetAndLoad(nextType: LeaderboardType): void {
    if (type === nextType) return;
    type = nextType;
    items = [];
    myRank = null;
    rankFailed = false;
    void load(true);
  }

  for (const button of typeButtons) {
    button.addEventListener("click", () => {
      resetAndLoad(button.dataset.board === "accuracy" ? "accuracy" : "assets");
    });
  }
  refreshButton.addEventListener("click", () => void load(true));
  errorRetry.addEventListener("click", () => void load(true));

  return {
    show() {
      renderSeasons();
      const config = ctx.getConfig();
      if (!seasonTouched && config.season) {
        season = config.season;
      }
      void load();
    },
    load,
  };
}
