import { loadJsonConfig } from "@shetty4l/core/config";
import { err, ok, type Result } from "@shetty4l/core/result";

// --- Types ---

export interface CalendarChannelConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  lookAheadDays: number;
  extendedLookAheadDays: number;
}

export interface CortexConfig {
  url: string;
  apiKey: string;
}

export interface WilsonConfig {
  port: number;
  host: string;
  cortex: CortexConfig;
  channels: {
    calendar: CalendarChannelConfig;
  };
}

// --- Defaults ---

const DEFAULTS: WilsonConfig = {
  port: 7748,
  host: "0.0.0.0",
  cortex: {
    url: "http://localhost:7751",
    apiKey: "",
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

// --- Loader ---

/**
 * Load Wilson config from ~/.config/wilson/config.json with defaults
 * and ${ENV_VAR} interpolation.
 *
 * cortex.apiKey is required — returns Err if missing or empty.
 */
export function loadConfig(): Result<WilsonConfig> {
  const result = loadJsonConfig({
    name: "wilson",
    defaults: DEFAULTS as unknown as Record<string, unknown>,
  });

  if (!result.ok) return result as Result<never>;

  const raw = result.value.config as Record<string, unknown>;

  // Deep-merge nested objects that loadJsonConfig shallow-merges
  const cortexRaw = (raw.cortex ?? {}) as Record<string, unknown>;
  const cortex: CortexConfig = {
    ...DEFAULTS.cortex,
    ...cortexRaw,
  };

  const channelsRaw = (raw.channels ?? {}) as Record<string, unknown>;
  const calendarRaw = (channelsRaw.calendar ?? {}) as Record<string, unknown>;
  const calendar: CalendarChannelConfig = {
    ...DEFAULTS.channels.calendar,
    ...calendarRaw,
  };

  const config: WilsonConfig = {
    port: (raw.port as number) ?? DEFAULTS.port,
    host: (raw.host as string) ?? DEFAULTS.host,
    cortex,
    channels: { calendar },
  };

  if (!config.cortex.apiKey) {
    return err(
      "cortex.apiKey is required in ~/.config/wilson/config.json (or set CORTEX_API_KEY and use ${CORTEX_API_KEY})",
    );
  }

  return ok(config);
}
