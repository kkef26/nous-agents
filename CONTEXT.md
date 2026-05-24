# NOUS Agents — CONTEXT

## Identity

- **Repo**: `kkef26/nous-agents` (private)
- **Brand**: `Personal`
- **Label**: `NOUS Agents`
- **Bible prefix**: `AGT`
- **Workspace folder**: `~/Desktop/Projects/nous-agents/`
- **Deploy targets**: 2 Supabase edge functions on NOUS project `oozlawunlkkuaykfunan`
  - `https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor`
  - `https://oozlawunlkkuaykfunan.supabase.co/functions/v1/scoper`
- **Stack**: TypeScript / Deno (Supabase edge runtime), no frontend, no Vercel

## Current state (2026-05-20)

**Status:** scaffold pending. Repo not yet created on GitHub. Phase 0 (bootstrap) is the next work.

**Pre-flight SQL fixes applied:** TBD — gated on Kosta sign-off for the pre-flight step in the scaffold plan.

**Persona specs canonical and pushed to NOUS:**
- Scoper v3 → memory `0ff5f394-912d-4c15-844e-2916b05b2b35` (full) + `211fe438-1c31-48ce-baa1-034e80a9db96` (summary)
- Conductor v2 → memory `71919450-651d-44ee-b7ac-cb07f21c3f16` (full) + `39108ff2-3049-454e-99bb-441faa45c8fa` (summary)
- Scaffold plan v1 → memory `3c8a1201-9e41-45ba-862e-548379d4dcfa` (full) + `cfd4f913-4ed0-4fb4-abd1-4779acd51adf` (summary)

Local copies at:
- `~/Desktop/Projects/NOUS_Station/_personas/scoper_v3.md`
- `~/Desktop/Projects/NOUS_Station/_personas/conductor_v2.md`
- `~/Desktop/Projects/NOUS_Station/_plans/nous-agents_scaffold_plan.md`

## Agent inventory

### Conductor v2

| file (target structure) | purpose | size estimate |
|---|---|---|
| `supabase/functions/conductor/index.ts` | router: verify / merge / status / log | ~5KB |
| `supabase/functions/conductor/verify.ts` | verify mode (6 steps: lock+input → cold-read ACs → 6-pillar → Sentinel → verdict → route) | ~15KB |
| `supabase/functions/conductor/merge.ts` | merge mode (9 steps: lock → diff → validate verdicts → GitHub merge → Vercel poll → prod HEAD → stamp → release) | ~18KB |
| `supabase/functions/conductor/sentinel.ts` | Haiku-4.5 mechanical scoring on diff + ACs + pillars | ~6KB |
| `supabase/functions/conductor/tactical_amend.ts` | hint construction + redispatch with `parent_dispatch_id` + `attempt_count` | ~5KB |
| `supabase/functions/conductor/fuse_manager.ts` | fuse trigger + check + clear, taxonomy of 10 fuse kinds | ~8KB |
| `supabase/functions/conductor/status.ts` | GET /status for drawer feed | ~3KB |
| `supabase/functions/conductor/_shared.ts` | local helpers | ~2KB |

### Scoper v3

| file (target structure) | purpose | size estimate |
|---|---|---|
| `supabase/functions/scoper/index.ts` | router: plan / replan / status / log | ~4KB |
| `supabase/functions/scoper/plan.ts` | plan mode (6 steps: lock+input → Working Backwards → AC derivation → 7-point check → wave organization → emit) | ~16KB |
| `supabase/functions/scoper/replan.ts` | replan mode (delta-based) | ~8KB |
| `supabase/functions/scoper/prerequisites.ts` | 7-point check; #5 (Architecture) + #6 (Grill) are MANDATORY GATES — not fixable inline | ~6KB |
| `supabase/functions/scoper/decomposition.ts` | Working Backwards + AC derivation (Ulwick outcome statements + technical-spec form) | ~7KB |
| `supabase/functions/scoper/waves.ts` | feature_group + DAG + WSJF + sequence_order | ~5KB |
| `supabase/functions/scoper/status.ts` | GET /status for drawer feed | ~3KB |
| `supabase/functions/scoper/_shared.ts` | local helpers | ~2KB |

### Shared

| file (target structure) | purpose |
|---|---|
| `supabase/functions/_common/db.ts` | Supabase client (service role from env) |
| `supabase/functions/_common/github.ts` | GitHub API client (token from nous.config.GITHUB_TOKEN) |
| `supabase/functions/_common/vercel.ts` | Vercel API client (token from nous.config.VERCEL_TOKEN if needed) |
| `supabase/functions/_common/logging.ts` | write to conductor_log / scoper_log |
| `supabase/functions/_common/cost.ts` | token counting (input/output), cost calc, agent_cost_summary helpers |
| `supabase/functions/_common/loop_guard.ts` | dedup hash, hourly-cap check, heartbeat writer, stuck-run watchdog |
| `supabase/functions/_common/audit_trail.ts` | org_id / session_id / triggered_by_agent_id / parent_run_id resolution from input |
| `supabase/functions/_common/types.ts` | shared TypeScript types (Verdict, FuseKind, etc.) |

## Key architecture decisions

