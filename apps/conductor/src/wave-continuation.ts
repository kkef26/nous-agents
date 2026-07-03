/**
 * NOUS.CONDUCTOR.MERGE_GATES.4 — wave auto-continuation.
 *
 * When every clause in an active wave reaches `shipped`, conductor
 * fires the next wave of the same feature without human intervention.
 * The wave state machine ratchets forward one step at a time:
 *
 *   in_progress ──all clauses shipped──▶ shipped
 *   shipped     ──fireNextWave OK────▶ continuation_fired
 *   shipped     ──no next wave───────▶ complete
 *   shipped     ──3 retries fail─────▶ stalled (retries_exhausted)
 *   shipped     ──30 min elapsed─────▶ stalled (stall_timeout)
 *
 * Idempotency: checkWaveCompletion is a no-op when the wave is
 * already at continuation_fired | complete | stalled (constraint #4
 * of the clause: never fire without the guard).
 *
 * The module NEVER writes wave/clause state through any surface other
 * than the injected WaveStateClient (constraint #1). It NEVER retries
 * more than MAX_FIRE_NEXT_WAVE_RETRIES against Scoper (constraint #3).
 * It NEVER couples to a notification channel — only pipeline_events
 * records leave through PipelineEventSink (constraint #5).
 */

import type { WaveSnapshot, WaveStatus } from './types.js';
import {
  PIPELINE_EVENT_TYPES,
  type PipelineEventSink,
  type StalledWaveReason,
} from './pipeline-events.js';

/** Maximum retries against the Scoper next-wave endpoint (constraint #3). */
export const MAX_FIRE_NEXT_WAVE_RETRIES = 3;

