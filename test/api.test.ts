import { describe, expect, test } from "bun:test";
import { computeIndicators, type Indicator } from "../src/api/indicators";
import type { ServiceStats } from "../src/api/stats";

// --- Test Helpers ---

function makeEmptyStats(): ServiceStats {
  return {
    engram: null,
    synapse: null,
    cortex: null,
    health: {},
  };
}

function makeFullStats(overrides?: Partial<ServiceStats>): ServiceStats {
  return {
    engram: {
      memories: { total: 100, with_embedding_pct: 100 },
      operations: {
        recall_1h: 50,
        remember_1h: 10,
        recall_hit_rate_1h: 0.9,
        recall_fallback_rate_1h: 0.1,
      },
      latency: { recall_p50_ms: 100, recall_p95_ms: 200, recall_p99_ms: 300 },
    },
    synapse: {
      buffer: { capacity: 100, size: 10, oldest_entry_at: null },
      requests: { total_1h: 100, errors_1h: 0, by_provider: {} },
      latency: { p50_ms: 500, p95_ms: 1000, p99_ms: 2000 },
      fallbacks: { count_1h: 0 },
      providers: [
        { name: "openai", healthy: true, consecutiveFailures: 0 },
        { name: "anthropic", healthy: true, consecutiveFailures: 0 },
      ],
    },
    cortex: {
      inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 0 },
      outbox: { pending: 0, delivered_1h: 5, dead_total: 0 },
      receptors: {
        calendar_last_sync_at: new Date().toISOString(),
        calendar_buffer_pending: 0,
        thalamus_last_run_at: new Date().toISOString(),
      },
      processing: { p50_ms: 2000, p95_ms: 5000, p99_ms: 10000 },
    },
    health: {
      engram: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
      synapse: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
      cortex: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
      wilson: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
    },
    ...overrides,
  };
}

function getIndicator(indicators: Indicator[], id: string): Indicator {
  const indicator = indicators.find((i) => i.id === id);
  if (!indicator) throw new Error(`Indicator ${id} not found`);
  return indicator;
}

// --- Tests ---

