import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  getLogSources,
  getService,
  getServiceNames,
  SERVICES,
} from "../src/services";

const HOME = homedir();

describe("service registry", () => {
  test("has expected number of services", () => {
    expect(SERVICES.length).toBe(4);
  });

  test("each service has all required fields", () => {
    for (const svc of SERVICES) {
      expect(svc.name).toBeTruthy();
      expect(svc.displayName).toBeTruthy();
      expect(svc.repo).toMatch(/^shetty4l\//);
      expect(svc.port).toBeGreaterThan(0);
      expect(svc.healthUrl).toStartWith("http://localhost:");
      expect(svc.installBase).toStartWith(HOME);
      expect(svc.currentVersionFile).toContain("current-version");
      expect(svc.cliPath).toContain(".local/bin");
      expect(Object.keys(svc.logFiles).length).toBeGreaterThan(0);
    }
  });

  test("getService returns correct service", () => {
    const result = getService("engram");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.port).toBe(7749);
    expect(result.value.repo).toBe("shetty4l/engram");
  });

  test("getService returns correct cortex config", () => {
    const result = getService("cortex");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.port).toBe(7751);
    expect(result.value.repo).toBe("shetty4l/cortex");
  });

  test("getService returns err for unknown", () => {
    const result = getService("unknown");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error).toBe('unknown service "unknown"');
  });

  test("getServiceNames returns all names", () => {
    const names = getServiceNames();
    expect(names).toContain("engram");
    expect(names).toContain("synapse");
    expect(names).toContain("cortex");
    expect(names).toContain("wilson");
    expect(names.length).toBe(4);
  });

  test("getLogSources includes services and supervisor", () => {
    const sources = getLogSources();
    expect(sources).toContain("engram");
    expect(sources).toContain("synapse");
    expect(sources).toContain("cortex");
    expect(sources).toContain("wilson");
    expect(sources).toContain("supervisor");
    expect(sources.length).toBe(5);
  });

  test("getService returns correct wilson config", () => {
    const result = getService("wilson");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.port).toBe(7748);
    expect(result.value.repo).toBe("shetty4l/wilson");
    expect(result.value.installBase).toBe(join(HOME, "srv", "wilson"));
    expect(result.value.cliPath).toBe(join(HOME, ".local", "bin", "wilson"));
    expect(result.value.healthUrl).toBe("http://localhost:7748/health");
  });
});
