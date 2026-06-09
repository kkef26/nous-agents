# Investigation — `base_sha` lifecycle through dispatch_tree and Spawner boot

**Clause:** NOUS.SALVAGE.7
**Author:** c2-fg-nous-salvage-1
**Date:** 2026-06-09
**Scope:** Read-only. No runtime behaviour changed.
**Repos surveyed:** `kkef26/nous-edge`, `kkef26/nous-agents`, `kkef26/nous-station`.

Every line/range citation refers to the commit on `main` at the time of this
report (nous-edge `0f26013`, nous-agents `2f83903`, nous-station `main` HEAD).

---

## 1. Resolution Path

`base_sha` is the SHA of the canonical repo's `main` branch at the moment a
tree-run is fanned out. It is the anchor every worker uses to `git checkout
-b $DISPATCH_BRANCH $BASE_SHA` so concurrent dispatches do not collide on a
shared ref. The value moves through five sites, in order:

1. **Production point — `fetchMainHeadSha()`**
   File: `nous-edge/supabase/functions/nous/dispatch_tree.ts`, lines **36–57**.
   Per-tree-run cache keyed by repo slug. The SHA is read by hitting the
   GitHub REST endpoint `GET /repos/<repo>/git/ref/heads/main` with the
   `config.GITHUB_TOKEN` credential. Empty results are cached too — a repo
   that fails the call once does not retry per clause.

2. **Consumption inside the tree fan-out**
   Same file, lines **861–862** (multi-repo path) and **894–895** (single
   path). `chunkBaseSha` / `singleBaseSha` are computed once per
   `(tree_run_id, resolved_repo)` pair and passed positionally into
   `dispatchFeatureGroup()` (signature at line **353**) and
   `dispatchSingleClause()`.

3. **Write into the preflight contract**
   File: `nous-edge/supabase/functions/nous/dispatch_tree.ts`, lines
   **394** (feature-group path) and **562** (single-clause path). The
   `base_sha` key on the preflight body object is the *only* surface
   that carries the value out of dispatch_tree.

4. **Persistence — `dispatch_queue.base_sha`**
   File: `nous-edge/supabase/functions/nous/preflight.ts`, lines
   **259–260** (parse) and **489** (write). `dispatchPreflight` reads
   `body.base_sha`, trims it, and persists it on the `dispatch_queue` row
   along with `dispatch_branch`. Column type is `text` (nullable) per
   the dispatch_queue schema dump.

5. **Surface to worker — boot context**
   File: `nous-edge/supabase/functions/nous/preflight.ts`, lines
   **170–190**. `formatBootBlock` emits `BASE_SHA=<sha>` into the
   `### Credentials` block whenever the value is truthy. The Spawner
   prompt-wrapper at `nous-agents/spawner/pool.py:152-193`
   (`ensure_boot_context`) does not parse `base_sha` — it just relays
   the boot block verbatim. The worker reads the env-style key out of
   its own prompt.

