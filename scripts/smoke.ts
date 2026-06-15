/**
 * Smoke test: build the SPA, start the API, GET /health, assert 200.
 *
 * This script holds the real CI logic; `.github/workflows/ci.yml` just invokes
 * `bun run smoke`. No database is required — `/health` is plain (per issue #01).
 */

const PORT = process.env.PORT ?? "3000";
const HEALTH_URL = `http://localhost:${PORT}/health`;

function fail(msg: string): never {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

// 1. Build the Svelte SPA (so the API has something to serve at /).
console.log("smoke: building web-admin…");
const build = Bun.spawnSync(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) fail("build failed");

// 2. Start the API.
console.log(`smoke: starting API on :${PORT}…`);
const server = Bun.spawn(["bun", "run", "start"], {
  env: { ...process.env, PORT },
  stdout: "inherit",
  stderr: "inherit",
});

// 3. Poll /health until it answers 200 (or give up).
let ok = false;
for (let attempt = 1; attempt <= 40; attempt++) {
  try {
    const res = await fetch(HEALTH_URL);
    if (res.status === 200) {
      ok = true;
      break;
    }
    console.log(`smoke: /health -> ${res.status} (attempt ${attempt})`);
  } catch {
    // server not up yet
  }
  await Bun.sleep(250);
}

server.kill();
await server.exited;

if (!ok) fail(`GET ${HEALTH_URL} never returned 200`);
console.log("smoke: PASS — GET /health -> 200");
process.exit(0);
