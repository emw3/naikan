# 04 — Artifact store + `baseline-store` module

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

S3-compatible artifact storage layer, with MinIO for local development and S3 for production. Implement the `baseline-store` module as a deep wrapper hiding the SDK behind a small interface: `put(key, buffer, contentType)`, `get(key) → Buffer`, `presignGet(key, ttl) → URL`, `delete(key)`, `list(prefix) → keys[]`.

Key conventions decided in this issue (e.g. `projects/<id>/checks/<id>/runs/<run_id>/<viewport>.png`) and committed to ADR-0002.

End-to-end demo: a unit test uploads a buffer, retrieves it back, generates a presigned URL, and deletes it — passing against MinIO in CI.

## Acceptance criteria

- [x] `baseline-store` module with the interface above
- [x] MinIO running via `docker-compose` for local dev
- [x] Env-driven config (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, credentials)
- [x] Key convention documented in ADR-0002
- [x] Integration tests against MinIO in CI: put + get + presign + delete + list
- [x] Retention-policy *enforcement* not in scope here — covered in #17

## Blocked by

- #01

## Comments

**AFK agent (2026-06-02):** Implemented on branch `worktree-issue-04-artifact-store`.

- `packages/baseline-store` — kernel package (`@naikan/baseline-store`). `createArtifactStore(config)` returns the five-method `ArtifactStore` (`put`/`get`/`presignGet`/`delete`/`list`) plus a setup-only `ensureBucket()`. AWS SDK v3 behind the interface; runtime-agnostic (`@types/node`, not `bun-types`) per ADR-0005. `configFromEnv()` reads the `S3_*` vars and auto-enables path-style when `S3_ENDPOINT` is set (MinIO).
- `artifactKeys` centralises the key scheme (ADR-0002); baselines live outside the `runs/` subtree so the #17 reaper can exempt them by prefix.
- `docker-compose.yml` runs MinIO + a one-shot bucket creator for local dev; `.env.example` documents the vars.
- Tests: `keys.test.ts` (pure, always runs) + `store.test.ts` (skips unless `S3_ENDPOINT` set). Verified locally against a real MinIO — put/get round-trip, list-by-prefix, presigned-URL fetch returns the bytes, delete. New `artifact-store` CI job runs the MinIO suite; the plain `test` job skips it cleanly.
