/**
 * Locating the ffmpeg binary.
 *
 * Its own module, small on purpose: both the renderer and the configuration
 * registry need to know whether an encoder exists, and the registry is imported
 * by server components. Putting this in `render.ts` would drag `child_process`,
 * the S3 client and the timeline model into every page that renders a
 * configuration banner.
 */
import { createRequire } from "node:module";

/**
 * `ffmpeg-static` is CommonJS and exports a bare path string, so it has to be
 * loaded synchronously: `ffmpegBinary()` is called from synchronous configuration
 * code, and `await import()` would force every caller to become async.
 *
 * `createRequire` rather than a bare `require`, and that is not cosmetic — the
 * bare form was silently broken in the one process that matters. Under ESM
 * `require` is not defined at all, the `catch` below read `require is not defined`
 * as "the postinstall was skipped", and the standalone worker — the only process
 * that renders anything — reported `render: not_configured` on a machine with a
 * perfectly good binary. Vitest transpiles to CJS, where the bare form works, so
 * the whole test suite agreed the encoder was present.
 */
const requireCjs = createRequire(import.meta.url);

/**
 * Path to an ffmpeg executable, or null if none is available.
 *
 * `FFMPEG_PATH` wins so an operator can point at a system build (a hardware-
 * accelerated one, typically); otherwise the bundled `ffmpeg-static` binary.
 *
 * The require is wrapped because `ffmpeg-static` downloads a ~80MB binary in a
 * postinstall script, and that script can be skipped — by an install policy that
 * disallows scripts, or by a deployment that renders with a hosted provider and
 * has no use for a local encoder. Neither should stop the app from booting; both
 * should surface as `render: not_configured`.
 */
export function ffmpegBinary(): string | null {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) return configured;

  try {
    const resolved = requireCjs("ffmpeg-static") as
      | string
      | { default?: string }
      | null;
    const path = typeof resolved === "string" ? resolved : resolved?.default;
    return path && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** True when a local encode is possible. */
export function hasFfmpeg(): boolean {
  return ffmpegBinary() !== null;
}

/**
 * Milliseconds → a seconds argument for `-t`, `-ss`, `trim=duration` and friends.
 *
 * Three decimals because that is the resolution the timeline model has — every offset
 * in it is an integer millisecond — and because ffmpeg parses a bare number as seconds.
 * Clamped at zero: a negative duration makes ffmpeg read the flag as absent and encode
 * the entire input, which is a much worse failure than a zero-length one.
 *
 * Here rather than in `render.ts` because both the sequential builder and the edit
 * compositor format times, and two copies of a rounding rule eventually disagree by a
 * frame.
 */
export function secondsArg(ms: number): string {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3);
}
