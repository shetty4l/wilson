/**
 * Persisted state for CalendarChannel.
 *
 * Survives restarts — no more duplicate POSTs or lost stats.
 */

import { Field, Persisted } from "@shetty4l/core/state";

@Persisted("calendar_channel_state")
export class CalendarChannelState {
  /** When the channel last synced with Apple Calendar. */
  @Field("date") lastSyncAt: Date | null = null;

  /** When the channel last posted data to Cortex. */
  @Field("date") lastPostAt: Date | null = null;

  /** Number of events posted in the last sync. */
  @Field("number") eventsPosted: number = 0;

  /** Current channel health status. */
  @Field("string") status: string = "healthy";

  /** Last error message if status is error/degraded. */
  @Field("string") error: string | null = null;

  /** SHA256 hash of last event snapshot (for diff detection). */
  @Field("string") lastHash: string | null = null;

  /** Date of last extended sync ("YYYY-MM-DD"). */
  @Field("string") lastExtendedSyncDate: string | null = null;
}
