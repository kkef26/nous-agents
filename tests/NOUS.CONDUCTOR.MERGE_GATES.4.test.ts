// NOUS.CONDUCTOR.MERGE_GATES.4 — wave auto-continuation unit tests.
//
// Covers the 5 constraints in the clause body:
//   C1 Wave/clause status writes go through the shared state client only.
//   C2 Stall-alert timer does NOT start before the wave is fully shipped.
//   C3 Never exceed 3 retry attempts; the 3rd failure enqueues stall.
//   C4 fireNextWave never called without the idempotency guard on
//      wave status 'continuation_fired' | 'complete' | 'stalled'.
//   C5 Module is not coupled to any notification delivery channel; only
//      pipeline_events records are emitted.
//
// And the 7 acceptance criteria:
//   AC1 All clauses shipped → checkWaveCompletion → fireNextWave called
//       exactly once → wave_continuation_fired record with feature_id,
//       completed_wave_index, next_wave_index.
//   AC2 Idempotent: 2nd checkWaveCompletion on an already-continued wave
//       does NOT call fireNextWave again and emits no duplicate event.
//   AC3 Last wave of feature (no next wave) → pipeline_complete event
//       and fireNextWave never called.
//   AC4 fireNextWave fails 3 retries → emitStallAlert →
//       stalled_wave_continuation event with attempt_count: 3 and a
//       non-null failed_at timestamp.
//   AC5 30-minute stall (time-injected) → stalled_wave_continuation
//       event; timer does NOT start until last clause flips shipped.
//   AC6 merge.ts flipClauseToShipped calls checkWaveCompletion
//       synchronously — call-ordering verified through mock state client.
//   AC7 WaveStatus union includes literal 'continuation_fired'; tsc
//       --noEmit accepts an exhaustive switch over all variants.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkWaveCompletion,
  fireNextWave,
  emitStallAlert,
  STALL_TIMEOUT_MS,
  MAX_FIRE_NEXT_WAVE_RETRIES,
  type WaveStateClient,
  type ScoperNextWaveClient,
  type CheckWaveCompletionDeps,
} from '../apps/conductor/src/wave-continuation.js';
import {
  PIPELINE_EVENT_TYPES,
  type PipelineEventSink,
  type PipelineEventRecord,
  type WaveContinuationFiredRecord,
  type StalledWaveContinuationRecord,
  type PipelineCompleteRecord,
} from '../apps/conductor/src/pipeline-events.js';
import type { WaveStatus, WaveSnapshot } from '../apps/conductor/src/types.js';
import {
  flipClauseToShipped,
  type FlipClauseToShippedDeps,
  type ClauseStateClient,
} from '../apps/conductor/src/merge.js';

// -----------------------------------------------------------------------------
// fakes

interface StateCall {
  op:
    | 'getWaveSnapshot'
    | 'markWaveShipped'
    | 'markWaveContinuationFired'
    | 'markWaveComplete'
    | 'markWaveStalled'
    | 'getNextWaveIndex'
    | 'markClauseShipped';
  args: Record<string, unknown>;
}

interface FakeStateStore {
  waves: Map<string, WaveSnapshot>;
  nextWaveMap: Map<string, number | null>;
  clauseFlips: string[];
  calls: StateCall[];
}

function waveKey(featureId: string, waveIndex: number): string {
  return `${featureId}::${waveIndex}`;
}

