/**
 * Env configuration for the `@naikan/mcp` stdio server.
 *
 * The server is opt-in and useless without a target + credential, so it fails
 * fast (a clear, actionable error) when either is missing rather than starting
 * and erroring on the first tool call. The env is injected so the loader is
 * unit-testable without touching `process.env`.
 */

export interface McpConfig {
  /** Base URL of the Naikan API, e.g. `http://localhost:3000` (no trailing slash). */
  apiUrl: string;
  /** The scoped agent bearer token (`NAIKAN_AGENT_TOKEN` on the API side). */
  agentToken: string;
}

/** Read + validate config from an env map. Throws with a clear message if unset. */
export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const apiUrl = env.NAIKAN_API_URL?.trim();
  const agentToken = env.NAIKAN_AGENT_TOKEN?.trim();

  const missing: string[] = [];
  if (!apiUrl) missing.push("NAIKAN_API_URL");
  if (!agentToken) missing.push("NAIKAN_AGENT_TOKEN");
  if (missing.length) {
    throw new Error(
      `@naikan/mcp: missing required env: ${missing.join(", ")}. ` +
        `Set NAIKAN_API_URL (the Naikan API base URL) and NAIKAN_AGENT_TOKEN ` +
        `(the scoped agent bearer token) before starting the server.`,
    );
  }

  // Normalise away trailing slashes so the client can join paths unambiguously.
  return { apiUrl: apiUrl!.replace(/\/+$/, ""), agentToken: agentToken! };
}