/** Wall-clock ceiling on a shipped wave that has not advanced (AC5). */
export const STALL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The shared state client — all wave/clause status writes flow through
 * this surface (constraint #1). Callers wire it to their own
 * persistence (SQL, RPC, in-memory) so this module has no dependency
 * on a specific store.
 */
export interface WaveStateClient {
  getWaveSnapshot(featureId: string, waveIndex: number): Promise<WaveSnapshot>;
  markWaveShipped(
    featureId: string,
    waveIndex: number,
    shippedAt: string,
  ): Promise<void>;
  markWaveContinuationFired(
    featureId: string,
    waveIndex: number,
  ): Promise<void>;
  markWaveComplete(featureId: string, waveIndex: number): Promise<void>;
  markWaveStalled(featureId: string, waveIndex: number): Promise<void>;
  /**
   * Return the next wave index, or null when the completed wave is
   * the final wave of the feature.
   */
  getNextWaveIndex(
    featureId: string,
    currentWaveIndex: number,
  ): Promise<number | null>;
}

/** The Scoper next-wave endpoint. Called at most 3 times per wave. */
export interface ScoperNextWaveClient {
  fireNextWave(args: {
    feature_id: string;
    next_wave_index: number;
  }): Promise<void>;
}

export interface CheckWaveCompletionArgs {
  featureId: string;
  waveIndex: number;
}

export interface CheckWaveCompletionDeps {
  stateClient: WaveStateClient;
  scoperClient: ScoperNextWaveClient;
  pipelineEvents: PipelineEventSink;
  nowImpl?: () => Date;
  maxRetries?: number;
  stallTimeoutMs?: number;
}

export type CheckWaveCompletionResult =
  | { status: 'partial'; shippedCount: number; totalCount: number }
  | { status: 'already_fired' }
  | { status: 'continuation_fired'; nextWaveIndex: number }
  | { status: 'pipeline_complete' }
  | { status: 'stalled'; reason: StalledWaveReason };

/** Wave statuses that mean "someone already resolved this wave". */
function isTerminalForContinuation(status: WaveStatus): boolean {
  return (
    status === 'continuation_fired' ||
    status === 'complete' ||
    status === 'stalled'
  );
}

function allClausesShipped(snap: WaveSnapshot): boolean {
  return snap.clauses.length > 0 && snap.clauses.every((c) => c.status === 'shipped');
}

function isoOf(now: () => Date): string {
  return now().toISOString();
}

/**
 * Entry point invoked after any clause is flipped to shipped
 * (constraint AC6). Synchronous end-to-end — the caller awaits the
 * full state machine transition, so a merge.ts flip that returns
 * `{status:'continuation_fired'}` has already emitted the event.
 */
export async function checkWaveCompletion(
  args: CheckWaveCompletionArgs,
  deps: CheckWaveCompletionDeps,
): Promise<CheckWaveCompletionResult> {
  const now = deps.nowImpl ?? (() => new Date());
  const stallTimeout = deps.stallTimeoutMs ?? STALL_TIMEOUT_MS;

  const snap = await deps.stateClient.getWaveSnapshot(
    args.featureId,
    args.waveIndex,
  );

  // Idempotency guard (constraint #4). Terminal statuses are a no-op.
  if (isTerminalForContinuation(snap.status)) {
    return { status: 'already_fired' };
  }

  const shippedCount = snap.clauses.filter((c) => c.status === 'shipped').length;
  const totalCount = snap.clauses.length;
  if (!allClausesShipped(snap)) {
    return { status: 'partial', shippedCount, totalCount };
  }

  // First-time transition to fully shipped — record shipped_at NOW.
  // Constraint #2: the stall timer starts here, not before.
  let shippedAt = snap.shipped_at;
  if (snap.status === 'in_progress' || !shippedAt) {
    shippedAt = isoOf(now);
    await deps.stateClient.markWaveShipped(
      args.featureId,
      args.waveIndex,
      shippedAt,
    );
  }

  // Stall-timer check (AC5). Fires BEFORE any scoper attempt, because a
  // wave that has been shipped for > 30 min without advancing is stuck
  // for a reason (crashed scheduler, exhausted downstream capacity) and
  // hammering the scoper again wastes the retry budget.
  const elapsedMs = now().getTime() - new Date(shippedAt).getTime();
  if (elapsedMs > stallTimeout) {
    await emitStallAlert(
      {
        featureId: args.featureId,
        waveIndex: args.waveIndex,
        attemptCount: 0,
        reason: 'stall_timeout',
      },
      {
        stateClient: deps.stateClient,
        pipelineEvents: deps.pipelineEvents,
        nowImpl: now,
      },
    );
    return { status: 'stalled', reason: 'stall_timeout' };
  }

  // Terminal wave-of-feature branch (AC3). No fireNextWave call — the
  // pipeline is done and we emit pipeline_complete.
  const nextWaveIndex = await deps.stateClient.getNextWaveIndex(
    args.featureId,
    args.waveIndex,
  );
  if (nextWaveIndex === null) {
    await deps.stateClient.markWaveComplete(args.featureId, args.waveIndex);
    await deps.pipelineEvents.record({
      event_type: PIPELINE_EVENT_TYPES.PIPELINE_COMPLETE,
      feature_id: args.featureId,
      emitted_at: isoOf(now),
    });
    return { status: 'pipeline_complete' };
  }

  // Ordinary happy path (AC1) + retry-exhaust path (AC4).
  const fireResult = await fireNextWave(
    {
      featureId: args.featureId,
      completedWaveIndex: args.waveIndex,
      nextWaveIndex,
    },
    {
      scoperClient: deps.scoperClient,
      pipelineEvents: deps.pipelineEvents,
      stateClient: deps.stateClient,
      nowImpl: now,
      maxRetries: deps.maxRetries ?? MAX_FIRE_NEXT_WAVE_RETRIES,
    },
  );

  if (fireResult.status === 'success') {
    return { status: 'continuation_fired', nextWaveIndex };
  }
  return { status: 'stalled', reason: 'retries_exhausted' };
}

export interface FireNextWaveArgs {
  featureId: string;
  completedWaveIndex: number;
  nextWaveIndex: number;
}

export interface FireNextWaveDeps {
  scoperClient: ScoperNextWaveClient;
  pipelineEvents: PipelineEventSink;
  stateClient: WaveStateClient;
  nowImpl?: () => Date;
  maxRetries?: number;
}

export type FireNextWaveResult =
  | { status: 'success' }
  | { status: 'retries_exhausted'; attemptCount: number };

/**
 * Attempt the Scoper next-wave call with capped retries. On success:
 * mark the wave continuation_fired and emit wave_continuation_fired.
 * On the Nth failure (N === maxRetries): mark the wave stalled and
 * emit stalled_wave_continuation with reason 'retries_exhausted'
 * (constraint #3 — never spill past maxRetries).
 */
export async function fireNextWave(
  args: FireNextWaveArgs,
  deps: FireNextWaveDeps,
): Promise<FireNextWaveResult> {
  const now = deps.nowImpl ?? (() => new Date());
  const maxRetries = deps.maxRetries ?? MAX_FIRE_NEXT_WAVE_RETRIES;

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      await deps.scoperClient.fireNextWave({
        feature_id: args.featureId,
        next_wave_index: args.nextWaveIndex,
      });
      await deps.stateClient.markWaveContinuationFired(
        args.featureId,
        args.completedWaveIndex,
      );
      await deps.pipelineEvents.record({
        event_type: PIPELINE_EVENT_TYPES.WAVE_CONTINUATION_FIRED,
        feature_id: args.featureId,
        completed_wave_index: args.completedWaveIndex,
        next_wave_index: args.nextWaveIndex,
        emitted_at: isoOf(now),
      });
      return { status: 'success' };
    } catch {
      // Swallow — the loop retries. The final failure funnels into
      // emitStallAlert below (constraint #3: never a silent drop).
    }
  }

  await emitStallAlert(
    {
      featureId: args.featureId,
      waveIndex: args.completedWaveIndex,
      attemptCount: attempt,
      reason: 'retries_exhausted',
    },
    {
      stateClient: deps.stateClient,
      pipelineEvents: deps.pipelineEvents,
      nowImpl: now,
    },
  );
  return { status: 'retries_exhausted', attemptCount: attempt };
}

export interface EmitStallAlertArgs {
  featureId: string;
  waveIndex: number;
  attemptCount: number;
  reason: StalledWaveReason;
}

export interface EmitStallAlertDeps {
  stateClient: WaveStateClient;
  pipelineEvents: PipelineEventSink;
  nowImpl?: () => Date;
}

/**
 * Persist the stalled wave state and emit a stalled_wave_continuation
 * record. Idempotent — repeated invocations for the same wave produce
 * repeated events but do not corrupt state (the wave is already
 * 'stalled'; markWaveStalled is a no-op-on-terminal write).
 *
 * Downstream routing (Slack, email, dashboard) attaches to
 * pipeline_events; this module has no notification channel knowledge
 * (constraint #5).
 */
export async function emitStallAlert(
  args: EmitStallAlertArgs,
  deps: EmitStallAlertDeps,
): Promise<void> {
  const now = deps.nowImpl ?? (() => new Date());
  await deps.stateClient.markWaveStalled(args.featureId, args.waveIndex);
  await deps.pipelineEvents.record({
    event_type: PIPELINE_EVENT_TYPES.STALLED_WAVE_CONTINUATION,
    feature_id: args.featureId,
    wave_index: args.waveIndex,
    attempt_count: args.attemptCount,
    reason: args.reason,
    failed_at: isoOf(now),
  });
}
