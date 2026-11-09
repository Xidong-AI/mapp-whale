import { CACHE_TTL } from "../config.ts";
import { PAGE_SIZE } from "../config.ts";
import type { AppContext } from "../context.ts";
import { t } from "../copy.ts";
import { byId, clear, el, setText, show, statusTag } from "../dom.ts";
import { describeError } from "../errors.ts";
import {
  currentSeason,
  formatAccuracy,
  formatChips,
  formatDateTime,
} from "../logic.ts";
import type {
  HistoryRow,
  MyRank,
  PositionRow,
  Side,
} from "../types.ts";

type RecordRow = PositionRow | HistoryRow;
type RecordsTab = "positions" | "history";

export interface ProfileView {
  show(): void;
}

function sideLabel(side: Side): string {
  return side === "yes" ? t("detail.sideYes") : t("detail.sideNo");
}

function recordStatus(status: string): {
  label: string;
  tone: "open" | "yes" | "no" | "void" | "settled";
} {
  switch (status) {
    case "open":
      return { label: t("me.statusOpen"), tone: "open" };
    case "won":
      return { label: t("me.statusWon"), tone: "yes" };
    case "lost":
      return { label: t("me.statusLost"), tone: "no" };
    case "refunded":
      return { label: t("me.statusRefunded"), tone: "void" };
    default:
      return { label: t("status.settled"), tone: "settled" };
  }
}

