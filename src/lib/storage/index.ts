/**
 * StorageProvider — object storage for every binary Tally produces (§22, §32).
 *
 * Two rules are structural here rather than remembered:
 *  1. Bytes never enter Postgres. The `assets` table stores a `storage_key`; the
 *     object lives in S3/MinIO. Nothing in this module writes to the database.
 *  2. Reads go out as short-lived presigned URLs. The bucket stays private, so a
 *     leaked URL expires instead of exposing a permanent public asset.
 *
 * A key is namespaced by user id, which means an object's path itself records
 * which tenant owns it — useful when auditing storage, and it makes an
 * accidentally cross-tenant key visible rather than silent (§34).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";
import { StorageError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "storage" });

/**
 * Kinds of object Tally stores, used to build readable keys.
 *
 * `reference` is its own folder rather than more objects under `visual`, and the
 * reason is lifecycle rather than tidiness. A visual is one scene's footage: it is
 * superseded when that scene is regenerated and is a candidate for expiry once the
 * project is rendered. A continuity reference still is the opposite — it is read by
 * every later scene and by the human reviewing the cast, so it outlives the visuals
 * made from it. Sharing a prefix would mean any retention rule written for one silently
 * applies to the other.
 */
export type StorageFolder =
  | "voiceover"
  | "visual"
  | "music"
  | "caption"
  | "video"
  | "thumbnail"
  | "poster"
  | "reference"
  | "upload";

let client: S3Client | undefined;

function s3(): S3Client {
  if (client) return client;
  const e = env();
  client = new S3Client({
    region: e.S3_REGION,
    // Set for MinIO and other S3-compatible endpoints; unset for real AWS.
    ...(e.S3_ENDPOINT ? { endpoint: e.S3_ENDPOINT } : {}),
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

function bucket(): string {
  return env().S3_BUCKET;
}

/**
 * Build a storage key. Deterministic in shape, random in the leaf, so two
 * concurrent renders of the same project cannot overwrite each other.
 */
export function storageKey(options: {
  userId: string;
  folder: StorageFolder;
  projectId?: string;
  extension: string;
}): string {
  const ext = options.extension.replace(/^\./, "").toLowerCase();
  const middle = options.projectId ? `${options.projectId}/` : "";
  return `u/${options.userId}/${options.folder}/${middle}${randomUUID()}.${ext}`;
}

export interface PutResult {
  key: string;
  bytes: number;
  checksumSha256: string;
}

/**
 * Upload a buffer. Returns the checksum so callers can persist it on the asset
 * row — the same file fetched twice from a provider should hash identically,
 * which is how duplicate stock downloads are detected later.
 */
export async function putObject(options: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  /** Cached by the browser once signed; renders are immutable. */
  cacheControl?: string;
  metadata?: Record<string, string>;
}): Promise<PutResult> {
  const body = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body);
  const checksum = createHash("sha256").update(body).digest("hex");

  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: options.key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl ?? "private, max-age=31536000",
        Metadata: options.metadata,
      }),
    );
  } catch (error) {
    log.error("put_object_failed", { key: options.key, error });
    throw new StorageError(`could not upload ${options.key}`, error);
  }

  return { key: options.key, bytes: body.byteLength, checksumSha256: checksum };
}

/** Stream an object's bytes. Used by workers, never by a request handler. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  try {
    const result = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    const body = result.Body;
    if (!body) throw new Error("empty body");
    // @aws-sdk/client-s3 returns a web stream in Node 18+.
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (error) {
    log.error("get_object_failed", { key, error });
    throw new StorageError(`could not read ${key}`, error);
  }
}

/**
 * Presigned read URL. TTL comes from `S3_SIGNED_URL_TTL` so the operator can
 * tighten it without a code change.
 */
export async function signedReadUrl(
  key: string,
  options: { expiresInSeconds?: number; downloadFilename?: string } = {},
): Promise<string> {
  const e = env();
  try {
    return await getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ...(options.downloadFilename
          ? {
              ResponseContentDisposition: `attachment; filename="${sanitiseFilename(
                options.downloadFilename,
              )}"`,
            }
          : {}),
      }),
      { expiresIn: options.expiresInSeconds ?? e.S3_SIGNED_URL_TTL },
    );
  } catch (error) {
    log.error("sign_read_failed", { key, error });
    throw new StorageError(`could not sign a URL for ${key}`, error);
  }
}

/** Presigned upload URL, for browser-side uploads of logos and brand assets. */
export async function signedUploadUrl(options: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  try {
    return await getSignedUrl(
      s3(),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: options.key,
        ContentType: options.contentType,
      }),
      { expiresIn: options.expiresInSeconds ?? 900 },
    );
  } catch (error) {
    log.error("sign_upload_failed", { key: options.key, error });
    throw new StorageError(`could not sign an upload for ${options.key}`, error);
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (error) {
    // Deletion failure is logged but not fatal: an orphaned object costs storage,
    // whereas a thrown error here would fail an otherwise successful cleanup.
    log.warn("delete_object_failed", { key, error });
  }
}

/** Strip anything that could break a Content-Disposition header. */
function sanitiseFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