describe("computeIndicators", () => {
  describe("all services null (offline)", () => {
    test("returns all indicators as green/Idle when no data available", () => {
      const stats = makeEmptyStats();
      const indicators = computeIndicators(stats);

      expect(indicators.length).toBe(7);

      // All indicators including supervision should be Idle when no data at all
      for (const ind of indicators) {
        expect(ind.status).toBe("green");
        expect(ind.label).toBe("Idle");
      }
    });
  });

  describe("sensing indicator", () => {
    test("green when sync < 1h and buffer < 10", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("green");
      expect(sensing.label).toBe("Active");
    });

    test("yellow when sync 1-6h ago", () => {
      const twoHoursAgo = new Date(
        Date.now() - 2 * 60 * 60 * 1000,
      ).toISOString();
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          receptors: {
            calendar_last_sync_at: twoHoursAgo,
            calendar_buffer_pending: 5,
            thalamus_last_run_at: twoHoursAgo,
          },
        },
      });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("yellow");
      expect(sensing.label).toBe("Delayed");
    });

    test("yellow when buffer 10-50", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          receptors: {
            calendar_last_sync_at: new Date().toISOString(),
            calendar_buffer_pending: 25,
            thalamus_last_run_at: new Date().toISOString(),
          },
        },
      });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("yellow");
    });

    test("red when sync > 6h ago", () => {
      const sevenHoursAgo = new Date(
        Date.now() - 7 * 60 * 60 * 1000,
      ).toISOString();
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          receptors: {
            calendar_last_sync_at: sevenHoursAgo,
            calendar_buffer_pending: 0,
            thalamus_last_run_at: sevenHoursAgo,
          },
        },
      });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("red");
      expect(sensing.label).toBe("Stale");
    });

    test("red when buffer > 50", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          receptors: {
            calendar_last_sync_at: new Date().toISOString(),
            calendar_buffer_pending: 100,
            thalamus_last_run_at: new Date().toISOString(),
          },
        },
      });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("red");
    });

    test("green/Idle when cortex is null", () => {
      const stats = makeFullStats({ cortex: null });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("green");
      expect(sensing.label).toBe("Idle");
    });
  });

  describe("triage indicator", () => {
    test("green when pending <= 2 and failed 0", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("green");
      expect(triage.label).toBe("Clear");
    });

    test("yellow when pending 3-10", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 5, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("yellow");
      expect(triage.label).toBe("Busy");
    });

    test("yellow when failed 1-3", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 2 },
        },
      });
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("yellow");
    });

    test("red when pending > 10", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 15, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("red");
      expect(triage.label).toBe("Backlog");
    });

    test("red when failed > 3", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 5 },
        },
      });
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("red");
    });

    test("red when processing > 1", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 0, processing: 3, done_1h: 10, failed_1h: 0 },
        },
      });
      const indicators = computeIndicators(stats);
      const triage = getIndicator(indicators, "triage");

      expect(triage.status).toBe("red");
    });
  });

  describe("reasoning indicator", () => {
    test("green when p50 < 5s and errors 0", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("green");
      expect(reasoning.label).toBe("Fast");
    });

    test("yellow when p50 5-15s", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          processing: { p50_ms: 8000, p95_ms: 15000, p99_ms: 20000 },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("yellow");
      expect(reasoning.label).toBe("Lagging");
    });

    test("yellow when errors 1-5", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 3 },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("yellow");
    });

    test("red when p50 > 15s", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          processing: { p50_ms: 20000, p95_ms: 30000, p99_ms: 40000 },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("red");
      expect(reasoning.label).toBe("Slow");
    });

    test("red when errors > 5", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 10 },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("red");
    });

    test("red when synapse error rate > 20%", () => {
      // Fast cortex processing but synapse has high error rate
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          processing: { p50_ms: 2000, p95_ms: 5000, p99_ms: 10000 },
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 0 },
        },
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 25, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("red");
      expect(reasoning.detail).toContain("LLM errors");
    });

    test("yellow when synapse error rate 5-20%", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          processing: { p50_ms: 2000, p95_ms: 5000, p99_ms: 10000 },
          inbox: { pending: 0, processing: 0, done_1h: 10, failed_1h: 0 },
        },
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 10, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.status).toBe("yellow");
      expect(reasoning.detail).toContain("LLM errors");
    });

    test("detail includes synapse latency for context", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          latency: { p50_ms: 5000, p95_ms: 10000, p99_ms: 15000 },
        },
      });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      expect(reasoning.detail).toContain("synapse");
      expect(reasoning.detail).toContain("5.0s");
    });

    test("handles null synapse gracefully", () => {
      const stats = makeFullStats({ synapse: null });
      const indicators = computeIndicators(stats);
      const reasoning = getIndicator(indicators, "reasoning");

      // Should still work based on cortex data alone
      expect(reasoning.status).toBe("green");
      expect(reasoning.detail).not.toContain("synapse");
    });
  });

  describe("memory indicator", () => {
    test("green when embedding 100%", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const memory = getIndicator(indicators, "memory");

      expect(memory.status).toBe("green");
      expect(memory.label).toBe("Complete");
    });

    test("yellow when embedding 90-99%", () => {
      const stats = makeFullStats({
        engram: {
          ...makeFullStats().engram!,
          memories: { total: 100, with_embedding_pct: 95 },
        },
      });
      const indicators = computeIndicators(stats);
      const memory = getIndicator(indicators, "memory");

      expect(memory.status).toBe("yellow");
      expect(memory.label).toBe("Catching Up");
    });

    test("red when embedding < 90%", () => {
      const stats = makeFullStats({
        engram: {
          ...makeFullStats().engram!,
          memories: { total: 100, with_embedding_pct: 80 },
        },
      });
      const indicators = computeIndicators(stats);
      const memory = getIndicator(indicators, "memory");

      expect(memory.status).toBe("red");
      expect(memory.label).toBe("Degraded");
    });

    test("green/Idle when engram is null", () => {
      const stats = makeFullStats({ engram: null });
      const indicators = computeIndicators(stats);
      const memory = getIndicator(indicators, "memory");

      expect(memory.status).toBe("green");
      expect(memory.label).toBe("Idle");
    });
  });

  describe("expression indicator", () => {
    test("green when pending <= 2", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const expression = getIndicator(indicators, "expression");

      expect(expression.status).toBe("green");
      expect(expression.label).toBe("Clear");
    });

    test("yellow when pending 3-10", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          outbox: { pending: 5, delivered_1h: 10, dead_total: 0 },
        },
      });
      const indicators = computeIndicators(stats);
      const expression = getIndicator(indicators, "expression");

      expect(expression.status).toBe("yellow");
      expect(expression.label).toBe("Queued");
    });

    test("red when pending > 10", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          outbox: { pending: 15, delivered_1h: 10, dead_total: 0 },
        },
      });
      const indicators = computeIndicators(stats);
      const expression = getIndicator(indicators, "expression");

      expect(expression.status).toBe("red");
      expect(expression.label).toBe("Backlog");
    });

    test("red when dead > 0 (always red)", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          outbox: { pending: 0, delivered_1h: 10, dead_total: 1 },
        },
      });
      const indicators = computeIndicators(stats);
      const expression = getIndicator(indicators, "expression");

      expect(expression.status).toBe("red");
      expect(expression.label).toBe("Failed");
    });
  });

  describe("models indicator", () => {
    test("green when all providers healthy", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("green");
      expect(models.label).toBe("Healthy");
    });

    test("yellow when some providers unhealthy", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          providers: [
            { name: "openai", healthy: true, consecutiveFailures: 0 },
            { name: "anthropic", healthy: false, consecutiveFailures: 3 },
          ],
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("yellow");
      expect(models.label).toBe("Degraded");
    });

    test("red when all providers down", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          providers: [
            { name: "openai", healthy: false, consecutiveFailures: 5 },
            { name: "anthropic", healthy: false, consecutiveFailures: 5 },
          ],
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("red");
      expect(models.label).toBe("Down");
    });

    test("green/Idle when synapse is null", () => {
      const stats = makeFullStats({ synapse: null });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("green");
      expect(models.label).toBe("Idle");
    });

    test("green/Idle when no providers", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          providers: [],
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("green");
      expect(models.label).toBe("Idle");
    });

    test("red when error rate > 20%", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 25, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("red");
      expect(models.label).toBe("High Errors");
      expect(models.detail).toContain("25%");
    });

    test("yellow when error rate 5-20%", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 10, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("yellow");
      expect(models.label).toBe("Degraded");
      expect(models.detail).toContain("10%");
    });

    test("green when error rate < 5%", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 3, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("green");
      expect(models.label).toBe("Healthy");
    });

    test("handles zero total requests (no division by zero)", () => {
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 0, errors_1h: 0, by_provider: {} },
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("green");
      expect(models.label).toBe("Healthy");
    });

    test("error rate takes precedence over healthy providers", () => {
      // All providers healthy but 30% error rate → should be red
      const stats = makeFullStats({
        synapse: {
          ...makeFullStats().synapse!,
          requests: { total_1h: 100, errors_1h: 30, by_provider: {} },
          providers: [
            { name: "openai", healthy: true, consecutiveFailures: 0 },
            { name: "anthropic", healthy: true, consecutiveFailures: 0 },
          ],
        },
      });
      const indicators = computeIndicators(stats);
      const models = getIndicator(indicators, "models");

      expect(models.status).toBe("red");
      expect(models.label).toBe("High Errors");
    });
  });

  describe("supervision indicator", () => {
    test("green when 4/4 services up", () => {
      const stats = makeFullStats();
      const indicators = computeIndicators(stats);
      const supervision = getIndicator(indicators, "supervision");

      expect(supervision.status).toBe("green");
      expect(supervision.label).toBe("Healthy");
    });

    test("yellow when 3/4 services up", () => {
      const stats = makeFullStats({
        health: {
          engram: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
          synapse: {
            status: "healthy",
            version: "0.2.0",
            uptime_seconds: 3600,
          },
          cortex: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
          // wilson missing
        },
      });
      const indicators = computeIndicators(stats);
      const supervision = getIndicator(indicators, "supervision");

      expect(supervision.status).toBe("yellow");
      expect(supervision.label).toBe("Degraded");
    });

    test("yellow when any uptime < 60s", () => {
      const stats = makeFullStats({
        health: {
          engram: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
          synapse: {
            status: "healthy",
            version: "0.2.0",
            uptime_seconds: 3600,
          },
          cortex: { status: "healthy", version: "0.2.0", uptime_seconds: 30 }, // Recent restart
          wilson: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
        },
      });
      const indicators = computeIndicators(stats);
      const supervision = getIndicator(indicators, "supervision");

      expect(supervision.status).toBe("yellow");
      expect(supervision.detail).toContain("recent restart");
    });

    test("red when < 3 services up", () => {
      const stats = makeFullStats({
        health: {
          engram: { status: "healthy", version: "0.2.0", uptime_seconds: 3600 },
          synapse: {
            status: "healthy",
            version: "0.2.0",
            uptime_seconds: 3600,
          },
          // cortex and wilson missing
        },
      });
      const indicators = computeIndicators(stats);
      const supervision = getIndicator(indicators, "supervision");

      expect(supervision.status).toBe("red");
      expect(supervision.label).toBe("Critical");
    });

    test("red when no services up", () => {
      const stats = makeFullStats({ health: {} });
      const indicators = computeIndicators(stats);
      const supervision = getIndicator(indicators, "supervision");

      expect(supervision.status).toBe("red");
      expect(supervision.detail).toBe("0/4 services up");
    });
  });

  describe("edge cases", () => {
    test("handles exactly at threshold boundaries", () => {
      // pending exactly 2 (green), pending exactly 3 (yellow), pending exactly 10 (yellow), pending exactly 11 (red)
      const stats2 = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 2, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      expect(getIndicator(computeIndicators(stats2), "triage").status).toBe(
        "green",
      );

      const stats3 = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 3, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      expect(getIndicator(computeIndicators(stats3), "triage").status).toBe(
        "yellow",
      );

      const stats10 = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 10, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      expect(getIndicator(computeIndicators(stats10), "triage").status).toBe(
        "yellow",
      );

      const stats11 = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          inbox: { pending: 11, processing: 0, done_1h: 10, failed_1h: 0 },
        },
      });
      expect(getIndicator(computeIndicators(stats11), "triage").status).toBe(
        "red",
      );
    });

    test("handles embedding exactly at 90% (yellow) and 89% (red)", () => {
      const stats90 = makeFullStats({
        engram: {
          ...makeFullStats().engram!,
          memories: { total: 100, with_embedding_pct: 90 },
        },
      });
      expect(getIndicator(computeIndicators(stats90), "memory").status).toBe(
        "yellow",
      );

      const stats89 = makeFullStats({
        engram: {
          ...makeFullStats().engram!,
          memories: { total: 100, with_embedding_pct: 89 },
        },
      });
      expect(getIndicator(computeIndicators(stats89), "memory").status).toBe(
        "red",
      );
    });

    test("handles null calendar_last_sync_at", () => {
      const stats = makeFullStats({
        cortex: {
          ...makeFullStats().cortex!,
          receptors: {
            calendar_last_sync_at: null,
            calendar_buffer_pending: 0,
            thalamus_last_run_at: null,
          },
        },
      });
      const indicators = computeIndicators(stats);
      const sensing = getIndicator(indicators, "sensing");

      expect(sensing.status).toBe("red");
      expect(sensing.detail).toContain("never");
    });

    test("partial failure: only engram up", () => {
      const stats: ServiceStats = {
        engram: {
          memories: { total: 50, with_embedding_pct: 100 },
          operations: {
            recall_1h: 10,
            remember_1h: 5,
            recall_hit_rate_1h: 0.8,
            recall_fallback_rate_1h: 0.2,
          },
          latency: {
            recall_p50_ms: 50,
            recall_p95_ms: 100,
            recall_p99_ms: 150,
          },
        },
        synapse: null,
        cortex: null,
        health: {
          engram: { status: "healthy", version: "0.2.0" },
        },
      };
      const indicators = computeIndicators(stats);

      // memory should be green (engram up with 100% embedding)
      expect(getIndicator(indicators, "memory").status).toBe("green");
      expect(getIndicator(indicators, "memory").label).toBe("Complete");

      // cortex-dependent indicators should be Idle
      expect(getIndicator(indicators, "sensing").label).toBe("Idle");
      expect(getIndicator(indicators, "triage").label).toBe("Idle");
      expect(getIndicator(indicators, "reasoning").label).toBe("Idle");
      expect(getIndicator(indicators, "expression").label).toBe("Idle");

      // synapse-dependent indicator should be Idle
      expect(getIndicator(indicators, "models").label).toBe("Idle");

      // supervision should reflect partial health
      expect(getIndicator(indicators, "supervision").status).toBe("red");
    });
  });
});
