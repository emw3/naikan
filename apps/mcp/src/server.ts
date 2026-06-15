/**
 * SDK glue: builds the `McpServer` and registers the four regression-judge tools.
 *
 * This is the only module that imports `@modelcontextprotocol/sdk` + `zod`; it
 * owns the tool names, descriptions, and input schemas (the protocol surface) and
 * delegates each call to the SDK-free handlers in `tools.ts`. Keeping the schemas
 * here lets the handlers + client be unit-tested without the SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NaikanApiClient } from "./client.ts";
import { getUiRun, listUiChecks, listUiRuns, submitVerdict, type ToolResult } from "./tools.ts";

const VERDICT_KINDS = ["real_regression", "noise", "intentional", "uncertain"] as const;

/** The SDK's tool callback is structurally satisfied by our `ToolResult`. */
const asResult = (r: ToolResult) => r as ToolResult & { [k: string]: unknown };

export function createServer(client: NaikanApiClient): McpServer {
  const server = new McpServer({ name: "naikan-mcp", version: "0.0.0" });

  server.registerTool(
    "list_ui_checks",
    {
      title: "List UI checks",
      description:
        "Enumerate every UI check visible to the agent (manager-scoped). Returns id, " +
        "site, path, viewports, and whether a baseline exists. Start here to find " +
        "checks whose recent runs may need a verdict.",
      inputSchema: {},
    },
    async () => asResult(await listUiChecks(client)),
  );

  server.registerTool(
    "list_ui_runs",
    {
      title: "List runs for a UI check",
      description:
        "List the recent runs for one UI check (newest first), so you can pick a run " +
        "to judge. Pass the checkId from list_ui_checks.",
      inputSchema: { checkId: z.string().describe("The UI check id (from list_ui_checks).") },
    },
    async (args) => asResult(await listUiRuns(client, args)),
  );

  server.registerTool(
    "get_ui_run",
    {
      title: "Get one UI run's diff detail",
      description:
        "Fetch everything needed to judge one run: presigned baseline | current | diff " +
        "image URLs per viewport, the per-viewport diff fraction (0..1), the judged " +
        "signals, and the latest verdict already recorded (if any). `expired:true` means " +
        "the run's images have been reaped and cannot be judged.",
      inputSchema: {
        checkId: z.string().describe("The UI check id."),
        runId: z.string().describe("The run id (from list_ui_runs)."),
      },
    },
    async (args) => asResult(await getUiRun(client, args)),
  );

  server.registerTool(
    "submit_verdict",
    {
      title: "Submit a regression-judge verdict",
      description:
        "Record your verdict for a run. Advisory only — it never promotes a baseline; a " +
        "human stays the authority. Use real_regression for a genuine break (broken " +
        "layout, missing element, corrupted content); noise for anti-aliasing or dynamic " +
        "content (carousel, timestamp); intentional for a deliberate restyle; uncertain " +
        "when you cannot tell. Always include a one-paragraph reasoning and set model to " +
        "your model id.",
      inputSchema: {
        checkId: z.string().describe("The UI check id."),
        runId: z.string().describe("The run id being judged."),
        verdict: z.enum(VERDICT_KINDS).describe("The verdict kind."),
        reasoning: z.string().describe("One-paragraph justification for the verdict."),
        confidence: z.number().min(0).max(1).optional().describe("Self-reported confidence 0..1."),
        model: z.string().describe("The judging model's id, e.g. claude-opus-4-8."),
      },
    },
    async (args) => asResult(await submitVerdict(client, args)),
  );

  return server;
}
