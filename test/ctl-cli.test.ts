import { describe, expect, test } from "bun:test";

describe("ctl-cli", () => {
  test("module imports without error", async () => {
    // Importing the module should not throw or call process.exit
    // because of the isDirectRun guard
    const mod = await import("../src/ctl-cli");
    expect(mod).toBeDefined();
  });
});
