import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import type { WilsonConfig } from "../src/config";
import {
  getLogSources,
  getService,
  getServiceNames,
  getServices,
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

  test("getServices returns services with config URLs", () => {
    const config: WilsonConfig = {
      port: 7748,
      host: "0.0.0.0",
      cortex: { url: "http://localhost:7751", apiKey: "test" },
      services: {
        engram: { url: "http://engram.example.com:9000" },
        synapse: { url: "http://synapse.example.com:9001" },
        cortex: { url: "http://cortex.example.com:9002" },
      },
      channels: {
        calendar: {
          enabled: false,
          pollIntervalSeconds: 600,
          lookAheadDays: 14,
          extendedLookAheadDays: 30,
        },
      },
    };

    const services = getServices(config);

    const engram = services.find((s) => s.name === "engram");
    expect(engram?.healthUrl).toBe("http://engram.example.com:9000/health");

    const synapse = services.find((s) => s.name === "synapse");
    expect(synapse?.healthUrl).toBe("http://synapse.example.com:9001/health");

    const cortex = services.find((s) => s.name === "cortex");
    expect(cortex?.healthUrl).toBe("http://cortex.example.com:9002/health");

    // Wilson uses localhost for health when host is 0.0.0.0
    const wilson = services.find((s) => s.name === "wilson");
    expect(wilson?.healthUrl).toBe("http://localhost:7748/health");
  });

  test("getService with config returns config-aware healthUrl", () => {
    const config: WilsonConfig = {
      port: 8080,
      host: "192.168.1.1",
      cortex: { url: "http://localhost:7751", apiKey: "test" },
      services: {
        engram: { url: "http://engram.lan" },
        synapse: { url: "http://localhost:7750" },
        cortex: { url: "http://localhost:7751" },
      },
      channels: {
        calendar: {
          enabled: false,
          pollIntervalSeconds: 600,
          lookAheadDays: 14,
          extendedLookAheadDays: 30,
        },
      },
    };

    const engramResult = getService("engram", config);
    expect(engramResult.ok).toBe(true);
    if (engramResult.ok) {
      expect(engramResult.value.healthUrl).toBe("http://engram.lan/health");
    }

    // Wilson uses the actual host when it's not 0.0.0.0
    const wilsonResult = getService("wilson", config);
    expect(wilsonResult.ok).toBe(true);
    if (wilsonResult.ok) {
      expect(wilsonResult.value.healthUrl).toBe(
        "http://192.168.1.1:8080/health",
      );
    }
  });
});