| decision | what |
|---|---|
| **Two formal modes per agent, declared not inferred** | Scoper: `plan` / `replan`. Conductor: `verify` / `merge`. Missing/unknown mode → exit to /decision. |
| **Cost is visibility, not policy** | Claude Max fixed-cost; no ceilings, no blocks. Loop/glitch guards prevent runaway. |
| **GitHub is source of truth** | L14/L15/L18 enforced by Conductor via `fuse_edge_version_mismatch`. Live aligns to git, never reverse. |
| **Cold-read AC re-verification** | Conductor never trusts worker self-reports. Verify runs ACs independently. |
| **Tactical amendment ≤2 retries** | Hard cap. 3rd failure → strategic escalation to Scoper. |
| **Veto authority on Conductor** | Only persona with this — needed because Kosta is out of the review loop. |
| **Mandatory gates on Scoper** | BOTH grill_resolution_id AND ARCHITECTURE.md must exist; missing either → automatic Mode B. |
| **Sweep retired** | No `/conductor/sweep` endpoint. Drawer covers "what's hung" via live queries. |
| **Self-modifying merge safety** | Conductor changes trigger Sentinel ≥90 + 5-min observation window + auto-rollback on CRITICAL fuse. |
| **Audit trail Pocock-grade** | Every log row carries org_id + triggered_by_agent_id + session_id + parent_run_id + fuse_id. |

## Database schema (in NOUS Supabase, schema `nous`)

| table / view | purpose | migration |
|---|---|---|
| `nous.scoper_log` | every Scoper step, debug + cost + audit trail | AGT.2.1 |
| `nous.conductor_log` | every Conductor step, debug + cost + audit trail | AGT.2.2 |
| `nous.fuses` + `nous.active_fuses` view | structured block state with chain-of-custody | AGT.2.3 |
| `nous.features.scoper_findings` (jsonb column) | Mode B findings on the feature row | AGT.2.4 |
| `nous.amendment_queue` (renamed `nous.scoper_queue`) | tactical amendment queue owned by Conductor | AGT.2.5 |
| `nous.agent_cost_summary` view | rolling 1h/24h/7d cost aggregates | AGT.2.6 |

## Active sprint

`sprints/sprint_2026-W21.md` (to be created after Phase 0). For now the work tracks against `_plans/nous-agents_scaffold_plan.md` phases.

## Known issues / open items

- **Phase 0 not yet executed.** Repo not on GitHub; agents not deployed; migrations not applied.
- **Existing /conductor/* routes in nous-edge still live.** They get retired in Phase 2D after the new Conductor proves itself.
- **3 unmerged commits on nous-edge staging** (`f5460bc`, `39af4bb`, `18b6bb5`) — DO NOT MERGE. They'll be deleted along with the rest of the old Conductor code in Phase 2D.
- **`nous.config['nous_api_key']` still holds the wrong key** (b301df78... = station-api key) until pre-flight fix is applied. Wire 4 (worker→pipeline advance) is silently broken until then.
- **3 conductor pg_cron jobs still active** (succeeding at the postgres level, all 25 HTTP calls/cycle returning soft-fails). Pre-flight disables them.
- **Station drawer components exist but partially wired** (PulseDrawer.tsx, PulseShell.tsx, SystemActivityStrip.tsx). Phase 4 work wires them to new data sources.
- **Sentinel rubric (Correctness 30 / Robustness 20 / Architecture 20 / Security 15 / Deployability 15) not calibrated** — recalibrate after 20+ scored runs.
- **Tactical retry cap = 2** — may be too tight for high-variance worker output; recalibrate after first 10 strategic escalations.

## Key files (canonical references)

- Persona specs: `skills/conductor/SKILL.md` + `skills/scoper/SKILL.md` (this repo, when scaffolded)
- Architecture: `ARCHITECTURE.md` (this repo, this folder)
- Migration plan: `_plans/nous-agents_scaffold_plan.md` (NOUS_Station companion)
- Live deploy path detail: `docs/deployment.md` (this repo)
- Bootstrap solution + break-glass: `docs/bootstrap.md` (this repo)
- Fuse runbook: `docs/fuses.md` (this repo)

## How to recall this repo's state from NOUS

```bash
# Project-scoped semantic recall (finds summaries; full docs linked via parent_memory_id)
curl "$NOUS/recall?q=<query>&project=nous-agents" -H "x-api-key: $NOUS_KEY"

# All architecture memories for this project
psql ... -c "SELECT id, rationale, LENGTH(content), created_at FROM nous.memories
             WHERE project='nous-agents' AND memory_type='architecture' AND still_valid
             ORDER BY created_at DESC;"

# Tagged search
psql ... -c "SELECT id, rationale FROM nous.memories
             WHERE tags && ARRAY['agents-rebuild', 'NOUS']
             ORDER BY created_at DESC;"
```

## How to dispatch worker against AGT clauses

Once the repo is alive and AGT bible clauses are registered, Scoper produces dispatch_tree, then:

```bash
# Tree dispatch (canonical, feature-grouped)
curl -X POST "$NOUS/dispatch/tree" \
  -H "x-api-key: $NOUS_KEY" \
  -d '{"project":"nous-agents","feature_id":"AGT.1"}'
```

Workers receive feature-grouped dispatches per May 19 grill D4. No individual per-clause dispatches.
