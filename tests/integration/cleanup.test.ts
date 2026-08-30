/**
 * Tests for the integration harness's own teardown.
 *
 * This is the one module in the suite whose bugs destroy data rather than failing a test,
 * so it is tested from two directions:
 *
 *  - The **guard** is a pure function, so every refusal is asserted with no live
 *    connection in the assertion at all. That is where the `tally` / `tally-media` cases
 *    live: proving the sweep refuses those namespaces must not involve pointing it at
 *    them and checking afterwards.
 *  - The **sweep** is exercised against real Redis and real MinIO, because "deletes what
 *    it should and nothing else" is a property of the commands that actually run.
 *
 * The survivor keys these tests plant are named `tally:__cleanup_probe__:*` — inside the
 * development prefix, so a sweep that ignored its own pattern would take them, but under
 * a segment nothing in Tally writes, so the five real queued development jobs are never
 * what is being risked. They are removed by name in `afterAll`, never by pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestNamespace,
  namespaceIssue,
  TEST_BUCKET,
  TEST_QUEUE_PREFIX,
} from "./cleanup";
import { hasDatabase } from "./setup";

// ---------------------------------------------------------------------------
// The guard — pure, so the dangerous namespaces are named but never touched
// ---------------------------------------------------------------------------

describe("the namespace guard", () => {
  it("permits exactly the harness's own namespace", () => {
    expect(namespaceIssue(TEST_QUEUE_PREFIX, TEST_BUCKET)).toBeNull();
  });

  it("refuses the development Redis prefix", () => {
    // `tally` is what a developer's worker consumes and what the five queued
    // development jobs live under. A sweep here would delete real work.
    const issue = namespaceIssue("tally", TEST_BUCKET);
    expect(issue).toContain("refusing to delete Redis keys");
    expect(issue).toContain("tally");
  });

  it("refuses the development media bucket", () => {
    // `tally-media` holds ~2.2 GB of real rendered development media, including the
    // export `verify:editor` reads. Note it shares a prefix with `tally-test`: a
    // `startsWith` guard would have accepted it.
    const issue = namespaceIssue(TEST_QUEUE_PREFIX, "tally-media");
    expect(issue).toContain("refusing to delete objects");
    expect(issue).toContain("tally-media");
  });

  it("refuses a namespace that merely starts with the test name", () => {
    // The reason the guard is equality and not a prefix match, stated as a test:
    // `tally-test-staging` is somebody else's namespace.
    expect(namespaceIssue("tally-test-staging", TEST_BUCKET)).not.toBeNull();
    expect(namespaceIssue(TEST_QUEUE_PREFIX, "tally-test-2")).not.toBeNull();
  });

  it("refuses an unset namespace rather than defaulting", () => {
    // An undefined `QUEUE_PREFIX` means the application default `tally` is in force,
    // which is the worst case, so it must not read as "nothing configured, safe".
    expect(namespaceIssue(undefined, TEST_BUCKET)).toContain("unset");
    expect(namespaceIssue(TEST_QUEUE_PREFIX, undefined)).toContain("unset");
  });
});

// ---------------------------------------------------------------------------
// The sweep — against live Redis and live MinIO
// ---------------------------------------------------------------------------

/**
 * Gated on `hasDatabase` for consistency with every other integration file: it is the
 * one flag that says "the docker services are up", and Redis and MinIO come up with
 * Postgres in the same compose file.
 */
const describeLive = hasDatabase ? describe : describe.skip;

