/**
 * NOUS.CONDUCTOR.MERGE_GATES.4 — pipeline_events record shapes.
 *
 * Wave auto-continuation emits three distinct event types onto the
 * pipeline_events surface. Each type has a fixed record shape so
 * downstream consumers (dashboard, alerting, orchestrator) can
 * pattern-match on event_type without decoding a free-form payload.
 *
 * Constraint #5 of the clause forbids coupling this module to a
 * specific notification delivery channel. The only exit path from
 * this module is PipelineEventSink.record — any consumer that wants
 * to route these events to Slack, email, or a chart just implements
 * the sink.
 */

export const PIPELINE_EVENT_TYPES = {
  WAVE_CONTINUATION_FIRED: 'wave_continuation_fired',
  STALLED_WAVE_CONTINUATION: 'stalled_wave_continuation',
  PIPELINE_COMPLETE: 'pipeline_complete',
} as const;

export type PipelineEventType =
  typeof PIPELINE_EVENT_TYPES[keyof typeof PIPELINE_EVENT_TYPES];

export interface WaveContinuationFiredRecord {
  event_type: 'wave_continuation_fired';
  feature_id: string;
  completed_wave_index: number;
  next_wave_index: number;
  emitted_at: string;
}

/**
 * Both stall reasons collapse to this single record shape. The reason
 * field distinguishes retry-exhausted (all three attempts failed
 * synchronously) from stall-timeout (30 minutes elapsed without a
 * successful continuation).
 */
export type StalledWaveReason = 'retries_exhausted' | 'stall_timeout';

export interface StalledWaveContinuationRecord {
  event_type: 'stalled_wave_continuation';
  feature_id: string;
  wave_index: number;
  attempt_count: number;
  reason: StalledWaveReason;
  failed_at: string;
}

export interface PipelineCompleteRecord {
  event_type: 'pipeline_complete';
  feature_id: string;
  emitted_at: string;
}

export type PipelineEventRecord =
  | WaveContinuationFiredRecord
  | StalledWaveContinuationRecord
  | PipelineCompleteRecord;

/**
 * A pipeline_events consumer. Callers pass this sink into
 * wave-continuation to persist records (typically into a
 * pipeline_events row). No delivery channel is coupled at this
 * layer (constraint #5).
 */
export interface PipelineEventSink {
  record(event: PipelineEventRecord): Promise<void>;
}
