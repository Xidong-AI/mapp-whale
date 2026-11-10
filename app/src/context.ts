import type { Api } from "./api.ts";
import type { CacheStore } from "./cache.ts";
import type { PlatformConnection } from "./platform.ts";
import type {
  BetDraft,
  Market,
  Me,
  Prefs,
  PublicConfig,
  ToastTone,
} from "./types.ts";

export type Tab = "markets" | "leaderboard" | "me";

export interface BannerOptions {
  tone?: "info" | "offline";
  retry?: () => void;
}

export interface AppContext {
  api: Api;
  cache: CacheStore;
  connection: PlatformConnection;
  demo: boolean;
  toast(message: string, tone?: ToastTone): void;
  banner(message: string | null, options?: BannerOptions): void;
  getConfig(): PublicConfig;
  setConfig(config: PublicConfig, trustClock?: boolean): void;
  getMe(): Me | null;
  setMe(me: Me | null): void;
  getMarkets(): Market[];
  setMarkets(markets: Market[]): void;
  upsertMarket(market: Market): void;
  getMarket(id: string): Market | undefined;
  serverNow(): number;
  getPrefs(): Prefs;
  setPrefs(patch: Partial<Prefs>): void;
  getDraft(): BetDraft | null;
  setDraft(draft: BetDraft | null): void;
  goTab(tab: Tab): void;
  openMarket(id: string): void;
  openLeaderboard(): void;
  requestLogin(): void;
  refreshMe(): Promise<void>;
  isSignedIn(): boolean;
  /** 生成市场嵌入 iframe 代码并写入剪贴板（详情页使用）。 */
  copyEmbedCode(market: Market): Promise<void>;
}