function makeFakeStateClient(
  store: FakeStateStore,
): WaveStateClient & ClauseStateClient {
  return {
    async getWaveSnapshot(featureId, waveIndex) {
      store.calls.push({ op: 'getWaveSnapshot', args: { featureId, waveIndex } });
      const snap = store.waves.get(waveKey(featureId, waveIndex));
      if (!snap) throw new Error(`no wave ${featureId}/${waveIndex}`);
      return { ...snap, clauses: snap.clauses.map((c) => ({ ...c })) };
    },
    async markWaveShipped(featureId, waveIndex, shippedAt) {
      store.calls.push({
        op: 'markWaveShipped',
        args: { featureId, waveIndex, shippedAt },
      });
      const snap = store.waves.get(waveKey(featureId, waveIndex));
      if (!snap) throw new Error(`no wave ${featureId}/${waveIndex}`);
      snap.status = 'shipped';
      snap.shipped_at = shippedAt;
    },
    async markWaveContinuationFired(featureId, waveIndex) {
      store.calls.push({
        op: 'markWaveContinuationFired',
        args: { featureId, waveIndex },
      });
      const snap = store.waves.get(waveKey(featureId, waveIndex));
      if (!snap) throw new Error(`no wave ${featureId}/${waveIndex}`);
      snap.status = 'continuation_fired';
    },
    async markWaveComplete(featureId, waveIndex) {
      store.calls.push({ op: 'markWaveComplete', args: { featureId, waveIndex } });
      const snap = store.waves.get(waveKey(featureId, waveIndex));
      if (!snap) throw new Error(`no wave ${featureId}/${waveIndex}`);
      snap.status = 'complete';
    },
    async markWaveStalled(featureId, waveIndex) {
      store.calls.push({ op: 'markWaveStalled', args: { featureId, waveIndex } });
      const snap = store.waves.get(waveKey(featureId, waveIndex));
      if (!snap) throw new Error(`no wave ${featureId}/${waveIndex}`);
      snap.status = 'stalled';
    },
    async getNextWaveIndex(featureId, currentWaveIndex) {
      store.calls.push({
        op: 'getNextWaveIndex',
        args: { featureId, currentWaveIndex },
      });
      const key = waveKey(featureId, currentWaveIndex);
      return store.nextWaveMap.has(key)
        ? store.nextWaveMap.get(key)!
        : currentWaveIndex + 1;
    },
    async markClauseShipped(clauseId) {
      store.calls.push({ op: 'markClauseShipped', args: { clauseId } });
      store.clauseFlips.push(clauseId);
    },
  };
}

interface FakeScoperState {
  scoper: ScoperNextWaveClient;
  calls: Array<{ feature_id: string; next_wave_index: number }>;
  failCount: number;
  behaviour: 'always_ok' | 'always_fail' | 'fail_then_ok';
}

function makeFakeScoper(
  behaviour: 'always_ok' | 'always_fail' | 'fail_then_ok',
): FakeScoperState {
  const state: FakeScoperState = {
    scoper: {} as ScoperNextWaveClient,
    calls: [],
    failCount: 0,
    behaviour,
  };
  state.scoper = {
    async fireNextWave({ feature_id, next_wave_index }) {
      state.calls.push({ feature_id, next_wave_index });
      if (behaviour === 'always_ok') return;
      if (behaviour === 'always_fail') {
        state.failCount++;
        throw new Error(`scoper unreachable (attempt ${state.failCount})`);
      }
      // fail_then_ok: fail twice, succeed on 3rd
      state.failCount++;
      if (state.failCount < 3) {
        throw new Error(`scoper transient (attempt ${state.failCount})`);
      }
    },
  };
  return state;
}

interface FakeEventSinkState {
  sink: PipelineEventSink;
  records: PipelineEventRecord[];
}

function makeFakeEventSink(): FakeEventSinkState {
  const state: FakeEventSinkState = {
    sink: {} as PipelineEventSink,
    records: [],
  };
  state.sink = {
    async record(event) {
      state.records.push(event);
    },
  };
  return state;
}

function seedWave(
  store: FakeStateStore,
  overrides: Partial<WaveSnapshot> & { feature_id: string; wave_index: number },
) {
  const snap: WaveSnapshot = {
    feature_id: overrides.feature_id,
    wave_index: overrides.wave_index,
    status: overrides.status ?? 'in_progress',
    clauses: overrides.clauses ?? [
      { clause_id: 'C1', status: 'shipped' },
      { clause_id: 'C2', status: 'shipped' },
    ],
    ...(overrides.shipped_at !== undefined ? { shipped_at: overrides.shipped_at } : {}),
  };
  store.waves.set(waveKey(snap.feature_id, snap.wave_index), snap);
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

// -----------------------------------------------------------------------------
// AC01

describe('AC01 all clauses shipped → checkWaveCompletion fires next wave once', () => {
  it('emits a wave_continuation_fired record with the expected wire fields', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F1',
      wave_index: 0,
      status: 'in_progress',
      clauses: [
        { clause_id: 'C1', status: 'shipped' },
        { clause_id: 'C2', status: 'shipped' },
        { clause_id: 'C3', status: 'shipped' },
      ],
    });
    store.nextWaveMap.set(waveKey('F1', 0), 1);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const result = await checkWaveCompletion(
      { featureId: 'F1', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 'continuation_fired');
    assert.equal(scoper.calls.length, 1);
    assert.deepEqual(scoper.calls[0], { feature_id: 'F1', next_wave_index: 1 });
    const fired = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.WAVE_CONTINUATION_FIRED,
    ) as WaveContinuationFiredRecord[];
    assert.equal(fired.length, 1);
    assert.equal(fired[0].feature_id, 'F1');
    assert.equal(fired[0].completed_wave_index, 0);
    assert.equal(fired[0].next_wave_index, 1);
    assert.ok(typeof fired[0].emitted_at === 'string' && fired[0].emitted_at.length > 0);
  });

  it('records the shipped_at timestamp before invoking fireNextWave', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, { feature_id: 'F1', wave_index: 0, status: 'in_progress' });
    store.nextWaveMap.set(waveKey('F1', 0), 1);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    await checkWaveCompletion(
      { featureId: 'F1', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
      },
    );

    const opOrder = store.calls.map((c) => c.op);
    const shippedIdx = opOrder.indexOf('markWaveShipped');
    const firedIdx = opOrder.indexOf('markWaveContinuationFired');
    assert.ok(shippedIdx >= 0, 'markWaveShipped must be called');
    assert.ok(firedIdx > shippedIdx, 'markWaveContinuationFired must follow');
  });
});

