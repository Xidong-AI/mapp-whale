import { CACHE_KEYS, browserStorage, createCache } from "./cache.ts";
import { CACHE_TTL } from "./config.ts";
import { FALLBACK_CONFIG } from "./config.ts";
import type { AppContext, Tab } from "./context.ts";
import { applyCopy, t } from "./copy.ts";
import { byId, el } from "./dom.ts";
import { describeError } from "./errors.ts";
import { debugLog, describeDebug, setDebugSink } from "./debug.ts";
import {
  clampInteger,
  currentSeason,
  formatChips,
  formatCountdown,
} from "./logic.ts";
import { createDemoTransport, demoConnection } from "./mock.ts";
import {
  connectPlatform,
  createTransport,
  notifyReady,
  watchTheme,
  type PlatformConnection,
} from "./platform.ts";
import { createApi } from "./api.ts";
import type {
  BetDraft,
  Market,
  Me,
  Prefs,
  PublicConfig,
  ToastTone,
} from "./types.ts";
import { createDetailView, type DetailView } from "./views/detail.ts";
import {
  createLeaderboardView,
  type LeaderboardView,
} from "./views/leaderboard.ts";
import { createMarketsView, type MarketsView } from "./views/markets.ts";
import { createProfileView, type ProfileView } from "./views/profile.ts";
import { defaultPrefs } from "./logic.ts";

interface CachedMe {
  userId: number | null;
  me: Me;
}

function readPrefs(cache: ReturnType<typeof createCache>): Prefs {
  const fallback = defaultPrefs();
  const cached = cache.read<Partial<Prefs>>(CACHE_KEYS.prefs);
  if (!cached || !cached.value || typeof cached.value !== "object") {
    return fallback;
  }
  const value = cached.value;
  const tab: Tab =
    value.tab === "leaderboard" || value.tab === "me"
      ? value.tab
      : "markets";
  const confidence = clampInteger(Number(value.confidence ?? 0), -100, 100);
  const amount =
    typeof value.amount === "number" && Number.isSafeInteger(value.amount)
      ? value.amount
      : null;
  return {
    tab,
    lastMarketId:
      typeof value.lastMarketId === "string" ? value.lastMarketId : null,
    confidence,
    amount: amount !== null && amount > 0 ? amount : null,
    theme: typeof value.theme === "string" ? value.theme : "abyss",
  };
}

