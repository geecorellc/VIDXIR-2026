/**
 * Guarded remote asset fetch (§34, §22).
 *
 * The visuals and music stages download files from provider CDNs. That is the one
 * place in Tally where a URL chosen by an upstream API is passed to an HTTP client
 * running inside our network, which is the classic SSRF shape: a compromised or
 * merely sloppy provider response naming `http://169.254.169.254/` or
 * `http://localhost:5432/` would be fetched by us, from inside, with our
 * credentials on the machine.
 *
 * Four defences, all of them structural rather than advisory:
 *
 *  1. **Allow-list, not deny-list.** A host must match a provider CDN compiled
 *     into `PROVIDER_HOSTS` or an operator entry in `ASSET_FETCH_ALLOWED_HOSTS`.
 *     Anything else is refused before a socket is opened. A deny-list of private
 *     ranges is the wrong shape here — we know exactly which six companies we
 *     download from.
 *  2. **Address check after resolution.** An allow-listed name that resolves into
 *     a private, loopback, link-local or unique-local range is refused, which is
 *     what stops a DNS-rebinding answer from a hostile authoritative server.
 *  3. **Manual redirects.** Every hop is re-validated. `redirect: "follow"` would
 *     let an allow-listed host bounce us to metadata on the first response.
 *  4. **A byte ceiling.** `MAX_REMOTE_ASSET_BYTES` is enforced on the declared
 *     `content-length` *and* on the stream, because a chunked response can lie by
 *     omission. A 4K stock clip is ~60 MB; the 500 MB default is generous for one
 *     asset and small enough that a worker cannot be made to exhaust its heap.
 *
 * Everything here throws `ProviderError`, so a bad URL from a provider is
 * attributed to that provider in the logs and in `api_usage` rather than
 * surfacing as an anonymous network fault.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "@/lib/env";
import { ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "asset-fetch" });

/**
 * Registrable domains Tally downloads media from, by provider.
 *
 * Matching is exact-or-subdomain, so `videos.pexels.com` is covered by
 * `pexels.com` while `pexels.com.attacker.net` is not. Kept in code rather than
 * in configuration because it is a property of the integrations we wrote, not of
 * the deployment — `.env.example` says exactly this.
 */
const PROVIDER_HOSTS: readonly string[] = [
  // Pexels — stock photo and video files.
  "pexels.com",
  // Freesound — music and SFX downloads.
  "freesound.org",
  // ElevenLabs — voiceover audio comes back on the API host itself.
  "elevenlabs.io",
  // Shotstack — render output and poster frames.
  "shotstack.io",
  "shotstack-api-stage-output.s3.ap-southeast-2.amazonaws.com",
  "shotstack-api-v1-output.s3.ap-southeast-2.amazonaws.com",
  // Runway — generated clips are served from a CloudFront distribution whose
  // name is not documented as stable, so operators extend the list via env.
  "runwayml.com",
];

/** Redirect hops allowed. Providers use one (CDN indirection); three is slack. */
const MAX_REDIRECTS = 3;

/** Wall-clock ceiling for one download. A 60 MB clip on a slow link fits. */
const TIMEOUT_MS = 120_000;

export interface RemoteAsset {
  bytes: Buffer;
  contentType: string;
  /** The URL the bytes actually came from, after redirects. Recorded for §29. */
  finalUrl: string;
}

export interface FetchRemoteOptions {
  /** Provider name, used for error attribution. */
  provider: string;
  /** Override the byte ceiling downwards (e.g. images do not need 500 MB). */
  maxBytes?: number;
  /** Extra hosts this specific call may reach, on top of the allow-list. */
  extraHosts?: readonly string[];
  /** Sent as `Accept`. Providers occasionally content-negotiate. */
  accept?: string;
  headers?: Record<string, string>;
}

