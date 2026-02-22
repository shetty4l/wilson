import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { parseArgs } from "@shetty4l/core/cli";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cmdConfig } from "../src/cli";

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

// --- cmdConfig ---

describe("cmdConfig", () => {
  const TMP = join(tmpdir(), `wilson-cli-config-test-${process.pid}`);
  const CONFIG_DIR = join(TMP, "wilson");
  const CONFIG_PATH = join(CONFIG_DIR, "config.json");

  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    process.env.XDG_CONFIG_HOME = TMP;
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  test("returns 1 when config is invalid", () => {
    // No config file → missing apiKey → error
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const code = cmdConfig([], false);
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("prints human-readable config", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        port: 9999,
        cortex: { url: "http://example.com", apiKey: "secret-key" },
        channels: { calendar: { enabled: true } },
      }),
    );

    const lines: string[] = [];
    const spy = jest
      .spyOn(console, "log")
      .mockImplementation((msg: string) => lines.push(msg));

    const code = cmdConfig([], false);
    expect(code).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("9999");
    expect(output).toContain("http://example.com");
    expect(output).toContain("***"); // apiKey masked
    expect(output).not.toContain("secret-key");
    expect(output).toContain("true"); // calendar enabled

    spy.mockRestore();
  });

  test("prints JSON with --json flag", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        cortex: { url: "http://example.com", apiKey: "secret-key" },
      }),
    );

    const lines: string[] = [];
    const spy = jest
      .spyOn(console, "log")
      .mockImplementation((msg: string) => lines.push(msg));

    const code = cmdConfig([], true);
    expect(code).toBe(0);

    const parsed = JSON.parse(lines.join(""));
    expect(parsed.cortex.apiKey).toBe("***"); // masked in JSON too
    expect(parsed.cortex.url).toBe("http://example.com");
    expect(parsed.port).toBe(7748); // default

    spy.mockRestore();
  });
});
