---
status: accepted
---

# Email provider — Resend

Transactional email (incident alerts + daily digests) is sent via **Resend** (resend.com).
Chosen for its developer-first API and templating, low setup friction, and a free tier that
comfortably covers MVP volume; deliverability rides on solid underlying infrastructure. The
provider sits behind the `alerter` module's single `dispatch()` entry point with internal
channel adapters, so it stays swappable.

## Considered options

- **Amazon SES** — AWS-native (single vendor, IAM auth, cheapest at scale), but requires
  sending-domain verification + a sandbox-exit request before real sends, and has thinner
  out-of-box developer/deliverability tooling.
- **Postmark** — best-in-class transactional deliverability and DX, but a second paid vendor
  from the first email with no AWS-bundled tier.

Resend wins at MVP volume on DX + free-tier fit while keeping deliverability solid; the
single-`dispatch()` boundary makes a later move to SES/Postmark cheap if volume or cost
changes the calculus.

## Consequences

- `RESEND_API_KEY` is stored in Secrets Manager and injected as env (see #19 deploy).
- The Resend sending domain must be verified before production sends — part of #10's human
  merge gate.

---

*Originated from an AI-assisted `/triage` grilling session for issue #10.*
