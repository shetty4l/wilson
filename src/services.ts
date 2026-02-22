import { getConfigDir, getDataDir } from "@shetty4l/core/config";
import { err, ok, type Result } from "@shetty4l/core/result";
import { homedir } from "os";
import { join } from "path";
import type { WilsonConfig } from "./config";

export interface ServiceConfig {
  name: string;
  displayName: string;
  repo: string;
  port: number;
  healthUrl: string;
  installBase: string;
  configDir: string;
  dataDir?: string;
  currentVersionFile: string;
  cliPath: string;
  logFiles: Record<string, string>;
}

interface StaticServiceConfig {
  name: string;
  displayName: string;
  repo: string;
  port: number;
  installBase: string;
  configDir: string;
  dataDir?: string;
  currentVersionFile: string;
  cliPath: string;
  logFiles: Record<string, string>;
}

const HOME = homedir();

/**
 * Static service definitions (without healthUrl, which comes from config).
 */
const STATIC_SERVICES: readonly StaticServiceConfig[] = [
  {
    name: "engram",
    displayName: "Engram",
    repo: "shetty4l/engram",
    port: 7749,
    installBase: join(HOME, "srv", "engram"),
    configDir: getConfigDir("engram"),
    dataDir: getDataDir("engram"),
    currentVersionFile: join(HOME, "srv", "engram", "current-version"),
    cliPath: join(HOME, ".local", "bin", "engram"),
    logFiles: {
      daemon: join(getConfigDir("engram"), "engram.log"),
    },
  },
  {
    name: "synapse",
    displayName: "Synapse",
    repo: "shetty4l/synapse",
    port: 7750,
    installBase: join(HOME, "srv", "synapse"),
    configDir: getConfigDir("synapse"),
    currentVersionFile: join(HOME, "srv", "synapse", "current-version"),
    cliPath: join(HOME, ".local", "bin", "synapse"),
    logFiles: {
      daemon: join(getConfigDir("synapse"), "synapse.log"),
    },
  },
  {
    name: "cortex",
    displayName: "Cortex",
    repo: "shetty4l/cortex",
    port: 7751,
    installBase: join(HOME, "srv", "cortex"),
    configDir: getConfigDir("cortex"),
    dataDir: getDataDir("cortex"),
    currentVersionFile: join(HOME, "srv", "cortex", "current-version"),
    cliPath: join(HOME, ".local", "bin", "cortex"),
    logFiles: {
      daemon: join(getConfigDir("cortex"), "cortex.log"),
    },
  },
  {
    name: "wilson",
    displayName: "Wilson",
    repo: "shetty4l/wilson",
    port: 7748,
    installBase: join(HOME, "srv", "wilson"),
    configDir: getConfigDir("wilson"),
    currentVersionFile: join(HOME, "srv", "wilson", "current-version"),
    cliPath: join(HOME, ".local", "bin", "wilson"),
    logFiles: {
      daemon: join(getConfigDir("wilson"), "wilson.log"),
    },
  },
] as const;

/**
 * Get services with healthUrl derived from config.
 * Falls back to localhost defaults if config is not provided.
 */
export function getServices(config?: WilsonConfig): readonly ServiceConfig[] {
  return STATIC_SERVICES.map((svc) => {
    let healthUrl: string;
    if (svc.name === "wilson") {
      // Wilson uses its own port/host from config
      const host = config?.host ?? "localhost";
      const port = config?.port ?? 7748;
      // Use localhost for health checks even if host is 0.0.0.0
      const healthHost = host === "0.0.0.0" ? "localhost" : host;
      healthUrl = `http://${healthHost}:${port}/health`;
    } else if (config?.services) {
      const svcConfig =
        config.services[svc.name as keyof typeof config.services];
      healthUrl = svcConfig
        ? `${svcConfig.url}/health`
        : `http://localhost:${svc.port}/health`;
    } else {
      healthUrl = `http://localhost:${svc.port}/health`;
    }
    return { ...svc, healthUrl };
  });
}

/**
 * Legacy SERVICES array for backward compatibility.
 * Uses default localhost URLs.
 * @deprecated Use getServices(config) instead for config-aware URLs.
 */
export const SERVICES: readonly ServiceConfig[] = getServices();

export function getService(
  name: string,
  config?: WilsonConfig,
): Result<ServiceConfig, string> {
  const services = config ? getServices(config) : SERVICES;
  const svc = services.find((s) => s.name === name);
  if (!svc) return err(`unknown service "${name}"`);
  return ok(svc);
}

export function getServiceNames(): string[] {
  return STATIC_SERVICES.map((s) => s.name);
}

/**
 * All valid log source names for `wilson logs <source>`.
 * Includes each service name + "supervisor" for the wilson-ctl supervisor log.
 */
export function getLogSources(): string[] {
  return [...getServiceNames(), "supervisor"];
}
