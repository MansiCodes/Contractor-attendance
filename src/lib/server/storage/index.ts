import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageConfig } from "@/lib/config";
import { invalid } from "@/lib/errors";

// Private file storage for contractor photos (the only files the app keeps:
// uploaded Excel workbooks are read in memory and never stored).
// - production: a private S3 bucket; the browser gets 5-minute signed URLs
// - development: a local folder, served only to signed-in users by /api/files/...

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** A short-lived URL a signed-in user's browser can load. */
  url(key: string): Promise<string>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/i;

export function assertKey(key: string) {
  if (!KEY.test(key) || key.includes("..") || key.includes("//")) throw invalid("Invalid file name");
}

export const SIGNED_URL_SECONDS = 300;

class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    // Credentials come from the ECS task role (never from code or the browser).
    this.client = new S3Client({ region });
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: "private, max-age=300" }));
  }
  async remove(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async url(key: string) {
    assertKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: SIGNED_URL_SECONDS });
  }
}

class LocalStorage implements ObjectStorage {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  path(key: string) {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw invalid("Invalid file name");
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async url(key: string) {
    assertKey(key);
    return `/api/files/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  read(key: string) {
    return readFile(this.path(key));
  }
}

const g = globalThis as unknown as { __nfStorage?: ObjectStorage };

export function getObjectStorage(): ObjectStorage {
  if (!g.__nfStorage) {
    const cfg = storageConfig();
    g.__nfStorage = cfg.driver === "s3" ? new S3Storage(cfg.bucket, cfg.region) : new LocalStorage(cfg.dir);
  }
  return g.__nfStorage;
}

/** Development only: the bytes of a locally stored file (the route checks the user first). */
export async function readLocalObject(key: string): Promise<Buffer | null> {
  const s = getObjectStorage();
  if (!(s instanceof LocalStorage)) return null;
  try {
    return await s.read(key);
  } catch {
    return null;
  }
}

export const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