/**
 * True when a download was refused only for being over the byte ceiling.
 *
 * A caller holding several candidates for the same slot (stock renditions of one
 * clip, then other clips) should step over this and try the next; every other
 * fault means the fetch itself is in trouble and is worth surfacing. Exported so
 * that judgement is made against a flag rather than an error message.
 */
export function isOversizeAsset(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.details as { oversize?: unknown } | undefined)?.oversize === true
  );
}

/**
 * Download a provider asset into memory.
 *
 * In memory rather than streamed to storage because every consumer needs the
 * bytes anyway — `putObject` checksums them, and the checksum is what detects a
 * duplicate stock download later. The byte ceiling is what makes that safe.
 */
export async function fetchRemoteAsset(
  rawUrl: string,
  options: FetchRemoteOptions,
): Promise<RemoteAsset> {
  const ceiling = Math.min(
    options.maxBytes ?? env().MAX_REMOTE_ASSET_BYTES,
    env().MAX_REMOTE_ASSET_BYTES,
  );

  let url = await validateUrl(rawUrl, options);
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await request(url, options);

    if (!isRedirect(response.status)) break;

    const location = response.headers.get("location");
    // Drain the redirect body so the socket is released to the agent pool.
    await response.arrayBuffer().catch(() => undefined);

    if (!location) {
      throw new ProviderError(
        options.provider,
        `redirected without a Location header (${response.status})`,
        { retryable: true, details: { url: url.href } },
      );
    }

    if (hop === MAX_REDIRECTS) {
      throw new ProviderError(options.provider, "too many redirects", {
        retryable: false,
        details: { url: url.href },
      });
    }

    // Resolved against the current URL, then re-validated from scratch: the
    // whole point of manual redirects is that hop N+1 gets the same scrutiny as
    // hop 0.
    url = await validateUrl(new URL(location, url).href, options);
  }

  if (!response) {
    throw new ProviderError(options.provider, "no response", { retryable: true });
  }

  if (!response.ok) {
    // 4xx from a CDN is usually an expired signed URL — worth one more attempt
    // only if the provider itself is likely to hand back a fresh one, which it
    // is not from here. 5xx is transient.
    throw new ProviderError(
      options.provider,
      `download failed with HTTP ${response.status}`,
      {
        retryable: response.status >= 500 || response.status === 429,
        details: { url: url.href, status: response.status },
      },
    );
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ceiling) {
    throw new ProviderError(
      options.provider,
      `asset is ${Math.round(declared / 1_048_576)}MB, over the ${Math.round(
        ceiling / 1_048_576,
      )}MB limit`,
      {
        retryable: false,
        // `oversize` lets a caller with other candidates step over this one
        // rather than parse the message. See `isOversizeAsset`.
        details: { url: url.href, bytes: declared, oversize: true },
      },
    );
  }

  const bytes = await readCapped(response, ceiling, options.provider, url.href);

  if (bytes.byteLength === 0) {
    throw new ProviderError(options.provider, "downloaded an empty file", {
      retryable: true,
      details: { url: url.href },
    });
  }

  log.debug("asset downloaded", {
    provider: options.provider,
    host: url.hostname,
    bytes: bytes.byteLength,
  });

  return {
    bytes,
    contentType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ??
      "application/octet-stream",
    finalUrl: url.href,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse, allow-list and address-check a URL. Exported for the unit tests, which
 * are the only honest way to prove the private-range refusals: the alternative is
 * a test that actually tries to reach 169.254.169.254.
 */
export async function validateUrl(
  rawUrl: string,
  options: Pick<FetchRemoteOptions, "provider" | "extraHosts">,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError(options.provider, "returned a malformed asset URL", {
      retryable: false,
      details: { url: rawUrl.slice(0, 200) },
    });
  }

  if (url.protocol !== "https:") {
    // Plaintext would also mean an asset a network position could substitute.
    throw new ProviderError(
      options.provider,
      `asset URL is not https (${url.protocol.replace(":", "")})`,
      { retryable: false, details: { url: url.href } },
    );
  }

  if (url.username || url.password) {
    // `https://allowed.example@evil.test/` reads as allow-listed to a human.
    throw new ProviderError(
      options.provider,
      "asset URL carries embedded credentials",
      { retryable: false, details: { host: url.hostname } },
    );
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (!isAllowedHost(host, options.extraHosts)) {
    throw new ProviderError(
      options.provider,
      `asset host ${host} is not allow-listed. Add it to ASSET_FETCH_ALLOWED_HOSTS if it is expected.`,
      { retryable: false, details: { host } },
    );
  }

  await assertPublicAddress(host, options.provider);

  return url;
}

/** Exact match or a subdomain of an allow-listed registrable domain. */
export function isAllowedHost(
  host: string,
  extraHosts: readonly string[] = [],
): boolean {
  const allowed = [
    ...PROVIDER_HOSTS,
    ...env().ASSET_FETCH_ALLOWED_HOSTS,
    ...extraHosts,
  ].map((h) => h.trim().toLowerCase().replace(/^\.+|\.+$/g, ""));

  return allowed.some(
    (domain) =>
      domain.length > 0 && (host === domain || host.endsWith(`.${domain}`)),
  );
}

/**
 * Refuse a host that resolves inside the network.
 *
 * There is an unavoidable TOCTOU window between this lookup and the connection
 * the fetch makes, which is why the allow-list above is the primary control and
 * this is the second layer: an attacker would need to both own an allow-listed
 * domain and win the race.
 */
async function assertPublicAddress(
  host: string,
  provider: string,
): Promise<void> {
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await resolve(host, provider);

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new ProviderError(
        provider,
        `asset host ${host} resolves to a private address and will not be fetched`,
        { retryable: false, details: { host, address: entry.address } },
      );
    }
  }
}