// -----------------------------------------------------------------------------
// AC02

describe('AC02 idempotency guard on already-continued wave', () => {
  it('does not call fireNextWave twice or emit a duplicate event', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F1',
      wave_index: 0,
      status: 'continuation_fired',
      shipped_at: '2026-07-03T12:00:00.000Z',
    });
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const result = await checkWaveCompletion(
      { featureId: 'F1', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:05:00.000Z'),
      },
    );

    assert.equal(result.status, 'already_fired');
    assert.equal(scoper.calls.length, 0, 'fireNextWave must NOT be re-invoked');
    const dupes = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.WAVE_CONTINUATION_FIRED,
    );
    assert.equal(dupes.length, 0, 'no duplicate wave_continuation_fired record');
  });

  it('also guards against complete and stalled wave statuses', async () => {
    for (const status of ['complete', 'stalled'] as const) {
      const store: FakeStateStore = {
        waves: new Map(),
        nextWaveMap: new Map(),
        clauseFlips: [],
        calls: [],
      };
      seedWave(store, {
        feature_id: 'F1',
        wave_index: 0,
        status,
        shipped_at: '2026-07-03T12:00:00.000Z',
      });
      const stateClient = makeFakeStateClient(store);
      const scoper = makeFakeScoper('always_ok');
      const events = makeFakeEventSink();

      const result = await checkWaveCompletion(
        { featureId: 'F1', waveIndex: 0 },
        {
          stateClient,
          scoperClient: scoper.scoper,
          pipelineEvents: events.sink,
          nowImpl: fixedNow('2026-07-03T12:05:00.000Z'),
        },
      );

      assert.equal(result.status, 'already_fired');
      assert.equal(scoper.calls.length, 0);
    }
  });
});

// -----------------------------------------------------------------------------
// AC03

describe('AC03 final wave → pipeline_complete without fireNextWave', () => {
  it('emits pipeline_complete when getNextWaveIndex returns null', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, { feature_id: 'F9', wave_index: 5, status: 'in_progress' });
    store.nextWaveMap.set(waveKey('F9', 5), null);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const result = await checkWaveCompletion(
      { featureId: 'F9', waveIndex: 5 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 'pipeline_complete');
    assert.equal(scoper.calls.length, 0, 'fireNextWave never invoked on final wave');
    const complete = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.PIPELINE_COMPLETE,
    ) as PipelineCompleteRecord[];
    assert.equal(complete.length, 1);
    assert.equal(complete[0].feature_id, 'F9');
    // The wave is marked complete, not continuation_fired.
    const opOrder = store.calls.map((c) => c.op);
    assert.ok(opOrder.includes('markWaveComplete'));
    assert.ok(!opOrder.includes('markWaveContinuationFired'));
  });
});

// -----------------------------------------------------------------------------
// AC04

