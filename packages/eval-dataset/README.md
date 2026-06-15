# @naikan/eval-dataset

The labeled **golden dataset** the agentic regression-judge is measured against,
and — by reuse — the one-command local **demo seed**. Every fixture is a genuine
artifact captured through the real `@naikan/capture` → `@naikan/ui-runner`
pipeline, not a hand-mocked image.

This package is the seam the slice-06 eval harness (`runEval(dataset, judge)`)
consumes. It is also a leaf: the loadable surface (`loadDataset`) depends only on
`node:fs`/`node:path`, so importing the dataset never pulls in Playwright.

## Label vocabulary

A fixture's `label` is the **ground truth** a judge is scored against. It mirrors
`@naikan/config-repo`'s `VerdictKind` (the agent's verdict output) so the grader
can compare the two directly:

| label             | meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `real_regression` | a genuine visual break (layout collapse, overflow, dropped CSS)      |
| `noise`           | the diff is real pixels but not a break (ticking clock, carousel)    |
| `intentional`     | a deliberate change (rebrand, typography refresh, redesign)          |
| `uncertain`       | a valid *verdict*, but **never a ground-truth label** — see below    |

`uncertain` is never assigned to a fixture: you cannot construct a page that is
objectively "uncertain". It exists in the vocabulary only so the grader's
confusion matrix can have a column for it.

## On-disk layout

```
fixtures/
  manifest.json                       # the index — the source of truth
  synthetic/<id>/baseline.png         # baseline-state capture
  synthetic/<id>/current.png          # current-state capture
  synthetic/<id>/diff.png             # pixelmatch overlay (absent on a dim mismatch)
  curated/<id>/{baseline,current[,diff]}.png
```

## Manifest format (`manifest.json`)

```jsonc
{
  "version": 1,
  "fixtures": [
    {
      "id": "layout-break",            // unique; also the subdirectory name
      "label": "real_regression",      // ground truth (see vocabulary)
      "source": "synthetic",           // "synthetic" | "curated"
      "viewport": "desktop",           // mobile | tablet | desktop
      "diffPct": 0.0239,               // differing-pixel fraction 0..1 (1 on a dim mismatch)
      "signals": [                     // the run's judged Signals for this viewport
        { "kind": "load", "pass": true, "severity": "critical", "detail": "HTTP 200" }
        // … console / selector / perf
      ],
      "images": {                      // paths RELATIVE to the dataset root
        "baseline": "synthetic/layout-break/baseline.png",
        "current":  "synthetic/layout-break/current.png",
        "diff":     "synthetic/layout-break/diff.png"   // omitted on a dimension mismatch
      },
      "notes": "…",                    // human description / rationale
      "sourceUrls": { "baseline": "…", "current": "…" }  // curated only: the real URLs
    }
  ]
}
```

A fixture carries everything an admin (or the agent) sees when judging a run:
baseline | current | diff images, the diff percentage, and the four Signals.

## Consuming the dataset

```ts
import { loadDataset } from "@naikan/eval-dataset";

for (const f of loadDataset()) {
  // f.label, f.diffPct, f.signals
  // f.baselinePath / f.currentPath / f.diffPath are ABSOLUTE paths (read the bytes)
}
```

`loadDataset(root?)` parses the manifest, validates every label/source, resolves
the relative image references to absolute paths, and asserts each image exists —
a corrupt or half-generated corpus fails loudly here, not deep in the harness.

## Regenerating

All generators are **Node-only** (they drive Playwright/Chromium, which is
Node-only per ADR-0001/0006) and run from the repo root:

| command                                                | what it does |
| ------------------------------------------------------ | ------------ |
| `bun run eval:generate`                                | (re)capture the **synthetic** corpus through the real pipeline; preserves curated entries |
| `bun run eval:curate <id> <label> <baseUrl> <curUrl> [notes…]` | capture a **curated** real before/after pair; the human picks the URLs + confirms the label |
| `bun run eval:seed-demo`                               | seed a live stack with a **"Naikan Demo"** project an agent can judge (needs `bun stack up`) |

> The scripts run `node`; ensure Node ≥ 22.18 is on `PATH` (the worker's runtime).

### Synthetic seed cases

Deterministic pages under `seed-pages/`, captured baseline-state then
current-state so the diff is genuine pipeline output. Labels are known **by
construction** (the generator controls the change):

| id              | label             | what changes |
| --------------- | ----------------- | ------------ |
| `layout-break`  | `real_regression` | a pricing card is pulled out of flow and overlaps its neighbours |
| `overflow-break`| `real_regression` | a product image overflows its tile and shoves the grid |
| `live-clock`    | `noise`           | a status page's live counters + clock tick between captures |
| `rotating-hero` | `noise`           | a hero rotates its background hue + testimonial each load (carousel) |
| `brand-restyle` | `intentional`     | an indigo→teal rebrand with pill buttons + shadows; layout intact |
| `type-restyle`  | `intentional`     | a serif→sans typography refresh |

## Caveats

- **Curated cases capture real public sites** (Wayback Machine snapshots, a random
  image service). The captured PNGs are committed and frozen, so the dataset is
  deterministic at consume-time — but the *sources* are third-party and not
  reproducible on re-capture. `sourceUrls` records where each came from.
- Real before/after pairs usually differ in page height, so their diff is a
  **dimension mismatch** (`diffPct: 1`, no overlay) — an honest pipeline outcome
  recorded faithfully. Same-height pairs (and all synthetic cases) get a real
  overlay.
- The synthetic generator doubles as the demo seed; both share the case catalog in
  `src/cases.ts`, so they never drift.
