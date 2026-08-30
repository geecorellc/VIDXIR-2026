/**
 * Integration-test namespace teardown.
 *
 * The harness gives itself a Redis prefix and a storage bucket of its own
 * (`applyTestNamespaceEnv` below) and then, until this module existed, never emptied
 * either. Postgres was reset between tests by `resetDatabase()`, so the leak was
 * invisible in test outcomes and accumulated across runs instead: a development machine
 * was found holding 7,316 orphaned `tally-test:*` Redis keys and 1,841 orphaned storage
 * prefixes totalling 1.31 GB, none of which any worker or test would ever read again.
 *
 * The danger in a cleanup like this is obvious — it deletes by pattern, and the patterns
 * it deletes by are one character away from the development namespace a developer's real
 * work lives in. Three properties keep that from being a possibility rather than a
 * discipline:
 *
 *  1. **Exact-match namespace guard.** `namespaceIssue()` refuses unless the prefix and
 *     bucket are *exactly* the harness's own constants. Anything else — the application
 *     default `tally`, the development bucket `tally-media`, a staging namespace, a typo
 *     — is refused, not pattern-matched. So pointing a test run at a real namespace
 *     turns cleanup off rather than aiming it at production data. The guard is a pure
 *     function so it can be tested without a delete anywhere near it.
 *  2. **Deletion by enumeration, never by flush.** Redis keys are found with `SCAN` and
 *     removed with `UNLINK`, one explicit list of keys at a time. `FLUSHDB` and
 *     `FLUSHALL` are not reachable from this file: they ignore prefixes entirely, so a
 *     single one of them would destroy the development queues this cleanup exists to
 *     protect. Storage objects are likewise listed and then deleted by key.
 *  3. **Its own connections.** A dedicated Redis client and S3 client, closed on the way
 *     out, rather than the application's cached singletons. Teardown runs *while* files
 *     are closing those singletons (several call `closeRedis()`/`closeQueues()` in their
 *     own `afterAll`), and Vitest does not promise the two hooks are ordered. Borrowing a
 *     connection that another hook is quitting turns cleanup into an intermittent
 *     failure; owning one makes hook order irrelevant.
 *
 * Idempotent by construction: both halves enumerate what currently exists and delete
 * that. A second run finds nothing and deletes nothing, which is what makes it safe to
 * call from both the per-file hook and the whole-run teardown.
 */
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import Redis from "ioredis";

/**
 * The harness's Redis prefix and bucket, defined here rather than in `setup.ts`.
 *
 * Cleanup is the module that must not be wrong about which namespace is disposable, so
 * it owns the definition and `setup.ts` imports it. The dependency deliberately points
 * this way: were the constants over there, this file would import the harness it is the
 * teardown for, and the guard below would be checking a value the thing it guards
 * supplied.
 */
export const TEST_QUEUE_PREFIX = "tally-test";
export const TEST_BUCKET = "tally-test";

/**
 * The connection and namespace variables the harness runs against.
 *
 * Called by `setup.ts` for the worker processes and by the global teardown for the main
 * one, so both agree on which namespace is being cleaned without either restating it.
 * `??=` throughout: an operator who exports one of these deliberately keeps it, and the
 * guard then decides whether that namespace may be emptied.
 */
