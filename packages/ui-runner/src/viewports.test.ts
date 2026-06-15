import { expect, test } from "bun:test";
import { VIEWPORTS, resolveViewports } from "./viewports.ts";

test("the three canonical viewports carry the PRD render sizes", () => {
  expect(VIEWPORTS.mobile).toEqual({ label: "mobile", width: 375, height: 812 });
  expect(VIEWPORTS.tablet).toEqual({ label: "tablet", width: 768, height: 1024 });
  expect(VIEWPORTS.desktop).toEqual({ label: "desktop", width: 1440, height: 900 });
});

test("resolveViewports maps labels to full Viewport sizes, preserving order", () => {
  expect(resolveViewports(["desktop", "mobile"])).toEqual([
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 375, height: 812 },
  ]);
});

test("resolveViewports rejects an unknown viewport label", () => {
  expect(() => resolveViewports(["mobile", "watch"])).toThrow(/watch/);
});

test("resolveViewports on an empty list yields no viewports", () => {
  expect(resolveViewports([])).toEqual([]);
});
