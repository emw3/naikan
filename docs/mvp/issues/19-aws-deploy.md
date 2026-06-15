# 19 — AWS deploy (Fargate + RDS + S3 + CloudFront)

Status: ready-for-human
Category: enhancement
Type: HITL

## Parent

`docs/mvp/PRD.md`

## What to build

Production deployment topology on AWS. HITL because it requires decisions and credentials only the operator can supply (account choice, VPC layout, DNS / certificate, secret seeding for the first admin, custom-domain hostnames, IAM access boundaries).

Topology:
- **ECS Fargate** — one service for the API + admin UI; one separate service for the worker pool (Playwright RAM, scaled independently).
- **RDS Postgres** — managed, with backups.
- **S3** — artifact bucket with lifecycle policy capping at the longest per-project retention as a safety net behind the in-app reaper.
- **CloudFront** — fronts the Svelte SPA static build and the API origin.
- **ECR** — container registry for API + worker images (Playwright base + app code).

IaC choice (Terraform vs CDK vs Pulumi) decided in this issue and recorded in ADR-0004.

End-to-end demo: a successful CI pipeline builds + pushes the images, applies the IaC, runs migrations, and the live URL serves the SPA + `/health` returns 200.

## Acceptance criteria

- [ ] ADR-0004 records IaC tool choice
- [ ] Two Fargate task definitions (API, worker) with right-sized RAM (worker ≥2GB for Playwright)
- [ ] RDS Postgres with automated backups
- [ ] S3 bucket with lifecycle policy as backstop
- [ ] CloudFront fronting SPA + API
- [ ] Pipeline: build + push to ECR, run migrations, update services
- [ ] First admin seeded via Secrets-Manager-injected env vars
- [ ] DNS + TLS wired
- [ ] HITL checkpoint: deploy walk-through with operator before going live

## Blocked by

- #01 (can iterate on infra alongside functional slices but full prod deploy follows MVP completion)