function readDraft(cache: ReturnType<typeof createCache>): BetDraft | null {
  const cached = cache.read<BetDraft>(CACHE_KEYS.draft);
  if (!cached || !cached.value || typeof cached.value !== "object") {
    return null;
  }
  const value = cached.value;
  if (
    typeof value.marketId !== "string" ||
    (value.side !== "yes" && value.side !== "no")
  ) {
    return null;
  }
  const confidence = clampInteger(Number(value.confidence), -100, 100);
  const amount =
    typeof value.amount === "number" && Number.isSafeInteger(value.amount)
      ? value.amount
      : null;
  return {
    marketId: value.marketId,
    side: value.side,
    amount,
    confidence,
    updatedAt:
      typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

export async function startApp(): Promise<void> {
  document.documentElement.lang = "zh-CN";
  applyCopy(document);

  const debugEnabled = new URLSearchParams(location.search).has("debug");
  const debugPanel = document.getElementById("debug-panel");
  const debugLines: string[] = [];
  if (debugPanel) {
    if (debugEnabled) debugPanel.hidden = false;
    setDebugSink((label, value) => {
      debugLines.push(
        `${new Date().toLocaleTimeString()} ${label}: ${describeDebug(value)}`
      );
      debugPanel.textContent = debugLines.slice(-40).join("\n");
      if (debugEnabled || /error|failed|失败/i.test(label)) {
        debugPanel.hidden = false;
      }
    });
    debugLog("boot", {
      href: location.href,
      hasMiniApp: Boolean((globalThis as { miniApp?: unknown }).miniApp),
      dev: import.meta.env.DEV,
    });
  }

  const devParams = import.meta.env.DEV
    ? new URLSearchParams(location.search)
    : null;
  const demoMode = import.meta.env.DEV && Boolean(devParams?.has("demo"));
  const devView = devParams?.get("view") ?? null;
  const devDetail = devParams?.get("detail") ?? null;

  const connection: PlatformConnection = demoMode
    ? devParams?.get("guest") === "1"
      ? { ...demoConnection(), mode: "guest", user: null }
      : demoConnection()
    : await connectPlatform();
  debugLog("connection", {
    mode: connection.mode,
    hasSDK: Boolean(connection.sdk),
    network: connection.sdk?.permissions.has("network.request") ?? false,
  });
  if (debugPanel && (!connection.sdk || connection.mode === "error")) {
    debugPanel.hidden = false;
  }
  const cache = createCache(browserStorage());
  const api = createApi(
    demoMode
      ? createDemoTransport({ empty: devParams?.get("empty") === "1" })
      : createTransport(connection)
  );

  let config: PublicConfig = {
    ...FALLBACK_CONFIG,
    season: currentSeason(),
  };
  let markets: Market[] = [];
  let me: Me | null = null;
  let prefs = readPrefs(cache);
  let draft = readDraft(cache);
  let clockOffset = 0;
  let marketsView: MarketsView | null = null;
  let detailView: DetailView | null = null;
  let leaderboardView: LeaderboardView | null = null;
  let profileView: ProfileView | null = null;
  let bannerRetry: (() => void) | null = null;

  const signedIn = () =>
    connection.mode === "connected" && connection.user !== null;

  const serverNow = () => Date.now() + clockOffset;

  const ctx: AppContext = {
    api,
    cache,
    connection,
    demo: demoMode,
    toast(message, tone = "info") {
      pushToast(message, tone);
    },
    banner(message, options) {
      paintBanner(message, options?.tone, options?.retry);
    },
    getConfig: () => config,
    setConfig(next, trustClock) {
      config = next;
      if (trustClock && Number.isFinite(next.serverTime) && next.serverTime > 0) {
        clockOffset = next.serverTime - Date.now();
      }
      document.title = next.productName || t("meta.name");
      byId("brand-name").textContent = next.productName || t("meta.name");
      marketsView?.refresh();
      detailView?.refresh();
    },
    getMe: () => me,
    setMe(next) {
      me = next;
      if (next) {
        cache.write(CACHE_KEYS.me, {
          userId: connection.user?.id ?? null,
          me: next,
        } satisfies CachedMe);
      } else {
        cache.remove(CACHE_KEYS.me);
      }
      paintBalance();
      detailView?.refresh();
    },
    getMarkets: () => markets,
    setMarkets(next) {
      markets = next;
    },
    upsertMarket(market) {
      const index = markets.findIndex((item) => item.id === market.id);
      if (index >= 0) markets[index] = market;
      else markets = [...markets, market];
      cache.write(CACHE_KEYS.markets, { items: markets });
      marketsView?.refresh();
    },
    getMarket: (id) => markets.find((market) => market.id === id),
    serverNow,
    getPrefs: () => prefs,
    setPrefs(patch) {
      prefs = { ...prefs, ...patch };
      cache.write(CACHE_KEYS.prefs, prefs);
    },
    getDraft: () => draft,
    setDraft(next) {
      draft = next;
      if (next) cache.write(CACHE_KEYS.draft, next);
      else cache.remove(CACHE_KEYS.draft);
    },
    goTab,
    openMarket,
    openLeaderboard: () => goTab("leaderboard"),
    requestLogin() {
      pushToast(t("toast.login"), "info");
    },
    refreshMe,
    isSignedIn: signedIn,
  };

  const marketsEl = byId("view-markets");
  const detailEl = byId("view-detail");
  const leaderboardEl = byId("view-leaderboard");
  const meEl = byId("view-me");
  const tabButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#tabs [data-tab]")
  );
  const balanceBox = byId("balance-box");
  const balanceNode = byId("balance");
  const banner = byId("banner");
  const bannerText = byId("banner-text");
  const bannerRetryButton = byId<HTMLButtonElement>("banner-retry");
  const toastStack = byId("toasts");

  marketsView = createMarketsView(ctx);
  detailView = createDetailView(ctx);
  leaderboardView = createLeaderboardView(ctx);
  profileView = createProfileView(ctx);

  function pushToast(message: string, tone: ToastTone): void {
    const toast = el("div", `toast toast--${tone}`, message);
    toastStack.append(toast);
    while (toastStack.childElementCount > 3) {
      toastStack.firstElementChild?.remove();
    }
    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 260);
    }, 3800);
  }

  function paintBanner(
    message: string | null,
    tone: "info" | "offline" = "info",
    retry?: () => void
  ): void {
    if (!message) {
      banner.hidden = true;
      bannerRetry = null;
      bannerRetryButton.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = tone === "offline" ? "banner banner--offline" : "banner";
    bannerText.textContent = message;
    bannerRetry = retry ?? null;
    bannerRetryButton.hidden = !retry;
  }

  function paintBalance(): void {
    if (!me) {
      balanceBox.hidden = true;
      return;
    }
    balanceBox.hidden = false;
    balanceNode.textContent = formatChips(me.chips);
  }

  function paintConnection(): void {
    const pill = byId("connection");
    if (demoMode) {
      pill.className = "pill pill--demo";
      pill.textContent = t("connection.demo");
      return;
    }
    const mode = connection.mode;
    pill.className = `pill pill--${mode}`;
    pill.textContent = t(`connection.${mode}`);
  }

  function applyTheme(): void {
    const theme = connection.theme;
    if (theme) {
      document.documentElement.dataset.reducedMotion = String(
        theme.reducedMotion
      );
    }
  }

  function showOnly(target: HTMLElement): void {
    for (const view of [marketsEl, detailEl, leaderboardEl, meEl]) {
      view.hidden = view !== target;
    }
  }

  function paintTabs(active: Tab): void {
    for (const button of tabButtons) {
      if (button.dataset.tab === active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  function goTab(tab: Tab): void {
    paintTabs(tab);
    paintBanner(null);
    ctx.setPrefs({ tab });
    if (tab === "markets") {
      showOnly(marketsEl);
      marketsView?.refresh();
      void marketsView?.load();
      return;
    }
    if (tab === "leaderboard") {
      showOnly(leaderboardEl);
      leaderboardView?.show();
      return;
    }
    showOnly(meEl);
    profileView?.show();
  }

  function openMarket(id: string): void {
    paintTabs("markets");
    paintBanner(null);
    showOnly(detailEl);
    void detailView?.open(id);
  }

  async function refreshMe(): Promise<void> {
    if (!signedIn()) {
      ctx.setMe(null);
      return;
    }
    try {
      const next = await api.me();
      ctx.setMe(next);
    } catch (cause) {
      ctx.toast(describeError(cause), "error");
    }
  }

  function loadCachedState(): void {
    const cachedConfig = cache.read<PublicConfig>(
      CACHE_KEYS.config,
      CACHE_TTL.config
    );
    if (cachedConfig && cachedConfig.value) {
      ctx.setConfig(cachedConfig.value, false);
    }

    const cachedMarkets = cache.read<{ items: Market[] }>(CACHE_KEYS.markets);
    if (cachedMarkets && Array.isArray(cachedMarkets.value?.items)) {
      markets = cachedMarkets.value.items;
    }

    if (signedIn()) {
      const cachedMe = cache.read<CachedMe>(CACHE_KEYS.me);
      if (
        cachedMe &&
        cachedMe.value?.me &&
        cachedMe.value.userId === connection.user?.id
      ) {
        ctx.setMe(cachedMe.value.me);
      }
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const next = await api.config();
      ctx.setConfig(next, true);
      cache.write(CACHE_KEYS.config, next);
    } catch {
      // Defaults keep the shell usable; market views report their own network state.
    }
  }

  async function loadMe(): Promise<void> {
    if (!signedIn()) return;
    try {
      const next = await api.me();
      ctx.setMe(next);
    } catch (cause) {
      ctx.banner(describeError(cause), {
        tone: "offline",
        retry: () => void loadMe(),
      });
    }
  }

  function startClock(): void {
    setInterval(() => {
      const now = serverNow();
      document
        .querySelectorAll<HTMLElement>("[data-countdown]")
        .forEach((node) => {
          const target = Number(node.dataset.countdown);
          const value = formatCountdown(target, now, true);
          if (node.dataset.countdownPrefix === "left") {
            node.textContent =
              value === "已截止"
                ? t("markets.deadlineClosed")
                : t("markets.deadlineLeft", { time: value });
          } else {
            node.textContent = value;
          }
          node.classList.toggle("countdown--closed", value === "已截止");
        });
      if (!detailEl.hidden) detailView?.tick();
    }, 1000);
  }

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (tab === "markets" || tab === "leaderboard" || tab === "me") {
        goTab(tab);
      }
    });
  }

  bannerRetryButton.addEventListener("click", () => {
    const action = bannerRetry;
    bannerRetry = null;
    if (action) action();
  });

  loadCachedState();
  paintConnection();
  paintBalance();
  applyTheme();
  watchTheme(connection, (theme) => {
    connection.theme = theme;
    applyTheme();
  });

  if (devParams) {
    const confidence = Number(devParams.get("confidence"));
    if (Number.isFinite(confidence)) {
      ctx.setPrefs({ confidence: clampInteger(confidence, -100, 100) });
    }
    const amount = Number(devParams.get("amount"));
    if (Number.isSafeInteger(amount) && amount > 0) {
      ctx.setPrefs({ amount });
    }
  }

  const initialTab: Tab =
    devView === "leaderboard" || devView === "me" || devView === "markets"
      ? devView
      : prefs.tab;
  goTab(initialTab);
  if (devDetail) openMarket(devDetail);
  startClock();

  await notifyReady(connection);

  void loadConfig();
  if (signedIn()) void loadMe();
}
