# nous-agents — Architectural Contract

## Identity

- **Repo**: `kkef26/nous-agents` (private)
- **Runtime**: Node.js 20+ on Hetzner ccx23 (5.161.190.85)
- **Module system**: ESM with `"module": "NodeNext"` — all imports use `.js` extensions
- **Process manager**: PM2 (`ecosystem.config.js` per service)
- **Deploy target**: Hetzner via `git pull + tsc + pm2 reload` (L18: staging branch only)

## Directory Layout

```
nous-agents/
├── hetzner/                    ← LIVE CODE. Everything deployed runs from here.
│   ├── scoper/                 ← Scoper service (:8790)
│   │   ├── src/
│   │   │   ├── index.ts        ← Express server, route wiring
│   │   │   ├── plan.ts         ← Mode: plan (6-step playbook)
│   │   │   ├── replan.ts       ← Mode: replan (failure recovery)
│   │   │   ├── decomposition.ts ← Generate + Enrich clause modes
│   │   │   ├── alignment_gate.ts ← Haiku cold-read gate for generated clauses
│   │   │   ├── prerequisites.ts ← 7-point prerequisite check
│   │   │   ├── waves.ts        ← Wave organization + WSJF
│   │   │   ├── status.ts       ← Health + status endpoints
│   │   │   ├── deploy.ts       ← Self-deploy endpoint
│   │   │   ├── _shared.ts      ← Constants, shared helpers (insertDispatchTree, etc.)
│   │   │   └── lib/common/     ← Shared helpers (see below)
│   │   ├── dist/               ← TSC output (gitignored)
│   │   ├── ecosystem.config.js ← PM2 config (port, env vars)
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── conductor/              ← Conductor service (:8791)
│       ├── src/
│       │   ├── index.ts        ← Express server
│       │   ├── verify.ts       ← Verify mode (6 checks + Sentinel)
│       │   ├── merge.ts        ← Merge staging→main
│       │   ├── sentinel.ts     ← Haiku scoring (tests, criticals, coverage, perf)
│       │   ├── fuse_manager.ts ← Circuit breaker for repeated failures
│       │   ├── tactical_amend.ts ← Hot-fix amendment flow
│       │   ├── status.ts
│       │   ├── shared.ts
│       │   └── lib/common/     ← Shared helpers
│       ├── dist/
│       ├── ecosystem.config.js
│       ├── tsconfig.json
│       └── package.json
├── supabase/
│   └── functions/              ← DEAD CODE. Legacy Deno edge function stubs.
│       ├── scoper/             ← NOT deployed. Historical artifact.
│       ├── conductor/          ← NOT deployed. Historical artifact.
│       └── _common/            ← NOT deployed.
└── README.md
```

## Critical Rule: `supabase/functions/` is DEAD CODE

Live services run from `hetzner/`. The `supabase/functions/` directory contains legacy Deno edge function stubs from before the Node.js conversion. These files are NOT deployed anywhere and MUST NOT be modified. Workers targeting `supabase/functions/scoper/` are writing to a dead path.

## Shared Helpers (`lib/common/`)

Both scoper and conductor have a `lib/common/` directory with identical helper modules:

| File | Purpose |
|------|---------|
| `db.ts` | `getSupabaseClient()` — singleton Supabase client |
| `github.ts` | GitHub API helpers (contents, commits, refs) |
| `logging.ts` | `writeScoperStep()` / `writeConductorStep()` — structured step logging |
| `audit_trail.ts` | `resolveAuditTrail()` — extract agent/session/org from request |
| `loop_guard.ts` | Dedup + hourly cap for loop prevention |
| `cost.ts` | Token → cost calculation |
| `types.ts` | Shared type definitions |
| `vercel.ts` | Vercel deploy helpers |
| `source_material.ts` | (scoper only) `loadFeatureSourceMaterial()` query helper |

When adding a helper used by both services, add it to both `lib/common/` directories. These are NOT symlinked — they're independent copies. Keep them in sync manually.

## Service Ports

| Service | Port | Process |
|---------|------|---------|
| station-proxy | 8095 | Python (FastAPI) — LLM gateway |
| spawner | 8787 | Python (FastAPI) — worker dispatch |
| scoper | 8790 | Node.js (Express) — plan/replan |
| conductor | 8791 | Node.js (Express) — verify/merge |

## Express Handler Pattern

All routes follow the same pattern:

```typescript
// index.ts
app.post("/plan", async (req, res) => {
  const response = await handlePlan(req);  // Returns web Response
  res.status(response.status).json(await response.json());
});

// plan.ts
export async function handlePlan(req: Request): Promise<Response> {
  // ... logic ...
  return jsonResponse({ outcome_mode: "A", ... }, 200);
}
```

Handlers return web `Response` objects (not Express `res`). The index.ts adapter unwraps them. This pattern exists because the code was converted from Deno edge functions.

## Import Convention

NodeNext requires explicit `.js` extensions on all relative imports:

```typescript
// CORRECT
import { getSupabaseClient } from "./lib/common/db.js";
import { runPrerequisiteChecks } from "./prerequisites.js";

// WRONG — will fail at runtime
import { getSupabaseClient } from "./lib/common/db";
```

## File Ownership Per Clause Area

| Area | Owner files | Shared dependencies |
|------|------------|-------------------|
| Scoper plan mode | `plan.ts`, `decomposition.ts`, `prerequisites.ts`, `waves.ts`, `alignment_gate.ts` | `_shared.ts`, `lib/common/*` |
| Scoper replan | `replan.ts` | `plan.ts` (reuses `runPlan`), `_shared.ts` |
| Scoper infra | `index.ts`, `status.ts`, `deploy.ts` | `_shared.ts` |
| Conductor verify | `verify.ts`, `sentinel.ts` | `shared.ts`, `lib/common/*` |
| Conductor merge | `merge.ts`, `fuse_manager.ts` | `shared.ts`, `lib/common/*` |
| Conductor infra | `index.ts`, `status.ts` | `shared.ts` |

## Environment Variables

Required in `ecosystem.config.js`:

```
SUPABASE_URL          — https://oozlawunlkkuaykfunan.supabase.co
SUPABASE_SERVICE_ROLE_KEY — (from Supabase dashboard)
STATION_PROXY_URL     — http://127.0.0.1:8095
NOUS_API_KEY          — (for self-deploy and dispatch calls)
SCOPER_PORT / CONDUCTOR_PORT — port binding
```

## Deploy Flow

1. Push to `refs/heads/staging` via GitHub API
2. SSH to Hetzner: `git fetch origin staging && git reset --hard origin/staging`
3. `cd hetzner/<service> && npx tsc`
4. `pm2 reload <service>` (NOT `pm2 delete + start` unless env vars changed)
5. Verify: `curl http://localhost:<port>/health`

**PM2 env var gotcha**: `pm2 reload` does NOT pick up changed env vars in `ecosystem.config.js`. Must use `pm2 delete <service> && pm2 start ecosystem.config.js` to refresh env.
