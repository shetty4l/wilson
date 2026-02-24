import { loadJsonConfig } from "@shetty4l/core/config";
import { err, ok, type Result } from "@shetty4l/core/result";

// --- Types ---

export interface CalendarChannelConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  lookAheadDays: number;
  extendedLookAheadDays: number;
  includeCalendars?: string[];
}

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds: number[];
  pollIntervalMs?: number;
  deliveryMaxBatch?: number;
  deliveryLeaseSeconds?: number;
}

export interface CortexConfig {
  url: string;
  apiKey: string;
}

export interface ServiceUrlConfig {
  url: string;
}

export interface ServicesConfig {
  engram: ServiceUrlConfig;
  synapse: ServiceUrlConfig;
  cortex: ServiceUrlConfig;
}

export interface WilsonConfig {
  port: number;
  host: string;
  cortex: CortexConfig;
  services: ServicesConfig;
  channels: {
    calendar: CalendarChannelConfig;
    telegram: TelegramChannelConfig;
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
  services: {
    engram: { url: "http://localhost:7749" },
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
    telegram: {
      enabled: false,
      botToken: "",
      allowedUserIds: [],
      pollIntervalMs: 250,
      deliveryMaxBatch: 20,
      deliveryLeaseSeconds: 60,
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

  const servicesRaw = (raw.services ?? {}) as Record<string, unknown>;
  const engramRaw = (servicesRaw.engram ?? {}) as Record<string, unknown>;
  const synapseRaw = (servicesRaw.synapse ?? {}) as Record<string, unknown>;
  const cortexSvcRaw = (servicesRaw.cortex ?? {}) as Record<string, unknown>;
  const services: ServicesConfig = {
    engram: { ...DEFAULTS.services.engram, ...engramRaw },
    synapse: { ...DEFAULTS.services.synapse, ...synapseRaw },
    cortex: { ...DEFAULTS.services.cortex, ...cortexSvcRaw },
  };

  const channelsRaw = (raw.channels ?? {}) as Record<string, unknown>;
  const calendarRaw = (channelsRaw.calendar ?? {}) as Record<string, unknown>;
  const calendar: CalendarChannelConfig = {
    ...DEFAULTS.channels.calendar,
    ...calendarRaw,
  };

  const telegramRaw = (channelsRaw.telegram ?? {}) as Record<string, unknown>;
  const telegram: TelegramChannelConfig = {
    ...DEFAULTS.channels.telegram,
    ...telegramRaw,
  };

  const config: WilsonConfig = {
    port: (raw.port as number) ?? DEFAULTS.port,
    host: (raw.host as string) ?? DEFAULTS.host,
    cortex,
    services,
    channels: { calendar, telegram },
  };

  if (!config.cortex.apiKey) {
    return err(
      "cortex.apiKey is required in ~/.config/wilson/config.json (or set CORTEX_API_KEY and use ${CORTEX_API_KEY})",
    );
  }

  // Validate telegram config if enabled
  if (config.channels.telegram.enabled) {
    if (!config.channels.telegram.botToken) {
      return err(
        "channels.telegram.botToken is required when telegram is enabled (or set TELEGRAM_BOT_TOKEN and use ${TELEGRAM_BOT_TOKEN})",
      );
    }
    if (
      !config.channels.telegram.allowedUserIds ||
      config.channels.telegram.allowedUserIds.length === 0
    ) {
      return err(
        "channels.telegram.allowedUserIds must contain at least one user ID when telegram is enabled",
      );
    }
  }

  return ok(config);
}
