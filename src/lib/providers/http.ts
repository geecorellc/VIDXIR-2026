/**
 * Shared HTTP client for provider APIs (§32, §30).
 *
 * Distinct from `fetch.ts`, and the distinction is the point:
 *
 *  - `fetch.ts` downloads a **URL a provider chose**. The host is untrusted, so it
 *    is allow-listed and address-checked (SSRF).
 *  - This module calls an **endpoint we chose**, with our API key attached. The
 *    host is a constant in our own source, so the risk is not SSRF — it is a
 *    404 or a 429 being reported to the user as "something went wrong".
 *
 * So what lives here is the translation table: which upstream statuses are worth
 * another attempt, which mean an operator has to fix a credential, and which mean
 * an account has run out of money. Every provider module routes through it so the
 * five media stages classify failures the same way `ai.ts` already does.
 */
import {
  ProviderAuthError,
  ProviderError,
  ProviderOutOfCreditError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from "@/lib/errors";

/** Default ceiling for an API call. Renders poll, they do not block this long. */
const DEFAULT_TIMEOUT_MS = 90_000;

export interface ProviderRequest {
  /** Human provider name used in error messages, e.g. "ElevenLabs". */
  provider: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /**
   * Request body. A string or `FormData` is sent verbatim (and `content-type` is
   * left to the runtime, which is required for multipart's boundary); anything
   * else is serialised as JSON.
   */
  body?: unknown;
  timeoutMs?: number;
  /**
   * Statuses to return rather than throw on, so a caller can branch. Used by the
   * render poller, where a 404 on a render id is meaningful rather than fatal.
   */
  allowStatuses?: readonly number[];
}

/** Call a provider API and parse a JSON response. */
export async function providerJson<T>(request: ProviderRequest): Promise<T> {
  const response = await send(request, "application/json");
  const text = await response.text();

  if (!text.trim()) {
    throw new ProviderError(request.provider, "returned an empty response", {
      retryable: true,
      details: { status: response.status },
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(request.provider, "returned malformed JSON", {
      retryable: true,
      details: { status: response.status },
    });
  }
}

/** Call a provider API and return the raw bytes — audio, images, media. */
export async function providerBytes(
  request: ProviderRequest,
  options: { maxBytes: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await send(request, "*/*");
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength === 0) {
    throw new ProviderError(request.provider, "returned an empty file", {
      retryable: true,
    });
  }

  if (buffer.byteLength > options.maxBytes) {
    throw new ProviderError(
      request.provider,
      `returned ${Math.round(buffer.byteLength / 1_048_576)}MB, over the ${Math.round(
        options.maxBytes / 1_048_576,
      )}MB limit`,
      { retryable: false, details: { bytes: buffer.byteLength } },
    );
  }

  return {
    bytes: buffer,
    contentType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ??
      "application/octet-stream",
  };
}

/**
 * Send the request, mapping a non-OK status onto Tally's error taxonomy.
 *
 * The upstream body is read into the message only after being truncated, and it
 * is never shown to a user — `AppError.message` for these codes is the operator
 * copy, and the API layer sends the user-facing string. A provider that echoes a
 * key fragment in an error body must not be able to put it on a screen.
 */
async function send(
  request: ProviderRequest,
  accept: string,
): Promise<Response> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const hasBody = request.body !== undefined && request.body !== null;
  // FormData and raw bytes must reach fetch untouched. JSON-stringifying FormData
  // produces "{}", and stringifying a Buffer produces a JSON array of integers —
  // both are silently wrong rather than an error, which is why the check is here
  // rather than at each call site.
  const raw =
    typeof request.body === "string" ||
    request.body instanceof Uint8Array ||
    (typeof FormData !== "undefined" && request.body instanceof FormData);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? (hasBody ? "POST" : "GET"),
      signal: controller.signal,
      headers: {
        accept,
        ...(hasBody && !raw ? { "content-type": "application/json" } : {}),
        ...request.headers,
      },
      ...(hasBody
        ? {
            body: raw
              ? // `BodyInit` accepts a `BufferSource`, but a Node `Buffer` is
                // typed over `ArrayBufferLike` rather than `ArrayBuffer`, which
                // the DOM lib rejects even though fetch sends it correctly. The
                // cast is confined to this one expression.
                (request.body as BodyInit)
              : JSON.stringify(request.body),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderTimeoutError(request.provider, timeoutMs, error);
    }
    throw new ProviderError(request.provider, "could not be reached", {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok || request.allowStatuses?.includes(response.status)) {
    return response;
  }

  const detail = await response
    .text()
    .then((t) => t.slice(0, 400))
    .catch(() => "");

  throw translateStatus(request.provider, response, detail);
}

/**
 * Status → error. Exported because this classification is the part worth pinning
 * in tests: it decides whether a stage retries and what the operator is told.
 */
export function translateStatus(
  provider: string,
  response: { status: number; headers: Headers },
  detail: string,
): Error {
  const status = response.status;

  if (status === 401 || status === 403) {
    // 403 is folded in with 401 deliberately. Every provider here uses a single
    // API key with no per-scope permissions, so "forbidden" means the same thing
    // as "unauthorised": the key is wrong, disabled, or on the wrong plan.
    return new ProviderAuthError(
      provider,
      `${provider} rejected our credentials (HTTP ${status}). Check the API key.`,
    );
  }

  if (status === 402 || /quota|credit|insufficient|exceeded your/i.test(detail)) {
    return new ProviderOutOfCreditError(provider);
  }

  if (status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return new ProviderRateLimitError(
      provider,
      Number.isFinite(seconds) && seconds > 0 ? seconds : 30,
    );
  }

  if (status >= 500) {
    return new ProviderError(provider, "is temporarily unavailable", {
      retryable: true,
      details: { status },
    });
  }

  // 4xx: our request was wrong, and it will be wrong again next time.
  return new ProviderError(provider, `rejected the request (HTTP ${status})`, {
    retryable: false,
    details: { status, detail: detail.slice(0, 200) },
  });
}
