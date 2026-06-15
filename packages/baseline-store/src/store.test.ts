import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createArtifactStore, configFromEnv, type ManagedArtifactStore } from "./store.ts";
import { artifactKeys } from "./keys.ts";

// Integration tests run only against a real S3-compatible endpoint (MinIO in
// CI / local dev). With no S3_ENDPOINT configured the whole suite is skipped,
// so `bun test` stays green on machines without MinIO.
const hasEndpoint = !!process.env.S3_ENDPOINT;

describe.skipIf(!hasEndpoint)("baseline-store against MinIO", () => {
  // Built in beforeAll, not at collection time — configFromEnv() reads required
  // env vars and would throw while the suite is being registered for a skip.
  let store: ManagedArtifactStore;
  // Unique per-process prefix so concurrent / repeated runs never collide.
  const projectId = `it-${crypto.randomUUID().slice(0, 8)}`;
  const key = artifactKeys.runScreenshot(projectId, "chk1", "run1", "desktop");
  const body = Buffer.from("\x89PNG\r\n\x1a\n-fake-png-bytes", "binary");

  beforeAll(async () => {
    store = createArtifactStore(configFromEnv());
    await store.ensureBucket();
  });

  afterAll(async () => {
    // Best-effort cleanup of anything this suite created.
    for (const k of await store.list(artifactKeys.projectPrefix(projectId))) {
      await store.delete(k);
    }
  });

  test("put then get round-trips the exact bytes", async () => {
    await store.put(key, body, "image/png");
    const got = await store.get(key);
    expect(Buffer.compare(got, body)).toBe(0);
  });

  test("list returns keys under a prefix", async () => {
    const keys = await store.list(artifactKeys.runsPrefix(projectId, "chk1"));
    expect(keys).toContain(key);
  });

  test("presignGet yields a URL that serves the object bytes", async () => {
    const url = await store.presignGet(key, 60);
    expect(url).toContain(key);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const fetched = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(fetched, body)).toBe(0);
  });

  test("delete removes the object", async () => {
    await store.delete(key);
    const keys = await store.list(artifactKeys.runsPrefix(projectId, "chk1"));
    expect(keys).not.toContain(key);
  });

  test("copy duplicates an object's bytes to a new key, leaving the source intact", async () => {
    const src = artifactKeys.runScreenshot(projectId, "chk2", "run1", "desktop");
    const dst = artifactKeys.baseline(projectId, "chk2", "desktop");
    await store.put(src, body, "image/png");
    await store.copy(src, dst);
    expect(Buffer.compare(await store.get(dst), body)).toBe(0);
    // Promotion copies bytes into the baseline subtree — it does not move/repoint.
    expect(Buffer.compare(await store.get(src), body)).toBe(0);
  });
});
