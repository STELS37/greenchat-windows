// clients/core — transport errors (T-402).
//
// Every failed API call surfaces as an ApiError carrying the server's Appendix-D error code, the
// human message, the HTTP status, and any structured `data` the server attached next to
// {code, message} (e.g. SLOW_MODE -> {retry_after}, QUOTA_EXCEEDED -> {used, quota}). The class is
// the single error type the whole SDK throws for server-shaped failures, so callers switch on
// `.code` (stable machine contract) rather than the localised `.message`.

// The wire envelope for a failed response: {ok:false, error:{code, message, ...data}}.
export interface WireError {
  code: string;
  message: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  // Extra machine-actionable fields the server merged beside {code, message} (never includes those
  // two reserved keys). Empty object when the error carried none.
  readonly data: Record<string, unknown>;

  constructor(code: string, message: string, httpStatus: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.data = data;
  }

  // Build from a decoded {ok:false, error} body. The reserved keys are stripped from `data` so it
  // holds only the structured extras.
  static fromWire(err: WireError, httpStatus: number): ApiError {
    const { code, message, ...rest } = err;
    return new ApiError(code, message, httpStatus, rest);
  }

  // True when the access token is expired and a refresh should be attempted (the ApiClient handles
  // this transparently; exposed so callers/tests can assert on it).
  get isTokenExpired(): boolean {
    return this.code === "TOKEN_EXPIRED";
  }

  // Explicit account/session verdicts that are fatal without a refresh probe. Generic UNAUTHORIZED is
  // intentionally excluded: protected handlers also use it for a wrong old password or second factor.
  get isAuthFatal(): boolean {
    return this.code === "SESSION_WIPED" || this.code === "ACCOUNT_SUSPENDED";
  }
}

// A transport-level failure BEFORE any HTTP response was seen (DNS, connection reset, timeout,
// offline). Distinct from ApiError so retry logic can treat "no response" (safe to retry an
// idempotent call) differently from a server verdict. `cause` keeps the original error/AbortError.
export class NetworkError extends Error {
  override readonly cause: unknown;
  // True when the failure was our own client-side timeout (AbortController fired), not the network.
  readonly timedOut: boolean;

  constructor(message: string, cause: unknown, timedOut = false) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
    this.timedOut = timedOut;
  }
}
