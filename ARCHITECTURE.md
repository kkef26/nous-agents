# NOUS Agents — ARCHITECTURE

**Purpose:** This is the mandatory architecture artifact Scoper v3 reads on every run. Per Scoper's contract, missing or unreadable architecture → automatic Mode B (held). This document MUST stay current with what the repo actually contains.

## Component map

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Supabase Edge Functions                            │
│                                                                          │
│  ┌───────────────────────────┐    ┌─────────────────────────────────┐   │
│  │  conductor (edge fn)      │    │  scoper (edge fn)               │   │
│  │  ─────────────────────    │    │  ───────────────────────────    │   │
│  │  index.ts (router)        │    │  index.ts (router)              │   │
│  │  ├─ verify.ts             │    │  ├─ plan.ts                     │   │
│  │  ├─ merge.ts              │    │  ├─ replan.ts                   │   │
│  │  ├─ sentinel.ts (haiku)   │    │  ├─ prerequisites.ts (7 checks) │   │
│  │  ├─ tactical_amend.ts     │    │  ├─ decomposition.ts            │   │
│  │  ├─ fuse_manager.ts       │    │  ├─ waves.ts                    │   │
│  │  ├─ status.ts             │    │  ├─ status.ts                   │   │
│  │  └─ _shared.ts            │    │  └─ _shared.ts                  │   │
│  └─────────┬─────────────────┘    └─────────┬───────────────────────┘   │
│            │                                 │                          │
│            ├──────────── _common/ ───────────┤                          │
│            │  db.ts / github.ts / vercel.ts                             │
│            │  logging.ts / cost.ts                                      │
│            │  loop_guard.ts / audit_trail.ts                            │
│            │  types.ts                                                  │
│            └─────────────────────────────────┘                          │
│                                                                          │
└──┬────────────────────────────────────────────────────────────────────┬─┘
   │                                                                    │
   ▼                                                                    ▼
┌──────────────────────────────┐                    ┌────────────────────────┐
│  Supabase Postgres (NOUS)    │                    │  External services      │
│  ───────────────────────     │                    │  ──────────────────     │
│  nous.conductor_log          │                    │  GitHub API             │
│  nous.scoper_log             │◄────────write──────│  - branches, refs       │
│  nous.fuses + active_fuses   │                    │  - merges, commits      │
│  nous.merge_locks            │                    │  - file content reads   │
│  nous.dispatch_queue         │                    │                          │
│  nous.dispatch_tree          │                    │  Vercel API             │
│  nous.bible_clauses          │                    │  - deployment status    │
│  nous.features (+findings)   │                    │  - build logs           │
│  nous.amendment_queue        │                    │                          │
│  nous.projects               │                    │  Anthropic API          │
│  nous.config                 │                    │  - claude-opus-4-7      │
│  nous.memories               │                    │  - claude-sonnet-4-6    │
│  nous.agent_cost_summary     │                    │  - claude-haiku-4-5     │
└──────────────────────────────┘                    │    (Sentinel)           │
                                                    └────────────────────────┘
```

## Integration surface

### Upstream callers (who invokes the agents)

| caller | surface | when |
|---|---|---|
| Station UI `/audit` "Merge Now" button | `POST /conductor/run mode=merge` (via station proxy) | Kosta clicks |
| Station UI feature page "Run Scoper" button | `POST /scoper/run` (via station proxy) | Kosta clicks |
| Station UI dispatch row "Run Conductor" button | `POST /conductor/run mode=verify` (via station proxy) | Kosta clicks |
| Manual API caller | `POST /conductor/run` or `POST /scoper/run` directly | curl, agent, script |
| **Future Phase 6**: nous-edge `handleDispatchComplete` | inline call `POST /conductor/run mode=verify` | worker fires complete event |
| **Future Phase 6**: DB trigger on `nous.features.lifecycle_stage = 'scaffold'` | `POST /scoper/run mode=plan` | feature reaches SCAFFOLD |

### Downstream effects (what the agents touch)

| target | effect |
|---|---|
| `nous.conductor_log` / `nous.scoper_log` | every step writes a row (debug-first) |
| `nous.fuses` | triggers + clears with full chain-of-custody |
| `nous.dispatch_queue` | merge mode stamps `deploy_url`; verify mode reads result |
| `nous.dispatch_tree` | Scoper Mode A emits DAG rows |
| `nous.features.scoper_findings` | Scoper Mode B writes findings jsonb |
| `nous.decision_queue` | Mode C escalation (advisory) |
| `nous.merge_locks` | Conductor merge mode acquires/releases |
| `nous.amendment_queue` | Conductor tactical amendments enqueue redispatches |
| GitHub `refs/heads/main` | Conductor merge mode PATCHes (the only allowed writer) |
| GitHub `refs/heads/staging` | nobody on this path writes; workers write here per L18 |

### Side-channel: signals

Agents emit named signals via the signals infrastructure (existing NOUS signal table). The Station UI listens via realtime + drawer queries. Signal names per persona spec; CRITICAL severity fuse signals trigger banners.

## Data flow

### Verify mode (Conductor)

```
worker_complete_event fires
   │
   ▼