async function resolve(
  host: string,
  provider: string,
): Promise<Array<{ address: string; family: number }>> {
  try {
    const result = await lookup(host, { all: true, verbatim: true });
    if (result.length === 0) throw new Error("no addresses");
    return result;
  } catch (error) {
    throw new ProviderError(provider, `could not resolve ${host}`, {
      retryable: true,
      cause: error,
      details: { host },
    });
  }
}

/**
 * True for anything not routable on the public internet.
 *
 * Written out rather than pulled from a package because the list is short, the
 * failure mode of a wrong entry is a security hole, and each range deserves the
 * comment saying why it is here.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  // Not an address at all — treat as unsafe rather than as public.
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata range
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (lower === "::" || lower === "::1") return true; // unspecified, loopback
  if (lower.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true; // multicast

  // IPv4-mapped (::ffff:169.254.169.254) is the classic bypass.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);

  return false;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function request(
  url: URL,
  options: FetchRemoteOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        // Some CDNs 403 an unidentified client.
        "user-agent": "Tally/1.0 (+https://tally.video)",
        ...(options.accept ? { accept: options.accept } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError(
        options.provider,
        `download timed out after ${TIMEOUT_MS / 1000}s`,
        { retryable: true, details: { url: url.href } },
      );
    }
    throw new ProviderError(options.provider, "download failed", {
      retryable: true,
      cause: error,
      details: { url: url.href },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body, aborting the moment it exceeds the ceiling.
 *
 * `response.arrayBuffer()` would buffer the whole thing first and only then let
 * us complain about the size, which is the wrong order when the point of the
 * limit is not to hold it in memory.
 */
async function readCapped(
  response: Response,
  ceiling: number,
  provider: string,
  url: string,
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    throw new ProviderError(provider, "response had no body", {
      retryable: true,
      details: { url },
    });
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > ceiling) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(
          provider,
          `asset exceeded the ${Math.round(ceiling / 1_048_576)}MB limit mid-download`,
          { retryable: false, details: { url, bytes: total, oversize: true } },
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, "download was interrupted", {
      retryable: true,
      cause: error,
      details: { url },
    });
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
