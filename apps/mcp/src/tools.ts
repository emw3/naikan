/**
 * MCP tool handlers for the regression-judge agent.
 *
 * Each handler maps tool arguments to a single `NaikanApiClient` call and wraps
 * the result in the MCP content shape (`{ content: [{type:"text", text}] }`). A
 * client error becomes a tool error (`isError: true`) carrying the message, so a
 * failed API call surfaces to the agent as a tool failure rather than crashing
 * the server. Handlers are deliberately SDK-free (no `@modelcontextprotocol/sdk`
 * import) so they unit-test against a fake client; `server.ts` owns the SDK glue.
 */
import type { NaikanApiClient } from "./client.ts";
import type { VerdictKind } from "./types.ts";

/** The MCP tool-result shape (a structural subset of the SDK's CallToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ListRunsArgs {
  checkId: string;
}

export interface GetRunArgs {
  checkId: string;
  runId: string;
}

export interface SubmitVerdictArgs {
  checkId: string;
  runId: string;
  verdict: VerdictKind;
  reasoning: string;
  confidence?: number;
  model: string;
}

/** Run a client call, formatting success as JSON text and any error as a tool error. */
async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

export function listUiChecks(client: NaikanApiClient): Promise<ToolResult> {
  return guard(() => client.listUIChecks());
}

export function listUiRuns(client: NaikanApiClient, args: ListRunsArgs): Promise<ToolResult> {
  return guard(() => client.listRuns(args.checkId));
}

export function getUiRun(client: NaikanApiClient, args: GetRunArgs): Promise<ToolResult> {
  return guard(() => client.getRun(args.checkId, args.runId));
}

export function submitVerdict(client: NaikanApiClient, args: SubmitVerdictArgs): Promise<ToolResult> {
  return guard(() =>
    client.submitVerdict(args.checkId, args.runId, {
      verdict: args.verdict,
      reasoning: args.reasoning,
      confidence: args.confidence ?? null,
      model: args.model,
    }),
  );
}
