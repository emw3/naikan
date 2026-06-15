/**
 * Throwaway static server for the seed pages (issue #05). The generator and demo
 * seed boot it on an ephemeral port, capture the pages through the real pipeline,
 * then close it. Plain `node:http` (not Bun.serve) because anything that drives
 * `@naikan/capture` runs under Node — Playwright is Node-only (ADR-0001/0006).
 *
 * Serves `seed-pages/<name>.html` for a request path `/<name>` (any query string
 * is ignored here and read client-side by the page to pick its variant). Bodies
 * are read fresh per request so editing a seed page needs no restart.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

/** Directory holding the seed `.html` pages. */
export const SEED_PAGES_DIR = fileURLToPath(new URL("../seed-pages", import.meta.url));

export interface SeedServer {
  /** Origin to navigate to, e.g. `http://127.0.0.1:54123`. */
  origin: string;
  close(): Promise<void>;
}

/** Build the absolute URL for a seed page + query against a running server. */
export function pageUrl(origin: string, page: string, query: string): string {
  return `${origin}/${page}${query}`;
}

/** Start the seed-page server on an ephemeral loopback port. */
export async function startSeedServer(): Promise<SeedServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/+/, "");
    const name = path === "" ? "index" : path;
    // Only serve a flat `<name>.html` from the seed dir — no traversal.
    if (!/^[a-z0-9-]+$/i.test(name)) {
      res.writeHead(400).end("bad page name");
      return;
    }
    readFile(resolve(SEED_PAGES_DIR, `${name}.html`))
      .then((html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      })
      .catch(() => {
        res.writeHead(404).end("not found");
      });
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    close: () =>
      new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
  };
}
