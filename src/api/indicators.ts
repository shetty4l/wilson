import type { ServiceStats } from "./stats";

export type IndicatorStatus = "green" | "yellow" | "red";

export interface Indicator {
  id: string;
  name: string;
  status: IndicatorStatus;
  label: string;
  detail: string;
}

// --- Helper Functions ---

function msToSeconds(ms: number): number {
  return ms / 1000;
}

function hoursAgo(isoDate: string | null | undefined): number {
  if (!isoDate) return Number.POSITIVE_INFINITY;
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now - then) / (1000 * 60 * 60);
}

// --- Indicator Computations ---

function computeSensing(stats: ServiceStats): Indicator {
  const id = "sensing";
  const name = "Sensing";

  // Service down or missing → green/Idle
  if (!stats.cortex) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Cortex offline",
    };
  }

  const receptors = stats.cortex.receptors;
  const calendarHoursAgo = hoursAgo(receptors.calendar_last_sync_at);
  const buffer = receptors.calendar_buffer_pending;

  // Red: sync > 6h OR buffer > 50
  if (calendarHoursAgo > 6 || buffer > 50) {
    return {
      id,
      name,
      status: "red",
      label: "Stale",
      detail: `Last sync ${calendarHoursAgo === Number.POSITIVE_INFINITY ? "never" : `${Math.round(calendarHoursAgo)}h ago`}, ${buffer} buffered`,
    };
  }

  // Yellow: sync 1-6h OR buffer 10-50
  if (calendarHoursAgo > 1 || buffer >= 10) {
    return {
      id,
      name,
      status: "yellow",
      label: "Delayed",
      detail: `Last sync ${Math.round(calendarHoursAgo)}h ago, ${buffer} buffered`,
    };
  }

  // Green: sync < 1h AND buffer < 10
  return {
    id,
    name,
    status: "green",
    label: "Active",
    detail: `Last sync ${Math.round(calendarHoursAgo * 60)}m ago, ${buffer} buffered`,
  };
}

function computeTriage(stats: ServiceStats): Indicator {
  const id = "triage";
  const name = "Triage";

  if (!stats.cortex) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Cortex offline",
    };
  }

  const inbox = stats.cortex.inbox;
  const pending = inbox.pending;
  const failed = inbox.failed_1h;
  const processing = inbox.processing;

  // Red: pending > 10 OR failed > 3 OR processing > 1
  if (pending > 10 || failed > 3 || processing > 1) {
    return {
      id,
      name,
      status: "red",
      label: "Backlog",
      detail: `${pending} pending, ${failed} failed, ${processing} processing`,
    };
  }

  // Yellow: pending 3-10 OR failed 1-3
  if (pending >= 3 || failed >= 1) {
    return {
      id,
      name,
      status: "yellow",
      label: "Busy",
      detail: `${pending} pending, ${failed} failed`,
    };
  }

  // Green: pending <= 2, failed 0
  return {
    id,
    name,
    status: "green",
    label: "Clear",
    detail: `${pending} pending, ${inbox.done_1h} done/1h`,
  };
}

function computeReasoning(stats: ServiceStats): Indicator {
  const id = "reasoning";
  const name = "Reasoning";

  if (!stats.cortex) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Cortex offline",
    };
  }

  const p50Seconds = msToSeconds(stats.cortex.processing.p50_ms);
  const errors = stats.cortex.inbox.failed_1h;

  // Calculate synapse error rate (LLM errors impact reasoning)
  const synapseErrorRate =
    stats.synapse && stats.synapse.requests.total_1h > 0
      ? stats.synapse.requests.errors_1h / stats.synapse.requests.total_1h
      : 0;

  // Get synapse latency for context in detail message
  const synapseP50 = stats.synapse
    ? msToSeconds(stats.synapse.latency.p50_ms)
    : null;

  // Helper to build detail message with synapse context
  const buildDetail = (includeErrors: boolean): string => {
    const parts = [`p50 ${p50Seconds.toFixed(1)}s`];
    if (synapseP50 !== null) {
      parts.push(`synapse ${synapseP50.toFixed(1)}s`);
    }
    if (includeErrors && errors > 0) {
      parts.push(`${errors} errors/1h`);
    }
    if (synapseErrorRate > 0.05) {
      parts.push(`${(synapseErrorRate * 100).toFixed(0)}% LLM errors`);
    }
    return parts.join(", ");
  };

  // Red: p50 > 15s OR errors > 5 OR synapse error rate > 20%
  if (p50Seconds > 15 || errors > 5 || synapseErrorRate > 0.2) {
    return {
      id,
      name,
      status: "red",
      label: "Slow",
      detail: buildDetail(true),
    };
  }

  // Yellow: p50 5-15s OR errors 1-5 OR synapse error rate > 5%
  if (p50Seconds > 5 || errors >= 1 || synapseErrorRate > 0.05) {
    return {
      id,
      name,
      status: "yellow",
      label: "Lagging",
      detail: buildDetail(true),
    };
  }

  // Green: p50 < 5s, errors 0, synapse error rate <= 5%
  return {
    id,
    name,
    status: "green",
    label: "Fast",
    detail: buildDetail(false),
  };
}

