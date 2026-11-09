import { t } from "./copy.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message = "", status = 0, options?: ErrorOptions) {
    super(message || code, options);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isOfflineError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "OFFLINE" || error.code === "NETWORK_ERROR")
  );
}

export function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return "UNKNOWN";
}

export interface ErrorVars {
  min?: number;
  max?: number;
}

export function describeError(error: unknown, vars: ErrorVars = {}): string {
  if (!(error instanceof ApiError)) return t("errors.generic");
  switch (error.code) {
    case "OFFLINE":
    case "NETWORK_ERROR":
      return t("errors.offline");
    case "TIMEOUT":
      return t("errors.timeout");
    case "PERMISSION_DENIED":
    case "FORBIDDEN":
      return t("errors.permission");
    case "UNAUTHORIZED":
    case "AUTH_REQUIRED":
    case "INVALID_TOKEN":
      return t("errors.unauthorized");
    case "USER_CANCELLED":
      return t("errors.cancelled");
    case "APP_UNLOADED":
      return t("errors.unloaded");
    case "RATE_LIMIT":
    case "TOO_MANY_REQUESTS":
      return t("errors.rateLimit");
    case "BET_TOO_SMALL":
      return t("errors.betTooSmall", { min: vars.min ?? 0 });
    case "BET_TOO_LARGE":
      return t("errors.betTooLarge", { max: vars.max ?? 0 });
    case "CHIPS_TOO_LOW":
    case "INSUFFICIENT_CHIPS":
      return t("errors.chipsTooLow");
    case "INVALID_AMOUNT":
    case "INVALID_BET_AMOUNT":
      return t("errors.invalidAmount");
    case "MARKET_CLOSED":
    case "MARKET_NOT_OPEN":
      return t("errors.marketClosed");
    case "MARKET_NOT_FOUND":
    case "NOT_FOUND":
      return t("errors.marketNotFound");
    case "INVALID_REQUEST":
      return t("errors.invalidRequest");
    case "INVALID_CONFIDENCE":
      return t("errors.invalidConfidence");
    case "INVALID_SIDE":
      return t("errors.invalidSide");
    case "ALREADY_CLAIMED":
    case "CLAIMED_TODAY":
      return t("errors.alreadyClaimed");
    case "BAD_RESPONSE":
    case "EMPTY_RESPONSE":
      return t("errors.badResponse");
    case "UNKNOWN":
    case "HTTP_ERROR":
    case "CONFLICT":
    case "INTERNAL":
      return t("errors.generic");
    default:
      return t("errors.unknownCode", { code: error.code });
  }
}
