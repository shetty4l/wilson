import type { WilsonConfig } from "../config";
import { fetchHealth, type HealthResponse } from "../health";
import { getServices } from "../services";

// --- Engram Stats Types ---

export interface EngramStats {
  memories: {
    total: number;
    with_embedding_pct: number;
  };
  operations: {
    recall_1h: number;
    remember_1h: number;
    recall_hit_rate_1h: number;
    recall_fallback_rate_1h: number;
  };
  latency: {
    recall_p50_ms: number;
    recall_p95_ms: number;
    recall_p99_ms: number;
  };
}

// --- Synapse Stats Types ---

export interface SynapseProvider {
  name: string;
  healthy: boolean;
  consecutiveFailures: number;
}

export interface SynapseStats {
  buffer: {
    capacity: number;
    size: number;
    oldest_entry_at: string | null;
  };
  requests: {
    total_1h: number;
    errors_1h: number;
    by_provider: Record<string, number>;
  };
  latency: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
  };
  fallbacks: {
    count_1h: number;
  };
  providers: SynapseProvider[];
}

// --- Cortex Stats Types ---

export interface CortexStats {
  inbox: {
    pending: number;
    processing: number;
    done_1h: number;
    failed_1h: number;
  };
  outbox: {
    pending: number;
    delivered_1h: number;
    dead_total: number;
  };
  receptors: {
    calendar_last_sync_at: string | null;
    calendar_buffer_pending: number;
    thalamus_last_run_at: string | null;
  };
  processing: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
  };
}

// --- Health Status ---

export interface HealthStatus {
  status: string;
  version?: string;
  uptime_seconds?: number;
}

// --- Service Stats Result ---

export interface ServiceStats {
  engram: EngramStats | null;
  synapse: SynapseStats | null;
  cortex: CortexStats | null;
  health: Record<string, HealthStatus>;
}

// --- Fetch Functions ---

const TIMEOUT_MS = 3000;

async function fetchWithTimeout<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Fetch stats and health from all services in parallel.
 * Uses Promise.allSettled for partial failure tolerance.
 */
export async function fetchAllStats(
  config: WilsonConfig,
): Promise<ServiceStats> {
  const services = getServices(config);

  // Build URLs from config
  const engramStatsUrl = `${config.services.engram.url}/stats`;
  const synapseStatsUrl = `${config.services.synapse.url}/stats`;
  const cortexStatsUrl = `${config.services.cortex.url}/stats`;

  // Fetch all stats and health in parallel
  const [
    engramStatsResult,
    synapseStatsResult,
    cortexStatsResult,
    ...healthResults
  ] = await Promise.allSettled([
    fetchWithTimeout<EngramStats>(engramStatsUrl),
    fetchWithTimeout<SynapseStats>(synapseStatsUrl),
    fetchWithTimeout<CortexStats>(cortexStatsUrl),
    ...services.map((svc) => fetchHealth(svc.healthUrl)),
  ]);

  // Extract stats (null on failure)
  const engram =
    engramStatsResult.status === "fulfilled" ? engramStatsResult.value : null;
  const synapse =
    synapseStatsResult.status === "fulfilled" ? synapseStatsResult.value : null;
  const cortex =
    cortexStatsResult.status === "fulfilled" ? cortexStatsResult.value : null;

  // Build health map
  const health: Record<string, HealthStatus> = {};
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const result = healthResults[i];

    if (result.status === "fulfilled" && result.value.ok) {
      const data = result.value.value as HealthResponse;
      health[svc.name] = {
        status: data.status,
        version: data.version,
        uptime_seconds: data.uptime_seconds as number | undefined,
      };
    }
    // Don't add entry if health check failed — absence indicates down
  }

  return { engram, synapse, cortex, health };
}
