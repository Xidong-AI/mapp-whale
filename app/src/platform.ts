import { getSDK } from "@discourse-mini-app/sdk";
import type {
  JsonValue,
  MiniAppSDK,
  MiniAppTheme,
  MiniAppUser,
} from "@discourse-mini-app/sdk";
import {
  API_ORIGIN,
  ENDPOINTS,
  REQUEST_TIMEOUT_MS,
  type EndpointName,
} from "./config.ts";
import type { Transport, TransportRequest, TransportResponse } from "./api.ts";
import { ApiError } from "./errors.ts";
import { debugLog, describeDebug } from "./debug.ts";

export type PlatformMode = "preview" | "guest" | "connected" | "error";

export interface PlatformConnection {
  sdk: MiniAppSDK | null;
  mode: PlatformMode;
  user: MiniAppUser | null;
  theme: MiniAppTheme | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("PLATFORM_READY_TIMEOUT"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function connectPlatform(): Promise<PlatformConnection> {
  let sdk: MiniAppSDK | null = null;
  try {
    sdk = getSDK();
  } catch {
    sdk = null;
  }
  if (!sdk) {
    return { sdk: null, mode: "preview", user: null, theme: null };
  }

  try {
    await withTimeout(sdk.ready, 8000);
    const canReadUser = sdk.permissions.has("user.read");
    const canReadTheme = sdk.permissions.has("theme.read");
    const [user, theme] = await Promise.all([
      canReadUser
        ? sdk.user.getCurrent({ timeoutMs: 8000 }).catch(() => null)
        : Promise.resolve(null),
      canReadTheme ? sdk.theme.get().catch(() => null) : Promise.resolve(null),
    ]);
    return {
      sdk,
      mode: user ? "connected" : "guest",
      user,
      theme,
    };
  } catch (error) {
    console.warn("[预言鲸] 社区连接失败", error);
    debugLog("connect error", error);
    return { sdk, mode: "error", user: null, theme: null };
  }
}

export function watchTheme(
  connection: PlatformConnection,
  listener: (theme: MiniAppTheme) => void
): () => void {
  const sdk = connection.sdk;
  if (!sdk || !sdk.permissions.has("theme.read")) {
    return () => undefined;
  }
  try {
    return sdk.theme.onChange(listener);
  } catch {
    return () => undefined;
  }
}

export async function notifyReady(
  connection: PlatformConnection
): Promise<void> {
  if (!connection.sdk) return;
  try {
    await connection.sdk.lifecycle.ready();
  } catch (error) {
    console.warn("[预言鲸] lifecycle.ready 失败", error);
  }
}

function sdkTransport(sdk: MiniAppSDK): Transport {
  return async (
    endpoint: EndpointName,
    request: TransportRequest
  ): Promise<TransportResponse> => {
    const query = request.query
      ? Object.fromEntries(
          Object.entries(request.query)
            .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
            .map(([key, value]) => [key, String(value)])
        )
      : undefined;
    try {
    const options: {
      method?: "GET" | "POST";
      query?: Record<string, string>;
      json?: JsonValue;
      timeoutMs?: number;
    } = {
      method: request.method,
      timeoutMs: request.timeoutMs,
    };
    if (query) options.query = query;
    // SDK 会把显式的 json: undefined 当成非法 JSON，GET 请求不能带这个字段。
    if (request.json !== undefined) options.json = request.json as JsonValue;
    const response = await sdk.http.request(endpoint, options);
      debugLog("sdk response", { endpoint, status: response.status });
      return { status: response.status, body: response.body };
    } catch (error) {
      debugLog("sdk request error", { endpoint, error: describeDebug(error) });
      throw error;
    }
  };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fetchTransport(): Transport {
  return async (
    endpoint: EndpointName,
    request: TransportRequest
  ): Promise<TransportResponse> => {
    const url = new URL(ENDPOINTS[endpoint].path, API_ORIGIN);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      request.timeoutMs || REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(url, {
        method: request.method,
        headers:
          request.json === undefined
            ? undefined
            : { "content-type": "application/json" },
        body:
          request.json === undefined ? undefined : JSON.stringify(request.json),
        credentials: "omit",
        signal: controller.signal,
      });
      return { status: response.status, body: await parseBody(response) };
    } catch (error) {
      debugLog("fetch error", { endpoint, error: describeDebug(error) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createTransport(connection: PlatformConnection): Transport {
  const sdk = connection.sdk;
  if (!sdk) {
    debugLog("transport", "fetch (sdk missing)");
    return fetchTransport();
  }
  if (!sdk.permissions.has("network.request")) {
    debugLog("transport", "permission denied");
    return async () => {
      throw new ApiError("PERMISSION_DENIED");
    };
  }
  debugLog("transport", "sdk");
  return sdkTransport(sdk);
}