Conductor verify mode invoked (manual or inline-call in Phase 6)
   │
   ├─ Step 1: lock mode, verify input, loop guards
   ├─ Step 2: cold-read each AC independently (curl/sql), ignore worker self-report
   ├─ Step 3: 6-pillar quality check
   │            ├─ compile (Vercel build status or typecheck)
   │            ├─ AC pass (Step 2 result aggregate)
   │            ├─ harmonic (search bible_clauses for prior patterns)
   │            ├─ pattern (read CONTEXT.md, ARCHITECTURE.md for project conventions)
   │            ├─ score (deferred to Step 4)
   │            └─ sound (read scoper_log for original customer_experience)
   ├─ Step 4: Sentinel score (Haiku-4.5, mechanical, 5-axis 100-point rubric)
   ├─ Step 5: decide verdict
   │            ├─ pass (Sentinel ≥85, all pillars OK)
   │            ├─ pass_with_notes (Sentinel 70-84)
   │            ├─ fail_tactical (Sentinel <70 + patch-shaped failure)
   │            ├─ fail_strategic (architectural failure OR 2 retries exhausted)
   │            └─ block (active lock / broken prereq)
   └─ Step 6: route
                ├─ pass → flag for merge eligibility, write conductor_log
                ├─ fail_tactical → dispatch retry via /dispatch with structured hint, increment retry_count
                └─ fail_strategic → emit scoper_replan_requested signal with failure_context
```

### Merge mode (Conductor)

```
Operator clicks /audit "Merge Now" OR manual /conductor/run mode=merge
   │
   ▼
Conductor merge mode invoked
   │
   ├─ Step 1: lock mode, verify input, loop guards, FUSE CHECK (active fuses block)
   ├─ Step 2: acquire nous.merge_locks for project (take over if existing >10min stale)
   ├─ Step 3: read GitHub staging-vs-main diff via API
   │            ├─ zero diff: exit "nothing_to_merge", release lock
   │            └─ diff exists: continue
   ├─ Step 4: validate every clause in diff has a pass verdict in conductor_log
   │            └─ if any fail: exit "blocked_acs" with list, release lock (VETO)
   ├─ Step 4.5: check ezbr_sha256 (live) vs GitHub main SHA — mismatch → fuse_edge_version_mismatch
   ├─ Step 5: GitHub merge via PATCH refs/heads/main (or PR + auto-merge)
   ├─ Step 6: poll Vercel deployment status (timeout 5min)
   ├─ Step 7: curl HEAD on production URL (expect 2xx/3xx)
   ├─ Step 8: stamp deploy_url on each merged clause's dispatch_queue row, fire shipped events
   ├─ Step 8a (rollback path): generate revert commit if Step 6 timed out or Step 7 failed
   │            └─ if revert itself fails: fuse_rollback_failure (CRITICAL), manual intervention
   └─ Step 9: release lock, emit conductor_merged signal, write conductor_log
```

### Plan mode (Scoper)

```
Operator runs /scoper/run mode=plan {feature_id, grill_resolution_id}
   │
   ▼
Scoper plan mode invoked
   │
   ├─ Step 1: lock mode, verify input, loop guards
   ├─ Step 2: Working Backwards decomposition
   │            ├─ draft customer_experience statement
   │            ├─ list preconditions
   │            └─ list clauses per precondition
   ├─ Step 3: AC derivation (Ulwick outcome statements + technical-spec form)
   ├─ Step 4: 7-point prerequisite check
   │            ├─ #1 canonical_repo, #2 staging branch, #3 deploy config, #4 credentials, #7 no overlap
   │            │     → fixable inline if mechanical
   │            └─ #5 ARCHITECTURE GATE (MANDATORY), #6 GRILL GATE (MANDATORY)
   │                  → NOT fixable inline. Missing either = Mode B, no exception.
   ├─ Step 5: wave organization (feature_group + DAG + WSJF + sequence_order)
   └─ Step 6: emit
                ├─ Mode A (all green): nous.dispatch_tree row + clear features.scoper_findings + signal scoper_plan_emitted
                ├─ Mode B (gaps): WRITE features.scoper_findings jsonb + signal scoper_held (drawer picks up)
                └─ Mode C (structural): decision_queue row + signal scoper_escalate
```

### Replan mode (Scoper)

Same playbook as plan mode, but Step 1 input includes `prior_plan_id` + `failure_context` from Conductor's strategic escalation. Step 2 starts with "given this failure, what changes?" Step 6 Mode A output includes `delta_from_prior`.

## Deploy targets

### Conductor edge function

- Slug: `conductor`
- URL: `https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor`
- Routes: `/run` (POST with mode body), `/status` (GET), `/log` (GET)
- Hard timeout: 120s (merge mode includes Vercel polling)
- Default model: claude-opus-4-7
- Sentinel sub-model: claude-haiku-4-5

### Scoper edge function

- Slug: `scoper`
- URL: `https://oozlawunlkkuaykfunan.supabase.co/functions/v1/scoper`
- Routes: `/run` (POST with mode body), `/status` (GET), `/log` (GET)
- Hard timeout: 90s
- Default model: claude-opus-4-7

