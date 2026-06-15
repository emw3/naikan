import { expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./password.ts";

test("hashPassword produces a hash that is not the plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash).not.toBe("correct horse battery staple");
  expect(hash.length).toBeGreaterThan(0);
});

test("verifyPassword accepts the right password and rejects the wrong one", async () => {
  const hash = await hashPassword("hunter2");
  expect(await verifyPassword("hunter2", hash)).toBe(true);
  expect(await verifyPassword("hunter3", hash)).toBe(false);
});

test("verifyPassword returns false for a malformed hash instead of throwing", async () => {
  expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
});