describe('AC04 fireNextWave fails 3 retries → stall alert', () => {
  it('emits stalled_wave_continuation with attempt_count 3 and failed_at set', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, { feature_id: 'F2', wave_index: 0, status: 'in_progress' });
    store.nextWaveMap.set(waveKey('F2', 0), 1);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_fail');
    const events = makeFakeEventSink();

    const result = await checkWaveCompletion(
      { featureId: 'F2', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 'stalled');
    assert.equal(
      scoper.calls.length,
      MAX_FIRE_NEXT_WAVE_RETRIES,
      'exactly 3 attempts against scoper',
    );
    const stalls = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.STALLED_WAVE_CONTINUATION,
    ) as StalledWaveContinuationRecord[];
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].feature_id, 'F2');
    assert.equal(stalls[0].wave_index, 0);
    assert.equal(stalls[0].attempt_count, 3);
    assert.equal(stalls[0].reason, 'retries_exhausted');
    assert.ok(
      stalls[0].failed_at && typeof stalls[0].failed_at === 'string',
      'failed_at must be non-null',
    );
    // Wave state moves to 'stalled', never 'continuation_fired'.
    const opOrder = store.calls.map((c) => c.op);
    assert.ok(opOrder.includes('markWaveStalled'));
    assert.ok(!opOrder.includes('markWaveContinuationFired'));
  });

  it('fireNextWave standalone: 3-fail path returns retries_exhausted', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, { feature_id: 'F3', wave_index: 2, status: 'shipped', shipped_at: '2026-07-03T12:00:00.000Z' });
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_fail');
    const events = makeFakeEventSink();

    const result = await fireNextWave(
      { featureId: 'F3', completedWaveIndex: 2, nextWaveIndex: 3 },
      {
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        stateClient,
        nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
      },
    );

    assert.equal(result.status, 'retries_exhausted');
    assert.equal(scoper.calls.length, 3);
  });
});

// -----------------------------------------------------------------------------
// AC05

describe('AC05 30-minute stall timer', () => {
  it('emits stall event when now - shipped_at > 30m and wave not continued', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F5',
      wave_index: 0,
      status: 'shipped', // wave already fully shipped in a prior call
      shipped_at: '2026-07-03T12:00:00.000Z',
    });
    store.nextWaveMap.set(waveKey('F5', 0), 1);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok'); // scoper is fine — the point is timer
    const events = makeFakeEventSink();

    const past30 = '2026-07-03T12:31:00.000Z'; // +31 minutes

    const result = await checkWaveCompletion(
      { featureId: 'F5', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow(past30),
      },
    );

    assert.equal(result.status, 'stalled');
    const stalls = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.STALLED_WAVE_CONTINUATION,
    ) as StalledWaveContinuationRecord[];
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].reason, 'stall_timeout');
    assert.equal(stalls[0].feature_id, 'F5');
    assert.equal(stalls[0].wave_index, 0);
    // Timer expired path never touches the scoper.
    assert.equal(scoper.calls.length, 0);
  });

  it('does NOT start the timer until the last clause flips to shipped', async () => {
    // Wave still in_progress — one clause not yet shipped. Even if
    // simulated wall-clock is far in the future, no stall event fires.
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F5b',
      wave_index: 0,
      status: 'in_progress',
      clauses: [
        { clause_id: 'C1', status: 'shipped' },
        { clause_id: 'C2', status: 'in_progress' }, // still working
      ],
    });
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const past1h = '2026-07-03T13:00:00.000Z';
    const result = await checkWaveCompletion(
      { featureId: 'F5b', waveIndex: 0 },
      {
        stateClient,
        scoperClient: scoper.scoper,
        pipelineEvents: events.sink,
        nowImpl: fixedNow(past1h),
      },
    );

    assert.equal(result.status, 'partial');
    const stalls = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.STALLED_WAVE_CONTINUATION,
    );
    assert.equal(stalls.length, 0, 'no stall event when wave not fully shipped');
    const opOrder = store.calls.map((c) => c.op);
    assert.ok(!opOrder.includes('markWaveShipped'));
    assert.ok(!opOrder.includes('markWaveStalled'));
  });

  it('exposes STALL_TIMEOUT_MS = 30 minutes', () => {
    assert.equal(STALL_TIMEOUT_MS, 30 * 60 * 1000);
  });

  it('emitStallAlert standalone emits a well-formed record', async () => {
    const events = makeFakeEventSink();
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F6',
      wave_index: 4,
      status: 'shipped',
      shipped_at: '2026-07-03T12:00:00.000Z',
    });
    const stateClient = makeFakeStateClient(store);
    await emitStallAlert(
      {
        featureId: 'F6',
        waveIndex: 4,
        attemptCount: 3,
        reason: 'retries_exhausted',
      },
      {
        stateClient,
        pipelineEvents: events.sink,
        nowImpl: fixedNow('2026-07-03T12:45:00.000Z'),
      },
    );
    const stalls = events.records.filter(
      (r) => r.event_type === PIPELINE_EVENT_TYPES.STALLED_WAVE_CONTINUATION,
    ) as StalledWaveContinuationRecord[];
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].feature_id, 'F6');
    assert.equal(stalls[0].wave_index, 4);
    assert.equal(stalls[0].attempt_count, 3);
    assert.equal(stalls[0].reason, 'retries_exhausted');
    assert.equal(stalls[0].failed_at, '2026-07-03T12:45:00.000Z');
  });
});

