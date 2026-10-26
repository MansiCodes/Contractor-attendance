import { AppError } from "@/lib/errors";

// Which data the app runs on, decided once from the environment:
// - APP_MODE=demo         fictional data in memory; nothing is stored anywhere
// - APP_MODE=development  a development PostgreSQL database (local or a dev RDS)
// - APP_MODE=production   Amazon RDS PostgreSQL and S3, TLS required
// ("live" is accepted as an older name for production.)
//
// Demo mode never switches on by itself when a database is configured or in a
// production build: a missing or failing database is an error, not demo data.

export type AppMode = "demo" | "development" | "production";

type Env = Record<string, string | undefined>;

const hasDatabase = (env: Env) => !!(env.DATABASE_URL?.trim() || env.DATABASE_HOST?.trim());

export function getAppMode(env: Env = process.env): AppMode {
  const explicit = env.APP_MODE?.trim().toLowerCase();
  if (explicit === "demo") return "demo";
  if (explicit === "development") return "development";
  if (explicit === "production" || explicit === "live") return "production";
  if (explicit) throw new AppError(`Unknown APP_MODE '${explicit}'. Use 'demo', 'development' or 'production'.`, "config");
  if (hasDatabase(env)) {
    throw new AppError("A database is configured but APP_MODE is not set. Set APP_MODE to 'development' or 'production'.", "config");
  }
  if (env.NODE_ENV === "production") {
    throw new AppError("APP_MODE is not set. Set APP_MODE to 'production' (or 'demo' for a public demo).", "config");
  }
  return "demo";
}

export const isDemoMode = (env: Env = process.env) => getAppMode(env) === "demo";

export type SslMode = "verify-full" | "require" | "disable";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: SslMode;
  /** PEM bundle that signs the server certificate (the Amazon RDS CA bundle in production) */
  sslCaFile: string | null;
  poolMax: number;
}

/**
 * Database connection settings for development and production. Either DATABASE_URL,
 * or DATABASE_HOST / DATABASE_PORT / DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD
 * (the form used on AWS, where the user and password come from Secrets Manager).
 */
export function databaseConfig(env: Env = process.env): DatabaseConfig {
  const mode = getAppMode(env);
  if (mode === "demo") throw new AppError("Demo mode has no database", "config");
  let host = env.DATABASE_HOST?.trim() ?? "";
  let port = Number(env.DATABASE_PORT ?? 5432);
  let database = env.DATABASE_NAME?.trim() ?? "";
  let user = env.DATABASE_USER?.trim() ?? "";
  let password = env.DATABASE_PASSWORD ?? "";
  const url = env.DATABASE_URL?.trim();
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AppError("DATABASE_URL is not a valid postgres:// URL", "config");
    }
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new AppError("DATABASE_URL must start with postgres://", "config");
    host = u.hostname;
    port = Number(u.port || 5432);
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  }
  if (!host || !database || !user) {
    throw new AppError(`APP_MODE is '${mode}' but the database is not configured (DATABASE_URL, or DATABASE_HOST, DATABASE_NAME and DATABASE_USER).`, "config");
  }
  const ssl = (env.DATABASE_SSL?.trim().toLowerCase() || (mode === "production" ? "verify-full" : "disable")) as SslMode;
  if (!["verify-full", "require", "disable"].includes(ssl)) throw new AppError("DATABASE_SSL must be verify-full, require or disable", "config");
  if (mode === "production" && ssl !== "verify-full") {
    throw new AppError("In production the database connection must use DATABASE_SSL=verify-full", "config");
  }
  const poolMax = Number(env.DATABASE_POOL_MAX ?? 5);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 5432,
    database,
    user,
    password,
    ssl,
    sslCaFile: env.DATABASE_SSL_CA?.trim() || null,
    poolMax: Number.isInteger(poolMax) && poolMax >= 1 && poolMax <= 50 ? poolMax : 5,
  };
}

export type StorageConfig = { driver: "s3"; bucket: string; region: string } | { driver: "local"; dir: string };

/** Where contractor photos are kept: a private S3 bucket, or (development only) a local folder. */
export function storageConfig(env: Env = process.env): StorageConfig {
  const mode = getAppMode(env);
  const driver = env.STORAGE_DRIVER?.trim().toLowerCase() || (mode === "production" ? "s3" : "local");
  if (driver === "s3") {
    const bucket = env.S3_BUCKET?.trim();
    const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
    if (!bucket || !region) throw new AppError("STORAGE_DRIVER=s3 needs S3_BUCKET and AWS_REGION", "config");
    return { driver: "s3", bucket, region };
  }
  if (driver === "local") {
    if (mode === "production") throw new AppError("Production stores files in S3: set STORAGE_DRIVER=s3", "config");
    return { driver: "local", dir: env.LOCAL_STORAGE_DIR?.trim() || ".data/uploads" };
  }
  throw new AppError("STORAGE_DRIVER must be s3 or local", "config");
}

/** Cookies are marked Secure in production (HTTPS at the load balancer) or when the request came over HTTPS. */
export const secureCookies = (forwardedProto: string | null, env: Env = process.env) => getAppMode(env) === "production" || forwardedProto === "https";
