/**
 * Distributed task locks (§11).
 *
 * The scheduler's overlap guard is an in-process `Set`, which is correct for one
 * process and says nothing about two. Running two scheduler replicas — the normal
 * way to survive a node restart — makes every task run twice: `prune-sessions`
 * twice is harmless, but `ingest-analytics` twice doubles YouTube Analytics quota
 * spend on every channel, and quota is the resource Phase 9 is most constrained
 * by. `runAutomationTick` was already safe, because it claims each channel's slot
 * with a conditional UPDATE; the other three tasks had no equivalent.
 *
 * So: one lock per task name, in Redis, which is already a hard dependency.
 *
 *  - **Acquisition** is `SET key owner NX PX ttl` — a single atomic command, so
 *    two replicas racing on the same tick cannot both win.
 *  - **Stale recovery** is the TTL itself. A holder that is SIGKILLed, loses its
 *    network, or hangs never releases, and no amount of application code in the
 *    dead process can fix that. The lock therefore expires on its own, and the
 *    next tick picks the work up. This is why the TTL is the only recovery
 *    mechanism worth having: it needs nothing from the failed party.
 *  - **Liveness under a long task** is a heartbeat that extends the TTL while the
 *    work is genuinely still running. Without it the TTL would have to be longer
 *    than the slowest imaginable pass, which would in turn make real recovery
 *    slow. With it, the TTL can be short.
 *  - **Release** compares the owner token before deleting. A holder that overran
 *    its TTL must not delete the lock a *different* replica has since taken —
 *    that would be the one bug this module exists to prevent, reintroduced at the
 *    end of the critical section.
 *
 * This is not a consensus protocol and does not try to be. With a single Redis it
 * is exactly as available as Redis; on a failover with unreplicated writes two
 * holders are briefly possible. That residual risk is acceptable here precisely
 * because none of the guarded tasks is destructive: the worst outcome is the
 * duplicate work this module usually prevents, and the operations underneath are
 * idempotent (analytics ingestion upserts on a unique `(video, date)` index,
 * stats refresh overwrites, session pruning is a delete by expiry).
 */
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { coordinate } from "@/lib/cloudflare/coordination";

const log = logger.child({ component: "lock" });

function lockKey(name: string): string {
  return `${env().QUEUE_PREFIX}:lock:${name}`;
}

export interface Lock {
  readonly name: string;
  /** Opaque per-acquisition identity. Only the holder knows it. */
  readonly owner: string;
  /** Stop the heartbeat and release, if still held. */
  release(): Promise<void>;
}

export interface LockOptions {
  /**
   * How long the lock survives without a heartbeat. Also the worst-case delay
   * before a crashed holder's work is retried.
   */
  ttlMs?: number;
  /** Heartbeat interval. Must be comfortably below `ttlMs`. */
  renewMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Try to take `name`. Returns null when another holder has it — the caller skips
 * this tick, which is the desired behaviour for every periodic task here.
 */
export async function acquireLock(
  name: string,
  options: LockOptions = {},
): Promise<Lock | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  // A third of the TTL gives two chances to renew before expiry, so one dropped
  // heartbeat does not release a lock whose work is still running.
  const renewMs = options.renewMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
  const key = lockKey(name);
  const owner = randomUUID();

  const result = await coordinate<boolean>(key, "acquire", { owner, ttlMs });
  if (!result) {
    log.debug("lock held elsewhere", { task: name });
    return null;
  }

  let released = false;
  const heartbeat = setInterval(() => {
    void coordinate<boolean>(key, "renew", { owner, ttlMs })
      .then((extended) => {
        if (!extended && !released) {
          // We lost it — almost certainly because this process stalled past the
          // TTL. Logged loudly: it means the guarantee lapsed, and a second
          // holder may now be running the same task.
          log.warn("lock expired while task was still running", {
            task: name,
            ttlMs,
          });
        }
      })
      .catch((error: unknown) => {
        log.warn("lock renewal failed", { task: name, error });
      });
  }, renewMs);
  // Never hold the event loop open for a heartbeat.
  heartbeat.unref?.();

  return {
    name,
    owner,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        await coordinate(key, "release", { owner });
      } catch (error) {
        // Not fatal: the TTL releases it shortly regardless. Logged rather than
        // thrown so a Redis blip at the end of a successful pass does not turn
        // that pass into a failure.
        log.warn("lock release failed; will expire on its own", {
          task: name,
          error,
        });
      }
    },
  };
}

/**
 * Run `fn` under `name`, or skip it if someone else holds the lock.
 *
 * Returns whether the work ran, so a caller can distinguish "did nothing because
 * another replica is on it" from "did nothing because there was nothing to do".
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  const lock = await acquireLock(name, options);
  if (!lock) return { ran: false };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await lock.release();
  }
}

/**
 * Whether `name` is currently held, without taking it. Diagnostics only — a
 * caller must never branch on this and then act, which would be exactly the
 * read-then-decide race the lock prevents.
 */
export async function lockHeld(name: string): Promise<boolean> {
  return (await coordinate<{ held: boolean }>(lockKey(name), "status")).held;
}

/** Remaining lifetime in ms, or null when not held. Diagnostics only. */
export async function lockTtlMs(name: string): Promise<number | null> {
  return (await coordinate<{ ttlMs: number | null }>(lockKey(name), "status")).ttlMs;
}
