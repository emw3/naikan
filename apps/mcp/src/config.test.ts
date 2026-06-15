import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

test("loadConfig returns the api url + token when both are set", () => {
  const cfg = loadConfig({ NAIKAN_API_URL: "http://localhost:3000", NAIKAN_AGENT_TOKEN: "tok" });
  expect(cfg).toEqual({ apiUrl: "http://localhost:3000", agentToken: "tok" });
});

test("loadConfig strips trailing slashes from the api url", () => {
  const cfg = loadConfig({ NAIKAN_API_URL: "http://localhost:3000///", NAIKAN_AGENT_TOKEN: "tok" });
  expect(cfg.apiUrl).toBe("http://localhost:3000");
});

test("loadConfig fails fast naming a missing api url", () => {
  const err = (() => {
    try {
      loadConfig({ NAIKAN_AGENT_TOKEN: "tok" });
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err?.message).toContain("NAIKAN_API_URL");
});

test("loadConfig fails fast naming a missing token", () => {
  const err = (() => {
    try {
      loadConfig({ NAIKAN_API_URL: "http://localhost:3000" });
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err?.message).toContain("NAIKAN_AGENT_TOKEN");
});

test("loadConfig treats blank/whitespace values as missing", () => {
  const err = (() => {
    try {
      loadConfig({ NAIKAN_API_URL: "   ", NAIKAN_AGENT_TOKEN: "" });
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err?.message).toContain("NAIKAN_API_URL");
  expect(err?.message).toContain("NAIKAN_AGENT_TOKEN");
});
