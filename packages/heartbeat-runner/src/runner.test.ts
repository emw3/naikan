import { afterAll, beforeAll, expect, test } from "bun:test";
import { runHeartbeat } from "./runner.ts";
import type { BodyAssertion, FetchResponse, HeartbeatSpec } from "./types.ts";

// ---- local HTTP mock (exercises the runner's real default fetch) ----

let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/ok") return new Response("hello world", { status: 200 });
      if (pathname === "/boom") return new Response("kaboom", { status: 500 });
      if (pathname === "/json")
        return new Response(JSON.stringify({ status: "green", data: { health: "up" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

const SPEC: HeartbeatSpec = { path: "/ok", certCheck: false, dnsCheck: false };

/** A clock returning the given instants in order; the last value repeats. */
function fakeClock(...isoMs: number[]): () => Date {
  let i = 0;
  return () => new Date(isoMs[Math.min(i++, isoMs.length - 1)]!);
}

/** A stub fetch returning a fixed body + status (for cert tests over https). */
function stubFetch(status: number, body: string): (url: string) => Promise<FetchResponse> {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
}

// ---- HTTP status signal ----

test("passes for a 200 response", async () => {
  const r = await runHeartbeat(origin, SPEC);
  expect(r.status).toBe("pass");
  expect(r.error).toBeNull();
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  expect(r.startedAt).toBeInstanceOf(Date);
  expect(r.finishedAt).toBeInstanceOf(Date);
});

test("fails for a 500 response, naming the status in the error", async () => {
  const r = await runHeartbeat(origin, { ...SPEC, path: "/boom" });
  expect(r.status).toBe("fail");
  expect(r.error).toContain("500");
});

test("fails when the request cannot be made at all", async () => {
  const r = await runHeartbeat("http://127.0.0.1:1", SPEC);
  expect(r.status).toBe("fail");
  expect(r.error).toBeTruthy();
});

test("latencyMs is derived from the injected clock", async () => {
  const r = await runHeartbeat(origin, SPEC, { now: fakeClock(1_000, 1_050) });
  expect(r.latencyMs).toBe(50);
  expect(r.startedAt.getTime()).toBe(1_000);
  expect(r.finishedAt.getTime()).toBe(1_050);
});

// ---- body assertion signal ----

test("regex body assertion passes when the pattern matches", async () => {
  const bodyAssertion: BodyAssertion = { kind: "regex", pattern: "hello" };
  const r = await runHeartbeat(origin, { ...SPEC, bodyAssertion });
  expect(r.status).toBe("pass");
});

test("regex body assertion fails when the pattern does not match", async () => {
  const bodyAssertion: BodyAssertion = { kind: "regex", pattern: "goodbye" };
  const r = await runHeartbeat(origin, { ...SPEC, bodyAssertion });
  expect(r.status).toBe("fail");
  expect(r.error).toContain("body");
});

test("jsonpath body assertion passes when the value equals expected", async () => {
  const bodyAssertion: BodyAssertion = { kind: "jsonpath", pattern: "status", equals: "green" };
  const r = await runHeartbeat(origin, { ...SPEC, path: "/json", bodyAssertion });
  expect(r.status).toBe("pass");
});

test("jsonpath body assertion resolves nested dot-paths", async () => {
  const bodyAssertion: BodyAssertion = { kind: "jsonpath", pattern: "data.health", equals: "up" };
  const r = await runHeartbeat(origin, { ...SPEC, path: "/json", bodyAssertion });
  expect(r.status).toBe("pass");
});

test("jsonpath body assertion fails on a value mismatch", async () => {
  const bodyAssertion: BodyAssertion = { kind: "jsonpath", pattern: "status", equals: "red" };
  const r = await runHeartbeat(origin, { ...SPEC, path: "/json", bodyAssertion });
  expect(r.status).toBe("fail");
});

test("jsonpath body assertion fails when the path is absent", async () => {
  const bodyAssertion: BodyAssertion = { kind: "jsonpath", pattern: "missing.key" };
  const r = await runHeartbeat(origin, { ...SPEC, path: "/json", bodyAssertion });
  expect(r.status).toBe("fail");
});

// ---- DNS signal ----

test("DNS check passes when the hostname resolves", async () => {
  const r = await runHeartbeat(origin, { ...SPEC, dnsCheck: true }, {
    resolveDns: () => Promise.resolve(["127.0.0.1"]),
  });
  expect(r.status).toBe("pass");
});

test("DNS check fails when resolution rejects", async () => {
  const r = await runHeartbeat(origin, { ...SPEC, dnsCheck: true }, {
    resolveDns: () => Promise.reject(new Error("NXDOMAIN")),
  });
  expect(r.status).toBe("fail");
  expect(r.error).toContain("DNS");
});

test("DNS check fails when resolution returns no addresses", async () => {
  const r = await runHeartbeat(origin, { ...SPEC, dnsCheck: true }, {
    resolveDns: () => Promise.resolve([]),
  });
  expect(r.status).toBe("fail");
});

// ---- SSL cert signal ----

test("cert check passes for a certificate valid in the future", async () => {
  const r = await runHeartbeat(
    "https://secure.test",
    { path: "/", certCheck: true, dnsCheck: false },
    {
      fetch: stubFetch(200, "ok"),
      now: fakeClock(0),
      inspectCert: () => Promise.resolve({ validTo: new Date(10_000) }),
    },
  );
  expect(r.status).toBe("pass");
});

test("cert check fails for an expired certificate", async () => {
  const r = await runHeartbeat(
    "https://secure.test",
    { path: "/", certCheck: true, dnsCheck: false },
    {
      fetch: stubFetch(200, "ok"),
      now: fakeClock(10_000),
      inspectCert: () => Promise.resolve({ validTo: new Date(0) }),
    },
  );
  expect(r.status).toBe("fail");
  expect(r.error?.toLowerCase()).toContain("cert");
});

test("cert check fails when the target is not https", async () => {
  const r = await runHeartbeat(origin, { ...SPEC, certCheck: true });
  expect(r.status).toBe("fail");
  expect(r.error).toContain("https");
});

// ---- all signals together ----

test("passes when every enabled signal passes", async () => {
  const r = await runHeartbeat(
    "https://secure.test",
    {
      path: "/health",
      certCheck: true,
      dnsCheck: true,
      bodyAssertion: { kind: "jsonpath", pattern: "status", equals: "green" },
    },
    {
      fetch: stubFetch(200, JSON.stringify({ status: "green" })),
      resolveDns: () => Promise.resolve(["93.184.216.34"]),
      inspectCert: () => Promise.resolve({ validTo: new Date(Date.parse("2999-01-01")) }),
      now: fakeClock(0),
    },
  );
  expect(r.status).toBe("pass");
  expect(r.error).toBeNull();
});

test("aggregates multiple failures into one error string", async () => {
  const r = await runHeartbeat(
    "https://secure.test",
    {
      path: "/",
      certCheck: true,
      dnsCheck: true,
      bodyAssertion: { kind: "regex", pattern: "ok" },
    },
    {
      fetch: stubFetch(503, "down"),
      resolveDns: () => Promise.reject(new Error("NXDOMAIN")),
      inspectCert: () => Promise.resolve({ validTo: new Date(0) }),
      now: fakeClock(10_000),
    },
  );
  expect(r.status).toBe("fail");
  // DNS + HTTP 503 + body + cert — at least three distinct reasons joined.
  expect(r.error!.split(";").length).toBeGreaterThanOrEqual(3);
});
