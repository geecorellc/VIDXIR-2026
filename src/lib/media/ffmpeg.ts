/**
 * Locating the ffmpeg binary.
 *
 * Its own module, small on purpose: both the renderer and the configuration
 * registry need to know whether an encoder exists, and the registry is imported
 * by server components. Putting this in `render.ts` would drag `child_process`,
 * the S3 client and the timeline model into every page that renders a
 * configuration banner.
 */
import "server-only";

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolved = require("ffmpeg-static") as string | { default?: string } | null;
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