export function createProfileView(ctx: AppContext): ProfileView {
  const gate = byId("me-gate");
  const content = byId("me-content");
  const gateMarkets = byId<HTMLButtonElement>("me-gate-markets");
  const eyebrow = byId("me-eyebrow");

  const avatar = byId<HTMLImageElement>("me-avatar");
  const initials = byId("me-initials");
  const nameNode = byId("me-name");
  const seasonNode = byId("me-season");
  const chipsNode = byId("me-chips");
  const claimButton = byId<HTMLButtonElement>("claim");
  const claimHint = byId("claim-hint");

  const stakedNode = byId("stat-staked");
  const payoutNode = byId("stat-payout");
  const correctNode = byId("stat-correct");
  const accuracyNode = byId("stat-accuracy");
  const rankAssets = byId("me-rank-assets");
  const rankAccuracy = byId("me-rank-accuracy");
  const openLeaderboard = byId<HTMLButtonElement>("me-open-leaderboard");

  const tabButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#me-tabs [data-me-tab]")
  );
  const recordsTitle = byId("records-title");
  const recordsBox = byId("me-records");
  const recordsLoading = byId("me-records-loading");
  const recordsEmpty = byId("me-records-empty");
  const recordsEmptyTitle = byId("me-records-empty-title");
  const recordsEmptyHint = byId("me-records-empty-hint");
  const recordsError = byId("me-records-error");
  const recordsErrorText = byId("me-records-error-text");
  const recordsMore = byId<HTMLButtonElement>("me-records-more");
  const recordsRetry = byId<HTMLButtonElement>("me-records-retry");
  const recordsMarkets = byId<HTMLButtonElement>("me-records-markets");

  let tab: RecordsTab = "positions";
  let records: RecordRow[] = [];
  let cursor: string | null = null;
  let recordsLoadingState = false;
  let recordsErrorState: string | null = null;
  let recordsToken = 0;
  let meToken = 0;
  let lastMeFetch = 0;
  let claiming = false;
  let claimError: string | null = null;
  let ranks: { assets: MyRank | null; accuracy: MyRank | null } = {
    assets: null,
    accuracy: null,
  };
  let rankLoading = false;
  let rankErrors: { assets: boolean; accuracy: boolean } = {
    assets: false,
    accuracy: false,
  };

  function paintAvatar(): void {
    const user = ctx.connection.user;
    const label =
      ctx.getMe()?.displayName ||
      user?.name ||
      user?.username ||
      t("me.guestName");
    setText(nameNode, label);
    if (user?.avatarUrl) {
      avatar.src = user.avatarUrl;
      show(avatar, true);
      show(initials, false);
    } else {
      avatar.removeAttribute("src");
      show(avatar, false);
      show(initials, true);
      setText(
        initials,
        user?.initials || Array.from(label.trim())[0] || "鲸"
      );
    }
  }

  function paintClaim(): void {
    const me = ctx.getMe();
    const config = ctx.getConfig();
    claimHint.classList.toggle("hint--error", Boolean(claimError));
    if (claimError) {
      claimButton.textContent = t("me.claim", { amount: config.dailyChips });
      claimButton.disabled = claiming || !me;
      setText(claimHint, claimError);
      return;
    }
    if (claiming) {
      claimButton.textContent = t("me.claimPending");
      claimButton.disabled = true;
      setText(claimHint, t("common.loading"));
      return;
    }
    if (!me) {
      claimButton.textContent = t("me.claim", { amount: config.dailyChips });
      claimButton.disabled = true;
      setText(claimHint, "");
      return;
    }
    if (me.canClaim) {
      claimButton.textContent = t("me.claim", { amount: config.dailyChips });
      claimButton.disabled = false;
      setText(claimHint, "");
    } else {
      claimButton.textContent = t("me.claimed");
      claimButton.disabled = true;
      setText(
        claimHint,
        me.nextClaimAt
          ? t("me.nextClaim", { time: formatDateTime(me.nextClaimAt) })
          : t("me.claimed")
      );
    }
  }

  function paintStats(): void {
    const me = ctx.getMe();
    if (!me) {
      for (const node of [stakedNode, payoutNode, correctNode, accuracyNode]) {
        setText(node, "—");
      }
      return;
    }
    setText(stakedNode, formatChips(me.stats.staked));
    setText(payoutNode, formatChips(me.stats.payout));
    setText(correctNode, `${me.stats.correct} / ${me.stats.total}`);
    setText(accuracyNode, formatAccuracy(me.stats.accuracy));
  }

  function paintRanks(): void {
    const entries: Array<[HTMLElement, "assets" | "accuracy"]> = [
      [rankAssets, "assets"],
      [rankAccuracy, "accuracy"],
    ];
    for (const [node, key] of entries) {
      if (rankLoading) {
        setText(node, "…");
        continue;
      }
      if (rankErrors[key]) {
        setText(node, "—");
        continue;
      }
      const rank = ranks[key];
      setText(
        node,
        rank && rank.rank !== null
          ? t("me.rankValue", { rank: rank.rank })
          : t("me.rankNone")
      );
    }
  }

  function paintProfile(): void {
    const me = ctx.getMe();
    const config = ctx.getConfig();
    const season = me?.season || config.season || "—";
    setText(eyebrow, t("me.eyebrow", { season }));
    setText(seasonNode, t("me.seasonLine", { season }));
    setText(chipsNode, me ? formatChips(me.chips) : "—");
    paintAvatar();
    paintClaim();
    paintStats();
    paintRanks();
  }

  function recordRow(row: RecordRow): HTMLElement {
    const market = ctx.getMarket(row.marketId);
    const titleText = row.title || market?.title || row.marketId;
    const status = recordStatus(row.status);
    const card = el("article", "record");

    const primary = el("div");
    const side = el("div", "record__side");
    const sideWord = el(
      "b",
      row.side === "yes" ? "is-yes" : "is-no",
      sideLabel(row.side)
    );
    side.append(sideWord);
    primary.append(el("div", "record__title", titleText), side);

    const statusNode = el("span", "record__status");
    statusNode.append(statusTag(status.label, status.tone));

    const nums = el("div", "record__nums");
    const amount = el("span");
    amount.append(
      document.createTextNode(`${t("me.amountLabel")} `),
      Object.assign(el("b"), { textContent: formatChips(row.amount) })
    );
    nums.append(amount);
    if (row.payout > 0) {
      const payout = el("span");
      payout.append(
        document.createTextNode(`${t("me.payoutLabel")} `),
        Object.assign(el("b", "is-profit"), {
          textContent: formatChips(row.payout),
        })
      );
      nums.append(payout);
    }
    if (row.createdAt) {
      nums.append(el("span", "", formatDateTime(row.createdAt)));
    }

    card.append(primary, statusNode, nums);
    return card;
  }

  function paintRecords(): void {
    clear(recordsBox);
    for (const row of records) recordsBox.append(recordRow(row));

    const empty = !recordsLoadingState && !recordsErrorState && records.length === 0;
    show(recordsLoading, recordsLoadingState && records.length === 0);
    show(recordsEmpty, empty);
    show(recordsError, Boolean(recordsErrorState) && records.length === 0);
    show(
      recordsMore,
      Boolean(cursor) && records.length > 0 && !recordsLoadingState
    );
    recordsMore.disabled = recordsLoadingState;
    setText(
      recordsEmptyTitle,
      tab === "positions" ? t("me.positionsEmpty") : t("me.historyEmpty")
    );
    setText(
      recordsEmptyHint,
      tab === "positions" ? t("me.positionsEmptyHint") : t("me.historyEmptyHint")
    );
    setText(recordsErrorText, recordsErrorState ?? "");
    setText(
      recordsTitle,
      tab === "positions" ? t("me.positionsTitle") : t("me.historyTitle")
    );
    for (const button of tabButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.meTab === tab)
      );
    }
  }

  async function loadMe(force = false): Promise<void> {
    if (!ctx.isSignedIn()) return;
    if (
      !force &&
      ctx.getMe() &&
      Date.now() - lastMeFetch < CACHE_TTL.me
    ) {
      return;
    }
    meToken += 1;
    const mine = meToken;
    try {
      const me = await ctx.api.me();
      if (mine !== meToken) return;
      ctx.setMe(me);
      lastMeFetch = Date.now();
      paintProfile();
    } catch (cause) {
      if (mine !== meToken) return;
      ctx.banner(describeError(cause), {
        tone: "offline",
        retry: () => void loadMe(true),
      });
    }
  }

  async function loadRanks(): Promise<void> {
    if (!ctx.isSignedIn()) {
      ranks = { assets: null, accuracy: null };
      rankErrors = { assets: false, accuracy: false };
      rankLoading = false;
      paintRanks();
      return;
    }
    rankLoading = true;
    paintRanks();
    const season = ctx.getConfig().season || currentSeason();
    const [assets, accuracy] = await Promise.allSettled([
      ctx.api.myRank({ type: "assets", season }),
      ctx.api.myRank({ type: "accuracy", season }),
    ]);
    ranks = {
      assets: assets.status === "fulfilled" ? assets.value : null,
      accuracy: accuracy.status === "fulfilled" ? accuracy.value : null,
    };
    rankErrors = {
      assets: assets.status === "rejected",
      accuracy: accuracy.status === "rejected",
    };
    rankLoading = false;
    paintRanks();
  }

  async function loadRecords(reset: boolean): Promise<void> {
    if (!ctx.isSignedIn()) return;
    recordsToken += 1;
    const mine = recordsToken;
    if (reset) {
      records = [];
      cursor = null;
      recordsErrorState = null;
    }
    recordsLoadingState = true;
    paintRecords();
    try {
      const page =
        tab === "positions"
          ? await ctx.api.positions({
              status: "open",
              limit: 100,
              cursor,
            })
          : await ctx.api.history({
              season: ctx.getConfig().season || currentSeason(),
              limit: ctx.getConfig().pageSize ?? PAGE_SIZE,
              cursor,
            });
      if (mine !== recordsToken) return;
      records = reset ? page.items : [...records, ...page.items];
      cursor = page.nextCursor;
      recordsErrorState = null;
    } catch (cause) {
      if (mine !== recordsToken) return;
      recordsErrorState = describeError(cause);
      if (records.length > 0) ctx.toast(recordsErrorState, "error");
    } finally {
      if (mine === recordsToken) {
        recordsLoadingState = false;
        paintRecords();
      }
    }
  }

  async function claim(): Promise<void> {
    if (!ctx.isSignedIn()) {
      ctx.requestLogin();
      return;
    }
    const me = ctx.getMe();
    if (!me || !me.canClaim || claiming) return;
    claimError = null;
    claiming = true;
    paintClaim();
    try {
      const result = await ctx.api.claim(
        ctx.connection.user?.name || ctx.connection.user?.username
      );
      if (result.claimed) {
        ctx.setMe({ ...me, chips: result.chips, canClaim: false });
        paintProfile();
        ctx.toast(t("toast.claimed", { amount: result.amount }), "success");
      } else {
        ctx.toast(t("errors.alreadyClaimed"), "info");
      }
      claimError = null;
      await loadMe(true);
    } catch (cause) {
      claimError = describeError(cause);
      ctx.toast(claimError, "error");
    } finally {
      claiming = false;
      paintProfile();
    }
  }

  claimButton.addEventListener("click", () => void claim());
  gateMarkets.addEventListener("click", () => ctx.goTab("markets"));
  recordsMarkets.addEventListener("click", () => ctx.goTab("markets"));
  openLeaderboard.addEventListener("click", () => ctx.openLeaderboard());
  recordsMore.addEventListener("click", () => void loadRecords(false));
  recordsRetry.addEventListener("click", () => void loadRecords(true));

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      const next: RecordsTab =
        button.dataset.meTab === "history" ? "history" : "positions";
      if (next === tab) return;
      tab = next;
      void loadRecords(true);
    });
  }

  return {
    show() {
      const config = ctx.getConfig();
      setText(eyebrow, t("me.eyebrow", { season: config.season || "—" }));
      if (!ctx.isSignedIn()) {
        show(gate, true);
        show(content, false);
        return;
      }
      show(gate, false);
      show(content, true);
      paintProfile();
      void loadMe();
      void loadRanks();
      void loadRecords(true);
    },
  };
}
