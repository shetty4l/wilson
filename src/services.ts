import { getConfigDir, getDataDir } from "@shetty4l/core/config";
import { err, ok, type Result } from "@shetty4l/core/result";
import { homedir } from "os";
import { join } from "path";

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

const HOME = homedir();

export const SERVICES: readonly ServiceConfig[] = [
  {
    name: "engram",
    displayName: "Engram",
    repo: "shetty4l/engram",
    port: 7749,
    healthUrl: "http://localhost:7749/health",
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
    healthUrl: "http://localhost:7750/health",
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
    healthUrl: "http://localhost:7751/health",
    installBase: join(HOME, "srv", "cortex"),
    configDir: getConfigDir("cortex"),
    dataDir: getDataDir("cortex"),
    currentVersionFile: join(HOME, "srv", "cortex", "current-version"),
    cliPath: join(HOME, ".local", "bin", "cortex"),
    logFiles: {
      daemon: join(getConfigDir("cortex"), "cortex.log"),
    },
  },
] as const;

export const UPDATER_LOG = join(HOME, "Library", "Logs", "wilson-updater.log");

export const WILSON_CONFIG = {
  name: "wilson",
  displayName: "Wilson",
  repo: "shetty4l/wilson",
  installBase: join(HOME, "srv", "wilson"),
  currentVersionFile: join(HOME, "srv", "wilson", "current-version"),
  cliPath: join(HOME, ".local", "bin", "wilson"),
} as const;

export function getService(name: string): Result<ServiceConfig, string> {
  const svc = SERVICES.find((s) => s.name === name);
  if (!svc) return err(`unknown service "${name}"`);
  return ok(svc);
}

export function getServiceNames(): string[] {
  return SERVICES.map((s) => s.name);
}

/**
 * All valid log source names for `wilson logs <source>`.
 * Includes each service name + "updater" for the wilson update log.
 */
export function getLogSources(): string[] {
  return [...getServiceNames(), "updater"];
}
