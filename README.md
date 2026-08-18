# nous-agents

Two Supabase edge functions, one repo: **Conductor** (post-dispatch executor + merge gate) and **Scoper** (SCAFFOLD-stage planner). Part of the NOUS product family alongside `nous-station`, `nous-edge`, `nous-spawner`.

> **Spawner**: The worker pool / dispatch agent lives in [`kkef26/nous-spawner`](https://github.com/kkef26/nous-spawner), not in this repo.

## Identity

- Repo: `kkef26/nous-agents` (private)
- Brand: `Personal`
- Label: `NOUS Agents`
- Bible prefix: `AGT`
- Deploy targets: 2 Supabase edge functions on the NOUS project (`oozlawunlkkuaykfunan`)
- Workspace folder: `~/Desktop/Projects/nous-agents/`

## The two agents

**Conductor (v2)** — `/functions/v1/conductor/{verify,merge,status}`
The foreman. Cold-reads ACs after worker complete, runs 6-pillar quality checks, Sentinel-scores via Haiku, decides verdict (pass / pass_with_notes / fail_tactical / fail_strategic / block). Owns staging→main merge with lock + Vercel verify + production HEAD + deploy_url stamp. Veto authority on merges. Tactical amendment up to 2 retries with structured hints; 3rd failure escalates strategically to Scoper.

**Scoper (v3)** — `/functions/v1/scoper/{plan,replan,status}`
The planner. Reads grill resolution + ARCHITECTURE.md + bible_clauses + 7-point prerequisite check. Produces dispatch_tree DAG with feature_group + wave ordering (Mode A), OR writes findings to `nous.features.scoper_findings` and holds at REVIEW (Mode B), OR escalates structural blocks to `decision_queue` (Mode C). Two formal modes: `plan` (fresh) and `replan` (delta after Conductor escalation).

## Deploy law (L14 / L15 / L18 — enforced by Conductor)

GitHub is the only source of truth. The deploy path is:

```
1. Worker (or you) push to refs/heads/staging via GitHub API
2. Manual: POST /conductor/run mode=merge {project: 'nous-agents'}
   (auto: handleDispatchComplete will inline-call this in Phase 6)
3. Conductor merges staging→main after passing Sentinel + verdict checks
4. /redeploy?project=nous-agents pulls main and replaces live edge fns
5. Production HEAD verifies, deploy_url stamped, lock released
```

**No direct edge function deploys, ever.** Not via Supabase MCP `deploy_edge_function`. Not via Supabase CLI. Not via SSH. Not via any other path. If `ezbr_sha256` (live) ≠ GitHub main SHA, Conductor fires `fuse_edge_version_mismatch` (CRITICAL) and blocks all merges on this repo until resolved. Resolution: align live to git (re-push or revert), never the reverse.

**The one exception:** Phase 0 (bootstrap). The first deploy of both edge functions happens manually via Supabase MCP because Conductor doesn't yet exist to manage itself. This is logged as `fuse_bootstrap_manual_deploy` for the audit trail. After Phase 0, Conductor manages all subsequent deploys of itself and Scoper. See `docs/bootstrap.md`.

## Quick start

```bash
# Verify the agents are alive
curl https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor/status
curl https://oozlawunlkkuaykfunan.supabase.co/functions/v1/scoper/status

# Run conductor on a worker complete event (verify mode)
curl -X POST https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor/run \
  -H "x-api-key: $NOUS_KEY" \
  -d '{"mode":"verify","dispatch_id":"<uuid>","clause_id":"NST.42.1","complete_event_ref":"<event_id>"}'

# Run conductor merge on a project (merge mode)
curl -X POST https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor/run \
  -H "x-api-key: $NOUS_KEY" \
  -d '{"mode":"merge","project":"nous-edge","locked_by":"manual-2026-05-20"}'

# Run scoper on a feature (plan mode)
curl -X POST https://oozlawunlkkuaykfunan.supabase.co/functions/v1/scoper/run \
  -H "x-api-key: $NOUS_KEY" \
  -d '{"mode":"plan","feature_id":"<uuid>","grill_resolution_id":"<uuid>"}'

# Inspect logs (debug-first)
curl "https://oozlawunlkkuaykfunan.supabase.co/functions/v1/conductor/log?dispatch_id=<id>" -H "x-api-key: $NOUS_KEY"
curl "https://oozlawunlkkuaykfunan.supabase.co/functions/v1/scoper/log?feature_id=<id>" -H "x-api-key: $NOUS_KEY"
```

The Station UI exposes manual invoke buttons at `/audit` (Merge Now) and on feature/dispatch pages (Run Scoper / Run Conductor).

## Repo structure

```
nous-agents/
├── README.md                         ← this file
├── CONTEXT.md                        ← project source of truth
├── ARCHITECTURE.md                   ← Scoper's mandatory gate (read this)
├── supabase/
│   ├── functions/
│   │   ├── conductor/                ← Conductor v2 edge function
│   │   ├── scoper/                   ← Scoper v3 edge function
│   │   └── _common/                  ← shared helpers (db, github, vercel, logging, cost, loop_guard, audit_trail, types)
│   └── migrations/                   ← SQL migrations (applied to NOUS project)
├── skills/
│   ├── conductor/SKILL.md            ← Conductor v2 persona spec (canonical)
│   └── scoper/SKILL.md               ← Scoper v3 persona spec (canonical)
├── bible/                            ← AGT.* clauses (this project's bible)
└── docs/
    ├── deployment.md                 ← the GitHub-only deploy path detail
    ├── bootstrap.md                  ← chicken-and-egg solution + break-glass
    ├── fuses.md                      ← operator runbook for fuse kinds
    └── observability.md              ← how to query the logs + drawer wiring
```

## Persona specs are canonical

The persona specs (`skills/conductor/SKILL.md` and `skills/scoper/SKILL.md`) are the source of truth for agent behavior. Code in `supabase/functions/conductor/*.ts` and `supabase/functions/scoper/*.ts` implements those specs. **Any drift between spec and code is a bug, not a feature.** Conductor's Sentinel scoring + the AGT.4 verification gates catch drift at merge time.

## Observability

- `nous.conductor_log` — every Conductor step, with full audit trail (org_id, session_id, triggered_by_agent_id, parent_run_id, fuse_id) + cost + GitHub/Vercel call counts
- `nous.scoper_log` — same shape for Scoper
- `nous.fuses` — every active block, with severity + resolution_path + chain-of-custody
- `nous.agent_cost_summary` — rolling 1h / 24h / 7d cost aggregates per agent
- Station drawer (HOLDS, ACTIONS, COSTS) — live view, no batch lag
- Pocock can reconstruct any verdict, merge, or fuse from the logs alone

## Status

`draft` — first scaffold pending. Phase 0 (bootstrap) is the next real work after this repo is created on GitHub. See [`NOUS_Station/_plans/nous-agents_scaffold_plan.md`](../../nous-agents_scaffold_plan.md) for the full migration plan.

## Related projects in the NOUS family

| project | repo | role |
|---|---|---|
| NOUS Station | kkef26/nous-station | UI + Next.js app (Vercel) |
| NOUS Edge Functions | kkef26/nous-edge | NOUS API surface + brain (Supabase edge) |
| NOUS Spawner | kkef26/nous-spawner | worker pool + dispatch (EC2 54.174.233.250) |
| **NOUS Agents** | **kkef26/nous-agents** | **Conductor + Scoper (Supabase edge)** |

All four under `brand='Personal'` in `nous.projects`. Bible prefixes: NST / NED / NSP / AGT respectively.