### Deploy path (the only allowed path)

```
1. Worker (or Kosta) pushes new code to refs/heads/staging on kkef26/nous-agents
2. Conductor merge mode invoked (manual via /conductor/run mode=merge OR /audit "Merge Now")
3. Conductor evaluates ALL clauses in staging diff via conductor_log verdicts
4. Conductor PATCHes refs/heads/main (the GitHub merge)
5. /redeploy?project=nous-agents pulls main and replaces live edge functions
   ↑ this is the existing /redeploy edge fn on nous-edge, generalized in Phase 0.7
6. Vercel-equivalent verify step: curl HEAD on the two edge fn URLs — both must return 200
7. Conductor stamps deploy_url, releases lock, emits conductor_merged
```

**Self-modifying merge:** Any commit touching `supabase/functions/conductor/*.ts` triggers extra protection (Sentinel ≥90, 5-min observation window, auto-rollback on CRITICAL fuse).

## Mandatory contracts (the agents' guardrails)

### Conductor cannot

- Emit verdict without Sentinel score
- Merge if any clause lacks pass verdict (VETO)
- Merge without per-project lock
- Retry tactically beyond 2 attempts per clause per dispatch
- Escalate strategically without populated `failure_context`
- Merge if production verify fails (rollback or block)
- Rollback by file edit (revert commit only)
- Trust worker self-reports (must cold-read)
- Infer mode from context

### Scoper cannot

- Dispatch workers directly (emits dispatch_tree; someone else dispatches)
- Ratify clauses (emits maturity_stage='SPEC'; /bible/upsert ratifies)
- Modify bible_clauses status or maturity_stage
- Merge code (Conductor's job)
- Bypass the grill gate or architecture gate (both MANDATORY)
- Invent schema fields outside `bible_clauses` / `dispatch_tree` columns
- Quote human-team time estimates (velocity calibration is mandatory)
- Reference brand connections across projects (L12 stealth)
- Emit confidence: 1.0 in Complex-domain situations
- Infer mode from context

## Audit trail (Pocock-grade)

Every log row carries:
- `org_id` — multi-tenant readiness (single-org for now)
- `triggered_by_agent_id` — 'kosta' | 'cowork-<session>' | 'conductor-<run_id>' | 'audit-merge-button' | worker_id
- `session_id` — originating session (Cowork / Claude2 / API)
- `parent_run_id` — for replans and re-verifies
- `fuse_id` — links to nous.fuses row if this run triggered or was blocked by a fuse
- `supabase_invocation_id` — cross-reference with Supabase dashboard

Pocock (the auditor persona, future) can reconstruct any agent action: "this scoper plan was triggered by Conductor run X, which was triggered by worker Y completing dispatch Z in session S, which was originally dispatched by Kosta in Cowork session T." No untraceable actions.

## Cost surface

| component | cost shape |
|---|---|
| Conductor verify (opus per verdict + haiku for Sentinel) | ~$0.05-$0.20 + $0.01-$0.02 = $0.06-$0.22 per verdict |
| Conductor merge (mostly API calls, opus only for edge cases) | ~$0.01-$0.10 per merge |
| Scoper plan (opus per decomposition + 7-point check) | ~$0.25-$2.00 per feature |
| Scoper replan (opus, delta-based) | ~$0.15-$1.00 per replan |
| Cost ceilings | **none** — Claude Max fixed-cost. Loop guards prevent runaway. |

Aggregates in `nous.agent_cost_summary` view, surfaced in Station COSTS drawer. Red indicator on any agent row if loop_guards triggered in the last hour.

## Bootstrap (chicken-and-egg)

The first deploy of both edge functions is manual via Supabase MCP (Phase 0 only). Logged as `fuse_bootstrap_manual_deploy`. After Phase 0, Conductor manages itself via the standard path — atomic per-commit, with self-modifying merge safety (Sentinel ≥90 + 5-min observation + auto-rollback).

Break-glass: documented in `docs/bootstrap.md`. If Conductor is broken so badly it can't self-update, Kosta uses Supabase MCP one more time (logged again), pushes fix to GitHub, normal flow resumes.

## What ARCHITECTURE.md does NOT include (deferred)

- Pocock formal persona spec (future)
- STRATA formal persona spec (future)
- Sentinel as standalone persona/edge fn (currently inline inside Conductor)
- Auto-trigger wiring (Phase 6)
- Hetzner migration (separate project, when/if needed)
- Multi-tenant rollout (schema ready, application logic single-org)
- Station drawer visual redesign (data layer is here; visual is downstream)

## Drift detection

If any of the following becomes true, this document is out of date and Scoper will hold features on the Architecture gate:
- New files in `supabase/functions/conductor/*` or `supabase/functions/scoper/*` not listed in Component map
- New tables / views in `nous.*` schema not listed in Integration surface
- New routes on the edge functions not in Data flow
- New fuse kinds beyond the 10 in Conductor v2 spec
- Persona spec changes not reflected here (mandatory contracts section)

Update this file FIRST when any of those change. Then merge. Conductor's pattern check pillar will catch architecture drift on subsequent verifies.
