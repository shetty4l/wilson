import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config";

/**
 * Config tests use a tmp directory as XDG_CONFIG_HOME to avoid
 * touching the real ~/.config/wilson/config.json.
 */

const TMP = join(tmpdir(), `wilson-config-test-${process.pid}`);
const CONFIG_DIR = join(TMP, "wilson");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Point core's getConfigDir to our tmp via XDG
  process.env.XDG_CONFIG_HOME = TMP;
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe("loadConfig", () => {
  test("loads defaults when no config file exists", () => {
    // Remove the config file so it falls through to defaults
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);

    const result = loadConfig();
    // Without apiKey defaults, it should fail validation
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cortex.apiKey is required");
    }
  });

  test("loads config from file with overrides", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        port: 9999,
        cortex: { url: "http://example.com", apiKey: "test-key-123" },
        channels: { calendar: { enabled: true, pollIntervalSeconds: 300 } },
      }),
    );

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.value.port).toBe(9999);
    expect(result.value.cortex.url).toBe("http://example.com");
    expect(result.value.cortex.apiKey).toBe("test-key-123");
    expect(result.value.channels.calendar.enabled).toBe(true);
    expect(result.value.channels.calendar.pollIntervalSeconds).toBe(300);
    // Defaults preserved for unspecified fields
    expect(result.value.channels.calendar.lookAheadDays).toBe(14);
    expect(result.value.channels.calendar.extendedLookAheadDays).toBe(30);
    expect(result.value.host).toBe("0.0.0.0");
  });

  test("returns Err when cortex.apiKey is missing", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ cortex: { url: "http://example.com" } }),
    );

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error).toContain("cortex.apiKey is required");
  });

  test("supports ${ENV_VAR} interpolation", () => {
    const envKey = "WILSON_TEST_API_KEY_" + process.pid;
    process.env[envKey] = "secret-from-env";

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        cortex: {
          url: "http://localhost:7751",
          apiKey: `\${${envKey}}`,
        },
      }),
    );

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.cortex.apiKey).toBe("secret-from-env");

    delete process.env[envKey];
  });
});
