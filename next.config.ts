import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

if (process.env.NODE_ENV === "development") void initOpenNextCloudflareForDev();

/**
 * Origins the browser is allowed to load images from.
 *
 * Thumbnails and rendered previews are served as short-lived signed URLs from
 * object storage, so the storage origin has to be in `img-src` or the Thumbnail
 * and Publish panels render broken images. It is derived from `S3_ENDPOINT` rather
 * than hard-coded, because that endpoint is MinIO in development and a real S3 or
 * R2 host in production.
 *
 * With no explicit endpoint the deployment is using AWS S3's regional hostnames,
 * which are not knowable here, so `https:` is the honest fallback — narrower than
 * `*` (it still forbids http and data:) and wider than we would like. Setting
 * `S3_ENDPOINT` or `CSP_IMG_ORIGINS` tightens it to exact hosts.
 */
/**
 * YouTube's own image hosts, which are not derivable from any variable.
 *
 * The source-analysis panel and the channel list display a thumbnail straight from
 * YouTube's CDN — deliberately, because Vidxir AI must not fetch, store or re-encode
 * another creator's media (§22), so the URL goes to the browser and the bytes never
 * touch a Vidxir AI server. That design only works if the browser is allowed to load it:
 * with these absent, `img-src` was `'self' data: blob:` plus the storage origin, and
 * every source thumbnail and channel avatar was blocked by our own policy and rendered
 * broken. The panel looked like it had failed to analyse the video when in fact it had.
 *
 * Constants rather than an env var, because they are a property of YouTube rather than
 * of a deployment: `i.ytimg.com` serves video thumbnails, `yt3.ggpht.com` and
 * `yt3.googleusercontent.com` serve channel avatars. An operator should not have to
 * discover them to make a core screen display correctly. `CSP_IMG_ORIGINS` remains the
 * place for deployment-specific hosts like a CDN.
 */
const YOUTUBE_IMAGE_ORIGINS = [
  "https://i.ytimg.com",
  "https://yt3.ggpht.com",
  "https://yt3.googleusercontent.com",
] as const;

function imageOrigins(): string[] {
  const origins = new Set<string>();
  for (const raw of [
    process.env.S3_ENDPOINT,
    ...(process.env.CSP_IMG_ORIGINS ?? "").split(","),
  ]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Not a URL — ignore rather than emit a malformed directive, which some
      // browsers respond to by dropping the whole policy.
    }
  }
  return origins.size > 0 ? [...origins] : ["https:"];
}

/**
 * Content-Security-Policy (§3).
 *
 * What this policy is honestly worth, directive by directive, because a CSP that
 * is described as stronger than it is invites someone to stop looking:
 *
 *  - `script-src` includes `'unsafe-inline'`. Next's App Router emits inline
 *    bootstrap and flight-data scripts on every page. Eliminating that needs
 *    nonce-based CSP, which requires generating a nonce per request in middleware
 *    and therefore makes every route dynamic — a real change to the application's
 *    caching behaviour, which §20 says not to make speculatively and §2 does not
 *    put in scope. So this directive is not an XSS defence, and is not claimed as
 *    one; what it does do is confine script loading to our own origin, so an
 *    injected `<script src="//evil/x.js">` is still refused.
 *  - `style-src` includes `'unsafe-inline'` for two structural reasons: the UI is
 *    styled with React inline style objects throughout (ported from the
 *    prototype), and `GlobalStyle` injects an authored stylesheet. Google Fonts is
 *    listed because that stylesheet `@import`s from it.
 *  - `object-src 'none'` and `base-uri 'self'` are absolute, and both close real
 *    injection routes that do not depend on inline script: a planted `<object>`
 *    and a planted `<base href>` that would silently re-target every relative URL
 *    on the page.
 *  - `form-action 'self'` stops an injected form from posting a user's input to
 *    another origin.
 *  - `frame-ancestors 'none'` is the modern clickjacking control and supersedes
 *    `X-Frame-Options`, which is kept alongside it for older browsers.
 *  - `connect-src 'self'` — every fetch this app makes is to its own API. Provider
 *    calls all happen server-side, which is why no provider host appears here.
 *  - `upgrade-insecure-requests` in production only; in development the app is
 *    served over http and the directive would break every asset.
 */
function contentSecurityPolicy(): string {
  const isProduction = process.env.NODE_ENV === "production";

  const directives: string[] = [
    "default-src 'self'",
    // 'unsafe-eval' is required by React Fast Refresh, and only in development.
    `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    /**
     * YouTube's hosts are added to `img-src` only, not to `media-src`.
     *
     * Vidxir AI displays a remote *thumbnail*; it never plays remote video or audio. Listing
     * these under `media-src` would permit a `<video src="https://…youtube…">` that
     * nothing in the app creates, and §22's line is that source media is never
     * fetched — so the narrower directive is the one that matches what the code does.
     */
    `img-src 'self' data: blob: ${[...imageOrigins(), ...YOUTUBE_IMAGE_ORIGINS].join(" ")}`,
    // blob: covers the rendered-video preview element.
    `media-src 'self' blob: ${imageOrigins().join(" ")}`,
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Sandboxed srcDoc mail previews use about: documents; external frames stay blocked.
    "frame-src 'self' about:",
  ];

  if (isProduction) directives.push("upgrade-insecure-requests");

  return directives.join("; ");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only packages must never be bundled into the browser build (§34).
  serverExternalPackages: ["postgres", "bullmq", "ioredis", "googleapis"],
  eslint: {
    dirs: ["src"],
  },
  async headers() {
    const isProduction = process.env.NODE_ENV === "production";

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          /**
           * HSTS, production only.
           *
           * Sent over http it is ignored, but it would also be sent by a local
           * dev server on localhost — and a browser that pins localhost to https
           * makes every other project on the machine unreachable until the pin is
           * manually cleared. Two years with subdomains; `preload` is deliberately
           * absent, because that submission is an operator decision with a
           * genuinely painful rollback, not something a config file should make
           * on their behalf.
           */
          ...(isProduction
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
      {
        /**
         * Probe endpoints must never be cached — by a browser, a CDN, or a proxy.
         * A cached readiness answer is what makes a load balancer keep a drained
         * instance in rotation.
         */
        source: "/api/:path(health|ready)",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