export function applyTestNamespaceEnv(): void {
  process.env["REDIS_URL"] ??= "redis://127.0.0.1:6379";
  /**
   * A Redis namespace of their own.
   *
   * `QUEUE_PREFIX` defaults to `tally`, which is also what a developer's worker
   * consumes, so without this an integration run enqueues real BullMQ messages into the
   * development queue and then TRUNCATEs the `jobs` rows they point at. A running worker
   * then picks up hundreds of jobs it can never complete. That happened: the first
   * successful worker boot drained a 1099-message backlog, every one failing
   * `Job row <id> not found.`
   *
   * The tests do not need a worker — they call the stage functions directly — so this is
   * purely about not leaving live messages behind for one.
   */
  process.env["QUEUE_PREFIX"] ??= TEST_QUEUE_PREFIX;
  process.env["S3_ENDPOINT"] ??= "http://127.0.0.1:9000";
  process.env["S3_BUCKET"] ??= TEST_BUCKET;
  /**
   * The credentials `docker-compose.yml` gives MinIO.
   *
   * These were previously placeholders, which was invisible for a long time: no suite
   * actually uploaded anything, so nothing ever authenticated. The moment the video
   * pipeline stored its first asset every upload failed with Access Denied. A test bucket
   * that cannot be written to is worse than no test bucket, because the failure surfaces
   * as a `StorageError` from application code and reads like a bug in the pipeline.
   */
  process.env["S3_ACCESS_KEY_ID"] ??= "tallyminio";
  process.env["S3_SECRET_ACCESS_KEY"] ??= "tallyminio";
  process.env["S3_FORCE_PATH_STYLE"] ??= "true";
}

/**
 * Why this namespace must not be emptied, or null when it may be.
 *
 * Exact equality rather than a "looks like a test namespace" test. A `startsWith`
 * check would accept `tally-test` *and* anything a developer typed that happens to
 * begin with it, and a "not equal to tally" check would accept every namespace in the
 * world except one. Equality inverts the failure: the only way to reach a delete is to
 * be in precisely the namespace the harness created, so every mistake — including ones
 * nobody predicted — lands on "refuse".
 *
 * Pure, and exported, so the refusals can be asserted in a test without a live bucket or
 * a live Redis anywhere in the assertion.
 */
export function namespaceIssue(
  prefix: string | undefined,
  bucket: string | undefined,
): string | null {
  if (prefix !== TEST_QUEUE_PREFIX) {
    return (
      `QUEUE_PREFIX is ${prefix === undefined ? "unset" : `"${prefix}"`}, not ` +
      `"${TEST_QUEUE_PREFIX}" — refusing to delete Redis keys in a namespace the ` +
      `integration harness did not create.`
    );
  }
  if (bucket !== TEST_BUCKET) {
    return (
      `S3_BUCKET is ${bucket === undefined ? "unset" : `"${bucket}"`}, not ` +
      `"${TEST_BUCKET}" — refusing to delete objects from a bucket the integration ` +
      `harness did not create.`
    );
  }
  return null;
}

export interface CleanupResult {
  /** Keys removed from the test prefix. */
  redisKeysDeleted: number;
  /** Objects removed from the test bucket. */
  objectsDeleted: number;
  /** Why nothing was deleted, or null when the sweep ran. */
  skipped: string | null;
}

/** How many keys are named in one UNLINK, and how many objects in one delete request. */
const REDIS_BATCH = 200;
const S3_BATCH = 1_000;

/**
 * Empty the integration harness's Redis prefix and storage bucket.
 *
 * Returns counts rather than logging them, so the caller decides whether a sweep is
 * worth reporting and the tests can assert on what happened.
 */
export async function cleanupTestNamespace(): Promise<CleanupResult> {
  const skipped = namespaceIssue(
    process.env["QUEUE_PREFIX"],
    process.env["S3_BUCKET"],
  );
  if (skipped) return { redisKeysDeleted: 0, objectsDeleted: 0, skipped };

  // Sequential, not `Promise.all`: the two halves are independent, but a Redis failure
  // that aborted an in-flight storage sweep would leave a half-cleaned bucket and a
  // less obvious error than the one that caused it.
  const redisKeysDeleted = await cleanupRedis();
  const objectsDeleted = await cleanupStorage();
  return { redisKeysDeleted, objectsDeleted, skipped: null };
}

/**
 * Remove every key under the test prefix.
 *
 * `SCAN`, not `KEYS`: cleanup runs against whatever Redis the developer has, which is
 * also the one holding their development queues, and `KEYS` blocks the server for the
 * length of the keyspace. `UNLINK`, not `DEL`: the reclaim happens on a background
 * thread, so a run that leaked thousands of keys does not stall the next one.
 *
 * The match is `<prefix>:*`. BullMQ, the rate limiter and the advisory locks all build
 * their keys as `<prefix>:<something>`, and the colon is what makes the pattern
 * unambiguous — `tally-test:*` cannot match a `tally:*` key, and no amount of
 * development data shares the prefix.
 */