function computeMemory(stats: ServiceStats): Indicator {
  const id = "memory";
  const name = "Memory";

  if (!stats.engram) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Engram offline",
    };
  }

  const embeddingPct = stats.engram.memories.with_embedding_pct;
  const total = stats.engram.memories.total;

  // Red: embedding < 90%
  if (embeddingPct < 90) {
    return {
      id,
      name,
      status: "red",
      label: "Degraded",
      detail: `${embeddingPct.toFixed(0)}% embedded (${total} total)`,
    };
  }

  // Yellow: embedding 90-99%
  if (embeddingPct < 100) {
    return {
      id,
      name,
      status: "yellow",
      label: "Catching Up",
      detail: `${embeddingPct.toFixed(0)}% embedded (${total} total)`,
    };
  }

  // Green: embedding 100%
  return {
    id,
    name,
    status: "green",
    label: "Complete",
    detail: `100% embedded (${total} total)`,
  };
}

function computeExpression(stats: ServiceStats): Indicator {
  const id = "expression";
  const name = "Expression";

  if (!stats.cortex) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Cortex offline",
    };
  }

  const outbox = stats.cortex.outbox;
  const pending = outbox.pending;
  const dead = outbox.dead_total;

  // Red: dead > 0 (always red) OR pending > 10
  if (dead > 0) {
    return {
      id,
      name,
      status: "red",
      label: "Failed",
      detail: `${dead} dead messages, ${pending} pending`,
    };
  }

  if (pending > 10) {
    return {
      id,
      name,
      status: "red",
      label: "Backlog",
      detail: `${pending} pending, ${outbox.delivered_1h} delivered/1h`,
    };
  }

  // Yellow: pending 3-10
  if (pending >= 3) {
    return {
      id,
      name,
      status: "yellow",
      label: "Queued",
      detail: `${pending} pending, ${outbox.delivered_1h} delivered/1h`,
    };
  }

  // Green: pending <= 2
  return {
    id,
    name,
    status: "green",
    label: "Clear",
    detail: `${pending} pending, ${outbox.delivered_1h} delivered/1h`,
  };
}

function computeModels(stats: ServiceStats): Indicator {
  const id = "models";
  const name = "Models";

  if (!stats.synapse) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "Synapse offline",
    };
  }

  const providers = stats.synapse.providers;
  if (providers.length === 0) {
    return { id, name, status: "green", label: "Idle", detail: "No providers" };
  }

  const healthy = providers.filter((p) => p.healthy).length;
  const total = providers.length;

  // Calculate error rate from requests
  const requests = stats.synapse.requests;
  const errorRate =
    requests.total_1h > 0 ? requests.errors_1h / requests.total_1h : 0;
  const errorPct = (errorRate * 100).toFixed(0);

  // Red: all down
  if (healthy === 0) {
    return {
      id,
      name,
      status: "red",
      label: "Down",
      detail: `0/${total} providers healthy`,
    };
  }

  // Red: error rate > 20%
  if (errorRate > 0.2) {
    return {
      id,
      name,
      status: "red",
      label: "High Errors",
      detail: `${errorPct}% error rate (${requests.errors_1h}/${requests.total_1h})`,
    };
  }

  // Yellow: some unhealthy OR error rate > 5%
  if (healthy < total) {
    return {
      id,
      name,
      status: "yellow",
      label: "Degraded",
      detail: `${healthy}/${total} providers healthy`,
    };
  }

  if (errorRate > 0.05) {
    return {
      id,
      name,
      status: "yellow",
      label: "Degraded",
      detail: `${errorPct}% error rate (${requests.errors_1h}/${requests.total_1h})`,
    };
  }

  // Green: all healthy AND error rate <= 5%
  return {
    id,
    name,
    status: "green",
    label: "Healthy",
    detail: `${healthy}/${total} providers healthy`,
  };
}

function computeSupervision(stats: ServiceStats): Indicator {
  const id = "supervision";
  const name = "Supervision";

  const health = stats.health;
  const serviceNames = ["engram", "synapse", "cortex", "wilson"];
  const up = serviceNames.filter(
    (name) => health[name]?.status === "healthy",
  ).length;
  const total = serviceNames.length;

  // If no stats data at all (everything null), return Idle
  // This handles the case where wilson just started or no services are configured
  if (!stats.engram && !stats.synapse && !stats.cortex && up === 0) {
    return {
      id,
      name,
      status: "green",
      label: "Idle",
      detail: "No data available",
    };
  }

  // Check for any uptime < 60s (recently restarted)
  const recentRestart = serviceNames.some((name) => {
    const svc = health[name];
    return (
      svc && typeof svc.uptime_seconds === "number" && svc.uptime_seconds < 60
    );
  });

  // Red: < 3 up
  if (up < 3) {
    return {
      id,
      name,
      status: "red",
      label: "Critical",
      detail: `${up}/${total} services up`,
    };
  }

  // Yellow: 3/4 up OR any uptime < 60s
  if (up < total || recentRestart) {
    const detail = recentRestart
      ? `${up}/${total} up, recent restart`
      : `${up}/${total} services up`;
    return {
      id,
      name,
      status: "yellow",
      label: "Degraded",
      detail,
    };
  }

  // Green: 4/4 up
  return {
    id,
    name,
    status: "green",
    label: "Healthy",
    detail: `${up}/${total} services up`,
  };
}

// --- Main Export ---

export function computeIndicators(stats: ServiceStats): Indicator[] {
  return [
    computeSensing(stats),
    computeTriage(stats),
    computeReasoning(stats),
    computeMemory(stats),
    computeExpression(stats),
    computeModels(stats),
    computeSupervision(stats),
  ];
}
