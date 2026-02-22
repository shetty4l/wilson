/**
 * HTTP client for communicating with cortex.
 *
 * All methods return Result<T> — no thrown exceptions.
 * Uses Bearer token authentication.
 */

import { err, ok, type Result } from "@shetty4l/core/result";

// --- Types ---

export interface ReceivePayload {
  channel: string;
  externalId: string;
  data: unknown;
  occurredAt: string;
  mode?: "realtime" | "buffered";
  metadata?: Record<string, unknown>;
}

export interface ReceiveResponse {
  eventId: string;
  status: "queued" | "duplicate_ignored";
}

export interface OutboxMessage {
  id: string;
  channel: string;
  topicKey: string;
  text: string;
  leaseToken: string;
  metadata?: Record<string, unknown>;
}

export interface PollOpts {
  topicKey?: string;
  max?: number;
  leaseSeconds?: number;
}

// --- Client ---

export class CortexClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /** Send an external event to cortex via POST /receive. */
  async receive(payload: ReceivePayload): Promise<Result<ReceiveResponse>> {
    return this.post<ReceiveResponse>("/receive", payload);
  }

  /** Poll the outbox for messages destined for a channel. */
  async pollOutbox(
    channel: string,
    opts?: PollOpts,
  ): Promise<Result<OutboxMessage[]>> {
    const params = new URLSearchParams({ channel });
    if (opts?.topicKey) params.set("topicKey", opts.topicKey);
    if (opts?.max != null) params.set("max", String(opts.max));
    if (opts?.leaseSeconds != null)
      params.set("leaseSeconds", String(opts.leaseSeconds));

    return this.get<OutboxMessage[]>(`/outbox?${params.toString()}`);
  }

  /** Acknowledge (complete) an outbox message delivery. */
  async ackOutbox(
    messageId: string,
    leaseToken: string,
  ): Promise<Result<void>> {
    const result = await this.post<unknown>(`/outbox/${messageId}/ack`, {
      leaseToken,
    });
    if (!result.ok) return result;
    return ok(undefined);
  }

  // --- Internal helpers ---

  private async post<T>(path: string, body: unknown): Promise<Result<T>> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return err(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      const data = (await res.json()) as T;
      return ok(data);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  private async get<T>(path: string): Promise<Result<T>> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return err(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      const data = (await res.json()) as T;
      return ok(data);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}