// -----------------------------------------------------------------------------
// AC06

describe('AC06 merge.ts flipClauseToShipped calls checkWaveCompletion sync', () => {
  it('markClauseShipped precedes the getWaveSnapshot triggered by checkWaveCompletion', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'F6',
      wave_index: 0,
      status: 'in_progress',
      clauses: [{ clause_id: 'C1', status: 'shipped' }],
    });
    store.nextWaveMap.set(waveKey('F6', 0), 1);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const waveDeps: CheckWaveCompletionDeps = {
      stateClient,
      scoperClient: scoper.scoper,
      pipelineEvents: events.sink,
      nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
    };
    const deps: FlipClauseToShippedDeps = {
      clauseStateClient: stateClient,
      waveContinuationDeps: waveDeps,
    };

    const result = await flipClauseToShipped(
      { clauseId: 'C1', featureId: 'F6', waveIndex: 0 },
      deps,
    );

    assert.equal(result.clauseStatus, 'shipped');
    // Ordering: markClauseShipped MUST come strictly before getWaveSnapshot.
    const opOrder = store.calls.map((c) => c.op);
    const flipIdx = opOrder.indexOf('markClauseShipped');
    const snapIdx = opOrder.indexOf('getWaveSnapshot');
    assert.ok(flipIdx >= 0, 'markClauseShipped fires');
    assert.ok(snapIdx > flipIdx, 'getWaveSnapshot fires AFTER markClauseShipped');
    // Wave continuation ran; scoper called; wave marked continuation_fired.
    assert.equal(scoper.calls.length, 1);
    assert.equal(result.waveCheck.status, 'continuation_fired');
  });

  it('propagates the wave-check result back to the caller for observability', async () => {
    const store: FakeStateStore = {
      waves: new Map(),
      nextWaveMap: new Map(),
      clauseFlips: [],
      calls: [],
    };
    seedWave(store, {
      feature_id: 'Ffinal',
      wave_index: 0,
      status: 'in_progress',
      clauses: [{ clause_id: 'CX', status: 'shipped' }],
    });
    store.nextWaveMap.set(waveKey('Ffinal', 0), null);
    const stateClient = makeFakeStateClient(store);
    const scoper = makeFakeScoper('always_ok');
    const events = makeFakeEventSink();

    const res = await flipClauseToShipped(
      { clauseId: 'CX', featureId: 'Ffinal', waveIndex: 0 },
      {
        clauseStateClient: stateClient,
        waveContinuationDeps: {
          stateClient,
          scoperClient: scoper.scoper,
          pipelineEvents: events.sink,
          nowImpl: fixedNow('2026-07-03T12:00:00.000Z'),
        },
      },
    );
    assert.equal(res.waveCheck.status, 'pipeline_complete');
  });
});

// -----------------------------------------------------------------------------
// AC07 — WaveStatus exhaustiveness

describe('AC07 WaveStatus union includes continuation_fired and is exhaustive', () => {
  // A switch-with-never fallback compiled by tsc --noEmit. If any WaveStatus
  // literal is missing from the branches, the assignment to `_never: never`
  // becomes a compile error. This function is invoked at runtime with every
  // literal to guarantee no accidental runtime bug (defense-in-depth beyond
  // tsc-only). Type-only failure surfaces via `npm run typecheck`.
  function classify(s: WaveStatus): string {
    switch (s) {
      case 'in_progress':
        return 'in_progress';
      case 'shipped':
        return 'shipped';
      case 'continuation_fired':
        return 'continuation_fired';
      case 'complete':
        return 'complete';
      case 'stalled':
        return 'stalled';
      default: {
        const _never: never = s;
        return _never;
      }
    }
  }

  it('classifies every known literal including continuation_fired', () => {
    const literals: WaveStatus[] = [
      'in_progress',
      'shipped',
      'continuation_fired',
      'complete',
      'stalled',
    ];
    for (const s of literals) {
      assert.equal(classify(s), s);
    }
  });

  it('MAX_FIRE_NEXT_WAVE_RETRIES is exactly 3', () => {
    assert.equal(MAX_FIRE_NEXT_WAVE_RETRIES, 3);
  });
});