async function cleanupRedis(): Promise<number> {
  const url = process.env["REDIS_URL"];
  if (!url) return 0;

  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    // Teardown must not inherit the application's patient reconnect policy: a Redis that
    // is already gone should fail this in a second, not retry through the hook timeout.
    retryStrategy: (attempt) => (attempt > 3 ? null : 200),
  });

  let deleted = 0;
  try {
    const stream = redis.scanStream({
      match: `${TEST_QUEUE_PREFIX}:*`,
      count: 500,
    });

    // Buffered into batches rather than unlinked one key at a time: a run leaves
    // thousands of keys, and a round trip each would dominate the teardown.
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const keys = batch;
      batch = [];
      deleted += await redis.unlink(...keys);
    };

    for await (const keys of stream as AsyncIterable<string[]>) {
      /**
       * Re-checked per key, even though the server did the matching.
       *
       * SCAN's MATCH is applied by Redis and is not in doubt; this is here because the
       * cost of the check is nothing and the cost of being wrong is a developer's
       * queues. A key that does not carry the prefix is skipped rather than deleted,
       * so a future change to the pattern cannot widen what this removes.
       */
      for (const key of keys) {
        if (!key.startsWith(`${TEST_QUEUE_PREFIX}:`)) continue;
        batch.push(key);
        if (batch.length >= REDIS_BATCH) await flush();
      }
    }
    await flush();
  } finally {
    // `quit` rather than `disconnect`, so an in-flight UNLINK is not abandoned.
    await redis.quit().catch(() => redis.disconnect());
  }

  return deleted;
}

/**
 * Remove every object in the test bucket.
 *
 * The whole bucket, deliberately: `S3_BUCKET` is the only place `lib/storage` reads a
 * bucket name from, so every object the harness can possibly have written is in this one
 * and nothing else writes here. Scoping further — by key prefix, or to users a test
 * tracked — would miss objects written under a user id the test never returned, which is
 * exactly the 1,841 orphaned prefixes that motivated this module.
 */
async function cleanupStorage(): Promise<number> {
  const bucket = process.env["S3_BUCKET"];
  const endpoint = process.env["S3_ENDPOINT"];
  const accessKeyId = process.env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"];
  if (!bucket || !accessKeyId || !secretAccessKey) return 0;

  const client = new S3Client({
    region: process.env["S3_REGION"] ?? "us-east-1",
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] !== "false",
    credentials: { accessKeyId, secretAccessKey },
  });

  let deleted = 0;
  try {
    let token: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));

      for (let i = 0; i < keys.length; i += S3_BATCH) {
        const chunk = keys.slice(i, i + S3_BATCH);
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        /**
         * A per-key refusal is reported, not swallowed.
         *
         * `Quiet: true` suppresses the successes, so `Errors` is the only thing coming
         * back — and an object storage silently declines to delete is a leak that would
         * otherwise reappear as unexplained growth weeks later.
         */
        const errors = result.Errors ?? [];
        if (errors.length > 0) {
          throw new Error(
            `could not delete ${errors.length} object(s) from ${bucket}: ` +
              errors
                .slice(0, 3)
                .map((e) => `${e.Key ?? "?"} (${e.Code ?? "?"})`)
                .join(", "),
          );
        }
        deleted += chunk.length;
      }

      // `IsTruncated` rather than "did we get 1000": MinIO is free to return fewer.
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  } catch (error) {
    /**
     * A bucket that does not exist yet is nothing to clean.
     *
     * A fresh checkout runs the suite before anything has ever uploaded, and failing
     * teardown because the harness found an empty world would make the first run on a
     * new machine look broken.
     */
    if (isMissingBucket(error)) return deleted;
    throw error;
  } finally {
    client.destroy();
  }

  return deleted;
}

function isMissingBucket(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "NoSuchBucket" || name === "NotFound";
}
