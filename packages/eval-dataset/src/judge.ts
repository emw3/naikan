/**
 * `claudeJudge` — the model-backed judge under test (issue #06).
 *
 * This is the eval-suite counterpart of the shipped judging skill
 * (`.claude/skills/regression-judge`): it encodes the same four-way taxonomy, but
 * reads a fixture's baseline / current / diff images + diff% + Signals straight off
 * disk (via `Fixture`) instead of through the MCP tools, classifies the diff with
 * Claude vision, and returns a `JudgeOutput`. `runEval` scores its verdicts against
 * ground truth.
 *
 * The platform runtime never embeds a model (PRD: the agent's intelligence lives in
 * the MCP client + skill). The eval harness is a dev/test artifact, so a model call
 * here is fine — but it is **gated**: `isModelAvailable()` is false without an API
 * key, and the SDK is **lazily imported inside the judge call**, so importing this
 * module (and running `bun test`) never requires `@anthropic-ai/sdk` to be installed
 * or a key to be set. The regression test skips cleanly when the model is absent.
 */
import type { Fixture } from "./types.ts";
import { LABELS } from "./types.ts";
import type { Judge, JudgeOutput } from "./eval.ts";

/** Default judge model — the production skill records the judge's own model id here. */
export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8";

export interface ClaudeJudgeOptions {
  /** Model id to judge with. Defaults to {@link DEFAULT_JUDGE_MODEL}. */
  model?: string;
  /** Explicit API key; otherwise the SDK resolves it from the environment. */
  apiKey?: string;
  /** Thinking/effort depth for the judgment. Defaults to `high`. */
  effort?: "low" | "medium" | "high" | "max";
}

/**
 * True when a model backend is reachable (an API key is configured). The regression
 * test gates on this so it runs where a model is available and **skips loudly** —
 * never silently passes — where it isn't.
 */
export function isModelAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** System prompt — the judging procedure + taxonomy, mirrored from the shipped skill. */
const JUDGE_SYSTEM = `You are the regression-judge for Naikan, a visual-monitoring platform.
You are given ONE UI check run's screenshot diff for a single viewport: the approved
BASELINE image, the CURRENT image, and (when dimensions match) the DIFF overlay
highlighting changed pixels, plus the differing-pixel fraction and the run's judged
Signals. Decide whether the diff is a genuine visual regression or not, and record a
calibrated verdict. Your verdict is advisory; a human stays the authority.

Look at WHERE the pixels differ, not just how many. Cross-check the Signals: a failed
critical signal (load/selector) corroborates a real break; a clean signal set with a
tiny scattered diff leans toward noise.

Classify into exactly one of four verdict kinds:
- "real_regression": a genuine break the team should fix — broken/shifted layout, an
  overlapping/clipped/missing element, corrupted or garbled content, a component that
  failed to render, a usability-harming colour/contrast break. Often corroborated by a
  failed critical signal or a diff concentrated on a structural region.
- "noise": a difference that is NOT a real change to the page — anti-aliasing /
  sub-pixel jitter, font hinting, a rotating carousel or hero slide, a timestamp /
  relative date, randomised ads or A/B content, animation captured mid-frame. Typically
  small, scattered, or confined to a content region with clean structural signals.
- "intentional": a real, deliberate change — a restyle, copy update, new section,
  rebrand. The page looks correct; it just no longer matches the old baseline.
- "uncertain": you genuinely cannot tell (ambiguous diff, conflicting evidence).
  Prefer this over a confident guess.

Heuristics: anti-aliasing / dynamic content (carousel, timestamp) / intentional restyle
are NOT regressions. Broken layout / missing element / content corruption ARE
real_regression. When the diff fraction is tiny (<~0.5%) and all critical signals pass,
lean toward noise unless the overlay shows a clear structural break.

Set confidence in [0,1]; lower it when the diff is borderline or the cause is unclear.
Respond ONLY with the structured verdict (verdict, confidence, reasoning).`;

/** Structured-output schema constraining the verdict (no numeric range — unsupported). */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...LABELS] },
    confidence: { type: "number", description: "Self-reported certainty, 0..1." },
    reasoning: { type: "string", description: "One paragraph: what you saw and why." },
  },
  required: ["verdict", "confidence", "reasoning"],
  additionalProperties: false,
} as const;

/**
 * Build a model judge. Returns a {@link Judge} that classifies one fixture per call.
 * The `@anthropic-ai/sdk` import is deferred to first use so this module loads (and
 * `bun test` runs) without the SDK present.
 */
export function createClaudeJudge(options: ClaudeJudgeOptions = {}): Judge {
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const effort = options.effort ?? "high";

  return async (fixture: Fixture): Promise<JudgeOutput> => {
    const { readFileSync } = await import("node:fs");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();

    const toImage = (path: string) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: readFileSync(path).toString("base64"),
      },
    });

    const signalsText = fixture.signals.length
      ? fixture.signals.map((s) => `${s.kind}=${s.pass ? "pass" : "FAIL"} (${s.severity}: ${s.detail})`).join("; ")
      : "none recorded";

    const content: unknown[] = [
      {
        type: "text",
        text:
          `Viewport: ${fixture.viewport}. Differing-pixel fraction: ${(fixture.diffPct * 100).toFixed(2)}%.\n` +
          `Signals: ${signalsText}.\n` +
          (fixture.diffPath
            ? "Three images follow — BASELINE, then CURRENT, then the DIFF overlay."
            : "Two images follow — BASELINE, then CURRENT (no diff overlay: the dimensions differ, which is itself evidence)."),
      },
      { type: "text", text: "BASELINE:" },
      toImage(fixture.baselinePath),
      { type: "text", text: "CURRENT:" },
      toImage(fixture.currentPath),
      ...(fixture.diffPath ? [{ type: "text", text: "DIFF overlay:" }, toImage(fixture.diffPath)] : []),
      { type: "text", text: "Classify this diff into exactly one verdict kind." },
    ];

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort, format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: content as never }],
    });

    return parseVerdict(response);
  };
}

/** Extract + validate the structured verdict; degrade to `uncertain` on any anomaly. */
function parseVerdict(response: { stop_reason?: string | null; content: unknown[] }): JudgeOutput {
  if (response.stop_reason === "refusal") {
    return { verdict: "uncertain", reasoning: "model refused to judge this fixture" };
  }
  const textBlock = response.content.find(
    (b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
  );
  if (!textBlock) {
    return { verdict: "uncertain", reasoning: "model returned no text block" };
  }

  let parsed: { verdict?: unknown; confidence?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { verdict: "uncertain", reasoning: `unparseable judge output: ${textBlock.text.slice(0, 200)}` };
  }

  const verdict = (LABELS as readonly string[]).includes(parsed.verdict as string)
    ? (parsed.verdict as JudgeOutput["verdict"])
    : "uncertain";
  const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : undefined;
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;

  return { verdict, confidence, reasoning };
}
