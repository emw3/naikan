import { expect, test } from "bun:test";
import { KERNEL_NAME, RUNTIME_AGNOSTIC } from "./index.ts";

test("kernel exposes its identity markers", () => {
  expect(RUNTIME_AGNOSTIC).toBe(true);
  expect(KERNEL_NAME).toBe("@naikan/kernel-core");
});
