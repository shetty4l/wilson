import { homedir } from "os";
import { join } from "path";

export interface ServiceConfig {
  name: string;
  displayName: string;
  repo: string;
  port: number;
  healthUrl: string;
  installBase: string;
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
    currentVersionFile: join(HOME, "srv", "engram", "current-version"),
    cliPath: join(HOME, ".local", "bin", "engram"),
    logFiles: {
      daemon: join(HOME, ".local", "share", "engram", "engram.log"),
      updater: join(HOME, "Library", "Logs", "wilson-updater.log"),
    },
  },
  {
    name: "synapse",
    displayName: "Synapse",
    repo: "shetty4l/synapse",
    port: 7750,
    healthUrl: "http://localhost:7750/health",
    installBase: join(HOME, "srv", "synapse"),
    currentVersionFile: join(HOME, "srv", "synapse", "current-version"),
    cliPath: join(HOME, ".local", "bin", "synapse"),
    logFiles: {
      daemon: join(HOME, ".config", "synapse", "synapse.log"),
      updater: join(HOME, "Library", "Logs", "wilson-updater.log"),
    },
  },
] as const;

export const WILSON_CONFIG = {
  name: "wilson",
  displayName: "Wilson",
  repo: "shetty4l/wilson",
  installBase: join(HOME, "srv", "wilson"),
  currentVersionFile: join(HOME, "srv", "wilson", "current-version"),
  cliPath: join(HOME, ".local", "bin", "wilson"),
  logFiles: {
    updater: join(HOME, "Library", "Logs", "wilson-updater.log"),
  },
} as const;

export function getService(name: string): ServiceConfig | undefined {
  return SERVICES.find((s) => s.name === name);
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