describeLive("cleanupTestNamespace", () => {
  /** A segment of the development prefix that no part of Tally writes. */
  const PROBE = `tally:__cleanup_probe__`;
  const probeKeys = [`${PROBE}:queue:wait`, `${PROBE}:ratelimit:read:u1`];

  let redis: import("ioredis").default;
  let s3: import("@aws-sdk/client-s3").S3Client;

  beforeAll(async () => {
    const { default: Redis } = await import("ioredis");
    const { S3Client } = await import("@aws-sdk/client-s3");

    redis = new Redis(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: 3,
    });
    s3 = new S3Client({
      region: process.env["S3_REGION"] ?? "us-east-1",
      ...(process.env["S3_ENDPOINT"]
        ? { endpoint: process.env["S3_ENDPOINT"] }
        : {}),
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "tallyminio",
        secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "tallyminio",
      },
    });
  });

  afterAll(async () => {
    // By name, one at a time. A pattern delete here would be the exact mistake the
    // module under test exists to avoid, in the file that tests it.
    for (const key of probeKeys) await redis.del(key);
    await redis.quit().catch(() => redis.disconnect());
    s3.destroy();
  });

  /** Plant keys in both namespaces and objects in the test bucket. */
  async function seed(): Promise<void> {
    for (const key of probeKeys) await redis.set(key, "survivor");
    await redis.set(`${TEST_QUEUE_PREFIX}:pipeline:wait`, "disposable");
    await redis.set(`${TEST_QUEUE_PREFIX}:ratelimit:read:u1`, "disposable");
    await redis.set(`${TEST_QUEUE_PREFIX}:lock:scheduler`, "disposable");

    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    for (const key of ["u/probe-user/video/a.mp4", "u/probe-user/voiceover/b.mp3"]) {
      await s3.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
          Body: Buffer.from("probe"),
          ContentType: "application/octet-stream",
        }),
      );
    }
  }

  async function countKeys(pattern: string): Promise<number> {
    let total = 0;
    const stream = redis.scanStream({ match: pattern, count: 500 });
    for await (const keys of stream as AsyncIterable<string[]>) total += keys.length;
    return total;
  }

  async function countObjects(bucket: string): Promise<number> {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    let total = 0;
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      total += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  it("removes the test namespace's Redis keys and objects", async () => {
    await seed();
    expect(await countKeys(`${TEST_QUEUE_PREFIX}:*`)).toBeGreaterThan(0);
    expect(await countObjects(TEST_BUCKET)).toBeGreaterThan(0);

    const result = await cleanupTestNamespace();

    expect(result.skipped).toBeNull();
    expect(result.redisKeysDeleted).toBeGreaterThan(0);
    expect(result.objectsDeleted).toBeGreaterThan(0);
    expect(await countKeys(`${TEST_QUEUE_PREFIX}:*`)).toBe(0);
    expect(await countObjects(TEST_BUCKET)).toBe(0);
  });

  it("leaves development `tally:*` keys untouched", async () => {
    await seed();
    await cleanupTestNamespace();

    // Read back by name and by value: present, and still holding what was written, so
    // this cannot pass against a key the sweep deleted and something else recreated.
    for (const key of probeKeys) {
      expect(await redis.get(key)).toBe("survivor");
    }
  });

  it("leaves the development media bucket untouched", async () => {
    /**
     * Counted, not modified. The sweep is aimed at `tally-test` by the environment, and
     * the assertion is that a bucket it was never pointed at is the same size either
     * side of it — which is the only honest way to test this without writing to the
     * 2.2 GB of real development media.
     */
    const before = await countObjects("tally-media").catch(() => null);
    await seed();
    await cleanupTestNamespace();
    const after = await countObjects("tally-media").catch(() => null);

    expect(after).toBe(before);
  });

  it("is idempotent", async () => {
    await seed();

    const first = await cleanupTestNamespace();
    const second = await cleanupTestNamespace();

    expect(first.redisKeysDeleted).toBeGreaterThan(0);
    // The second pass finds an empty namespace: no keys, no objects, and no error —
    // which is what lets the per-run hook and a manual call coexist.
    expect(second.skipped).toBeNull();
    expect(second.redisKeysDeleted).toBe(0);
    expect(second.objectsDeleted).toBe(0);
  });

  it("deletes nothing when pointed outside the test namespace", async () => {
    await seed();
    const prefix = process.env["QUEUE_PREFIX"];
    process.env["QUEUE_PREFIX"] = "tally";

    try {
      const result = await cleanupTestNamespace();

      expect(result.skipped).toContain("refusing");
      expect(result.redisKeysDeleted).toBe(0);
      expect(result.objectsDeleted).toBe(0);
      // The disposable keys survive precisely because the guard fired. A sweep that
      // ignored the guard would have emptied the test namespace here.
      expect(await countKeys(`${TEST_QUEUE_PREFIX}:*`)).toBeGreaterThan(0);
    } finally {
      process.env["QUEUE_PREFIX"] = prefix;
    }

    // Cleaned up through the real path now that the namespace is restored.
    await cleanupTestNamespace();
  });
});
