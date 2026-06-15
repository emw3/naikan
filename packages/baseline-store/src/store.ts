/**
 * `baseline-store` — S3-compatible artifact storage.
 *
 * A deep wrapper hiding the AWS SDK behind a five-method interface. MinIO backs
 * local dev / CI; real S3 backs production. The only difference is config
 * (`endpoint` + path-style addressing for MinIO), so callers never branch on it.
 *
 * Runtime-agnostic per ADR-0005: no Bun-specific APIs — the AWS SDK v3, the
 * `Buffer` global, and `fetch` all run identically on Node and Bun, so the
 * worker can import this whether it ends up on Bun or Node.
 *
 * Retention *enforcement* (the reaper) is out of scope here — see issue #17.
 * This module only provides the CRUD primitives the reaper will build on.
 */
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** The artifact-store contract (issue #04). */
export interface ArtifactStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Server-side copy of one object to another key (no bytes round-trip the
   * client). Used to promote a run screenshot into the baseline subtree (#12).
   */
  copy(srcKey: string, dstKey: string): Promise<void>;
  /** Presigned GET URL valid for `ttlSeconds`. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, paginated transparently. */
  list(prefix: string): Promise<string[]>;
}

/** Store plus a setup helper used by local dev / CI bootstrap, not request paths. */
export interface ManagedArtifactStore extends ArtifactStore {
  /** Create the bucket if it does not already exist. Idempotent. */
  ensureBucket(): Promise<void>;
}

export interface ArtifactStoreConfig {
  /** Custom endpoint (MinIO). Omit for real AWS S3. */
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing — required by MinIO; defaults true when `endpoint` is set. */
  forcePathStyle?: boolean;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`baseline-store: missing required env var ${name}`);
  }
  return value;
}

/** Build config from `S3_*` env vars. */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): ArtifactStoreConfig {
  const endpoint = env.S3_ENDPOINT;
  return {
    endpoint,
    bucket: required(env, "S3_BUCKET"),
    region: env.S3_REGION ?? "us-east-1",
    accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: env.S3_FORCE_PATH_STYLE
      ? env.S3_FORCE_PATH_STYLE === "true"
      : !!endpoint,
  };
}

export function createArtifactStore(config: ArtifactStoreConfig): ManagedArtifactStore {
  const { bucket } = config;
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? !!config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (err) {
          // Tolerate the race / "already owned by you" cases.
          const name = (err as { name?: string }).name;
          if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
            throw err;
          }
        }
      }
    },

    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) {
        throw new Error(`baseline-store: empty body for key ${key}`);
      }
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    },

    async copy(srcKey, dstKey) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          // CopySource is `<bucket>/<key>`; encode the key so slashes in the path
          // survive but reserved chars in a segment don't break the reference.
          CopySource: `${bucket}/${srcKey.split("/").map(encodeURIComponent).join("/")}`,
          Key: dstKey,
        }),
      );
    },

    async presignGet(key, ttlSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
