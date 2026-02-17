import { describe, expect, test } from "bun:test";
import { parseArgs } from "@shetty4l/core/cli";

describe("parseArgs", () => {
  test("extracts command and args", () => {
    const result = parseArgs(["status"]);
    expect(result.command).toBe("status");
    expect(result.args).toEqual([]);
    expect(result.json).toBe(false);
  });

  test("extracts command with args", () => {
    const result = parseArgs(["logs", "engram", "50"]);
    expect(result.command).toBe("logs");
    expect(result.args).toEqual(["engram", "50"]);
    expect(result.json).toBe(false);
  });

  test("detects --json flag and strips it", () => {
    const result = parseArgs(["status", "--json"]);
    expect(result.command).toBe("status");
    expect(result.args).toEqual([]);
    expect(result.json).toBe(true);
  });

  test("--json works in any position", () => {
    const result = parseArgs(["--json", "health"]);
    expect(result.command).toBe("health");
    expect(result.json).toBe(true);
  });

  test("defaults to help when no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
    expect(result.args).toEqual([]);
  });

  test("passes through unknown commands", () => {
    const result = parseArgs(["unknown-cmd", "arg1"]);
    expect(result.command).toBe("unknown-cmd");
    expect(result.args).toEqual(["arg1"]);
  });
});
