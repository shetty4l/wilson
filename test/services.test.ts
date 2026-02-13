import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  getLogSources,
  getService,
  getServiceNames,
  SERVICES,
  WILSON_CONFIG,
} from "../src/services";

const HOME = homedir();

describe("service registry", () => {
  test("has expected number of services", () => {
    expect(SERVICES.length).toBe(2);
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
    const engram = getService("engram");
    expect(engram).toBeDefined();
    expect(engram!.port).toBe(7749);
    expect(engram!.repo).toBe("shetty4l/engram");
  });

  test("getService returns undefined for unknown", () => {
    expect(getService("unknown")).toBeUndefined();
  });

  test("getServiceNames returns all names", () => {
    const names = getServiceNames();
    expect(names).toContain("engram");
    expect(names).toContain("synapse");
    expect(names.length).toBe(2);
  });

  test("getLogSources includes services and updater", () => {
    const sources = getLogSources();
    expect(sources).toContain("engram");
    expect(sources).toContain("synapse");
    expect(sources).toContain("updater");
  });

  test("wilson config has correct paths", () => {
    expect(WILSON_CONFIG.repo).toBe("shetty4l/wilson");
    expect(WILSON_CONFIG.installBase).toBe(join(HOME, "srv", "wilson"));
    expect(WILSON_CONFIG.cliPath).toBe(join(HOME, ".local", "bin", "wilson"));
  });
});
