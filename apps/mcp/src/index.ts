#!/usr/bin/env node
/**
 * `@naikan/mcp` entry point — a stdio MCP server the platform ships so an agent
 * (Claude or any MCP client) can judge UI regressions.
 *
 * Config comes from the environment (`NAIKAN_API_URL`, `NAIKAN_AGENT_TOKEN`); the
 * server fails fast if either is missing. Transport is stdio — the agent launches
 * this process locally — so ALL logging goes to stderr; stdout is reserved for the
 * JSON-RPC protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { createClient } from "./client.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = createClient({ apiUrl: config.apiUrl, agentToken: config.agentToken });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the protocol channel.
  process.stderr.write(`naikan-mcp: connected (api ${config.apiUrl})\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
