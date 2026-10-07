/**
 * StorageProvider — object storage for every binary Vidxir AI produces (§22, §32).
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
import { nativeBindings } from "@/lib/cloudflare/bindings";
import { signMedia } from "@/lib/cloudflare/media-token";
import { env } from "@/lib/env";
import { StorageError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "storage" });

/**
 * Kinds of object Vidxir AI stores, used to build readable keys.
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
    await nativeBindings().MEDIA.put(options.key, body, {
      httpMetadata: { contentType: options.contentType, cacheControl: options.cacheControl ?? "private, max-age=31536000" },
      customMetadata: options.metadata,
    });
  } catch (error) {
    log.error("put_object_failed", { key: options.key, error });
    throw new StorageError(`could not upload ${options.key}`, error);
  }

  return { key: options.key, bytes: body.byteLength, checksumSha256: checksum };
}

/** Stream an object's bytes. Used by workers, never by a request handler. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  try {
    const object = await nativeBindings().MEDIA.get(key);
    if (!object) throw new Error("Object not found");
    return Buffer.from(await object.arrayBuffer());
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
  const token = signMedia({ key, method: "GET", expires: Date.now() + Math.min(options.expiresInSeconds ?? e.S3_SIGNED_URL_TTL, 86400) * 1000,
    ...(options.downloadFilename ? { filename: sanitiseFilename(options.downloadFilename) } : {}),
  }, e.SESSION_SECRET);
  return `${e.APP_URL}/api/media?token=${encodeURIComponent(token)}`;
}

/** Presigned upload URL, for browser-side uploads of logos and brand assets. */
export async function signedUploadUrl(options: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const e = env();
  const token = signMedia({ key: options.key, method: "PUT", contentType: options.contentType,
    expires: Date.now() + Math.min(options.expiresInSeconds ?? 900, 3600) * 1000 }, e.SESSION_SECRET);
  return `${e.APP_URL}/api/media?token=${encodeURIComponent(token)}`;
}

export async function objectExists(key: string): Promise<boolean> {
  return (await nativeBindings().MEDIA.head(key)) !== null;
}

export async function deleteObject(key: string): Promise<void> {
  try { await nativeBindings().MEDIA.delete(key); }
  catch (error) { log.warn("delete_object_failed", { key, error }); }
}

/** Strip anything that could break a Content-Disposition header. */
function sanitiseFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
