/**
 * Browser API client (§35).
 *
 * One place that knows the response envelope (`{data}` / `{error}`), so every
 * component gets typed results and a real error object instead of each screen
 * re-implementing fetch handling.
 *
 * `ApiError` carries the server's error `code`, which is what lets the UI
 * distinguish "provider not configured" (show a configuration banner) from
 * "provider failed" (offer retry) from "plan limit reached" (offer upgrade) —
 * the distinction §42 and §37 require.
 */

import { isBlockingCode } from "@/lib/errors";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }

  /**
   * Provider is unusable until an operator acts — no credentials, or no credit.
   * Rendered as a configuration state rather than a failure: both are things
   * someone fixes in an account, not something the user can retry past.
   */
  get isNotConfigured(): boolean {
    return isBlockingCode(this.code);
  }

  /** The user's plan blocks this; offer an upgrade path. */
  get isPlanLimited(): boolean {
    return (
      this.code === "plan_limit_reached" || this.code === "feature_not_in_plan"
    );
  }

  get isUnauthenticated(): boolean {
    return this.code === "unauthenticated";
  }

  /** Env vars the operator must set, when the server told us. */
  get missingEnvVars(): string[] {
    const value = this.details?.missingEnvVars;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Abort signal, so screens can cancel in-flight requests on unmount. */
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, timeoutMs = 30_000 } = options;

  // Combine the caller's signal with a timeout so a hung request cannot leave
  // the UI spinning forever (§30: never stuck on "Generating").
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Session cookie is httpOnly; same-origin credentials are required.
      credentials: "same-origin",
      signal: combined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError(504, {
        code: "provider_timeout",
        message: "The request took too long. Please try again.",
      });
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError(0, {
      code: "network_error",
      message: "Could not reach the server. Check your connection.",
    });
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, {
      code: "internal_error",
      message: `Unexpected response from the server (${response.status}).`,
    });
  }

  if (!response.ok) {
    const errorBody =
      typeof payload === "object" && payload !== null && "error" in payload
        ? (payload as { error: ApiErrorBody }).error
        : { code: "internal_error", message: `Request failed (${response.status}).` };
    throw new ApiError(response.status, errorBody);
  }

  return (payload as { data: T }).data;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PUT", body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, "method">) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

/** Narrow an unknown catch value to a displayable message. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