A re-fetch path exists in the worker (the comment at
`dispatch_tree.ts:54` says "best-effort — worker still has CANONICAL_REPO
and can refetch") but there is **no code in this repo that performs
that refetch**. Workers that receive `BASE_SHA=` (empty / absent) check
out from local `main` HEAD instead — silent fallback.

---

## 2. Observed Gaps

Each item lists the concrete file:line, what is suspect, and the
strength of the evidence. Speculation is marked explicitly as such per
the clause constraint.

### Gap A — single-shot HEAD fetch creates a TOCTOU drift window
`dispatch_tree.ts:36-57`. `fetchMainHeadSha` runs once per repo per
tree-run, *before* the dispatches are inserted into `dispatch_queue`.
Between that fetch and the moment a worker actually runs `git fetch`,
main can advance by an arbitrary number of commits (every other merge
that lands on main during this interval widens the drift). When the
worker then attempts to push and merge, GitHub's `/merges` endpoint
returns 409 "base does not contain head" — that is the symptom SALVAGE
is built to recover from. The fetch is correct in isolation; the gap is
the *gap between fetch and use*, not the fetch itself.

Evidence: strong. Direct read of the function plus inspection of the
single call site sequence.

### Gap B — GitHub-token credential lookup is silently optional
`dispatch_tree.ts:43-44`. `tokRow` is read from `config.value` where
`key='GITHUB_TOKEN'`. If the row is missing or the column is empty,
`ghToken` is falsy and the entire `if (ghToken)` block is skipped. The
function returns `null` and the worker boots with **no** `BASE_SHA`
header at all. There is no log line and no error response — this
failure mode is invisible in production telemetry.

Evidence: strong. Direct read; no surrounding `console.log` /
`agent_events` emit.

### Gap C — base_sha is not re-anchored on retry
`preflight.ts:259-260`. When a dispatch fails and is re-claimed (e.g.
after `merge_conflict`), the new dispatch row inherits `base_sha`
*from the inbound request body*, which in retry flows is typically
empty — so the persisted column lands `null`. The original tree-run's
SHA is not propagated to retries via any of the paths I read.

Evidence: medium. I traced the body assembly through `factory.ts`'s
retry logic and did not find a place that re-injects base_sha; however
I did not exhaustively read every dispatch creation entry point
(orchestrator, freeform, healer reburn) — see Uncertainty 1.

### Gap D — workers without BASE_SHA fall back to local main HEAD
`nous-agents/spawner/pool.py:152-193`. `ensure_boot_context` only
prepends the boot block if it is missing entirely; it does not
post-process the credentials block to inject `BASE_SHA`. Workers that
were created via dispatch paths that bypass `formatBootBlock`
(freeform, orchestrator — line **174** of preflight.ts notes both
"skip these") receive prompts with **no `BASE_SHA=`** line at all. The
implicit fallback at git layer is to use whatever `main` HEAD the
worker observes when it runs `git fetch` — which by definition is
*later* than the dispatch's intended anchor.

Evidence: strong for the formatting side. Inference for the worker
side — no Python code in `nous-agents/spawner/` parses `BASE_SHA`
explicitly, so the value reaching the worker is whatever the LLM
chooses to read out of its own prompt. See Uncertainty 2.

### Gap E — dispatch_tree.ts is mirrored at nous-station@ec6bfad1
`dispatch_tree.ts:920-923`. Inline comment: *"Ported from
kkef26/nous-station@ec6bfad1 — that copy of dispatch_tree.ts is a
STALE MIRROR; the live nous edge function deploys from nous-edge."*
A second copy of this file exists. If anyone edits the wrong one, the
base_sha contract diverges silently. Not a correctness bug today but a
maintenance hazard worth recording.

Evidence: strong. The comment is self-documenting.

### Uncertainty 1 — base_sha population on dispatch retry
I traced the *primary* fan-out path (`/dispatch/tree`) end-to-end but
did not confirm the retry path inside
`nous-edge/supabase/functions/nous/factory.ts` and
`orchestrator.ts`. If those paths *do* re-anchor base_sha against
fresh main HEAD, Gap C is overstated. I am flagging the absence-of-
evidence here so the future fix clause covers it.

### Uncertainty 2 — worker-side BASE_SHA parsing
The Spawner prompt embedding (`pool.py:200+`, the
`SPAWNER OPERATIONAL INSTRUCTIONS` block) shows the LLM how to report
progress and close out, but the worker is the LLM itself; what it does
with `BASE_SHA=` depends on the prompt's `git checkout` instructions
and the LLM's adherence. I read no spawner-side enforcement that the
checkout actually used that SHA. This is design-of-system uncertainty,
not absent code I missed.

---

## 3. Recommended Fix Scope (read-only — no implementation)

A future clause should touch *only* these files when implementing the
fix. Any other file requires the scope to be re-derived from the
clause's intended outcome.

### Must-touch
1. `nous-edge/supabase/functions/nous/dispatch_tree.ts` — function
   `fetchMainHeadSha` (lines **36–57**). Either (a) add a "re-anchor
   on staleness" recheck before each dispatch insert, or (b) accept
   the TOCTOU window and document it as the SALVAGE recovery surface.
2. `nous-edge/supabase/functions/nous/preflight.ts` — `formatBootBlock`
   (lines **170–190**) plus the parse at **259–260**. If Gap C is
   confirmed (Uncertainty 1), inject the tree-run's base_sha on
   retry-path inserts.

### Should-touch
3. `nous-edge/supabase/functions/nous/dispatch_tree.ts` — add a single
   structured `agent_events` row when `fetchMainHeadSha` returns
   `null` so Gap B becomes observable. One emit, no flow change.

### Out of scope for the eventual fix clause
- `nous-agents/spawner/pool.py` — the Spawner is a relay; the
  authoritative value flows through preflight. No spawner change should
  be required to land the fix.
- `nous-station/packages/conductor/` and `hetzner/conductor-v4/` — the
  conductor reads `base_sha` from `dispatch_queue` (already nullable);
  the fix is upstream of the conductor.
- `nous-station/packages/conductor/src/dispatch_tree.ts` — confirmed
  STALE MIRROR (Gap E). Do not edit; consider deletion as a separate
  cleanup clause.

### Verification suggestions (for the fix author, not this clause)
- Reproduce Gap A by inserting a 10-second sleep between
  `fetchMainHeadSha` and the first `dispatch_queue` insert in a test
  fixture, then merging a commit to main during that sleep.
- Reproduce Gap B by clearing `config.GITHUB_TOKEN` in a non-prod env
  and observing that `BASE_SHA` does not appear in worker prompts.

---

## Source crosswalk

| Concern | File | Line range |
| --- | --- | --- |
| Fetch HEAD | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 36–57 |
| Per-run cache | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 727 |
| Multi-repo call site | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 861–862 |
| Single-clause call site | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 894–895 |
| Group dispatch contract | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 353, 394 |
| Single dispatch contract | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 523, 562 |
| Stale mirror callout | `nous-edge/supabase/functions/nous/dispatch_tree.ts` | 920–923 |
| Preflight parse | `nous-edge/supabase/functions/nous/preflight.ts` | 259–260 |
| Preflight persist | `nous-edge/supabase/functions/nous/preflight.ts` | 486–489 |
| Boot-block emit | `nous-edge/supabase/functions/nous/preflight.ts` | 170–190 |
| Spawner prompt relay | `nous-agents/spawner/pool.py` | 152–193 |
| dispatch_queue column | `nous.dispatch_queue` schema (live) | `base_sha text NULL` |
