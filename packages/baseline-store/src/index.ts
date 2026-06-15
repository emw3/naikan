/**
 * @naikan/baseline-store — S3-compatible artifact storage (issue #04).
 *
 * Kernel package: plain TypeScript, no Bun-specific APIs (ADR-0005). Key
 * conventions are committed to ADR-0002.
 */
export {
  createArtifactStore,
  configFromEnv,
  type ArtifactStore,
  type ManagedArtifactStore,
  type ArtifactStoreConfig,
} from "./store.ts";
export { artifactKeys, TOMBSTONE_REF } from "./keys.ts";
