// supabase/functions/conductor/merge.ts
//
// AGT.1.1.3 — Conductor v2 MERGE mode. Gatekeeper for staging → main.
// Implements the 9-step merge playbook with unilateral veto authority.
//
// Step 1: Input + loop guard            — validate project, resolve repo
// Step 2: Acquire merge_lock            — INSERT into nous.merge_locks
// Step 3: Read staging diff             — github.compareCommits('main','staging')
// Step 4: Validate clauses verified     — VETO if any clause's latest verdict ≠ 'pass'
// Step 5: Execute GitHub merge          — POST /repos/{repo}/merges
// Step 6: Wait for Vercel build         — skip if deploy_target isn't Vercel
// Step 7: Production verification       — HEAD nous.projects.deploy_target
// Step 8: Stamp shipped + fire event    — UPDATE bible_clauses, write agent_events
// Step 9: Release lock                  — DELETE from merge_locks, log success
//
// Veto rule: step 4 is the safety net. If any clause in the diff has a
// non-'pass' verdict (or no verdict at all), merge is refused and lock is
// released. NO bypass path.

import { getConfigValue, getSupabaseClient } from "../_common/db.ts";
import { resolveAuditTrail } from "../_common/audit_trail.ts";
import { compareCommits } from "../_common/github.ts";
import { getDeploymentBySha } from "../_common/vercel.ts";
import { writeConductorStep } from "../_common/logging.ts";
import { createFuse } from "./fuse_manager.ts";
import type { AuditTrail } from "../_common/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Lock is considered abandoned once it's been held this long; firing
// merge_lock_jam pins the operator's attention rather than auto-bulldozing it.
const LOCK_STALE_MS = 10 * 60 * 1000;

// Vercel deployment poll budget. Web team agreed 3 min covers our typical
// build window; longer than that warrants an operator look.
const VERCEL_POLL_MAX_MS = 3 * 60 * 1000;
const VERCEL_POLL_INTERVAL_MS = 5000;

// Matches clause IDs like AGT.1.1.3, AXO.3.7, NST.82.3 in commit messages.
const CLAUSE_ID_RE = /\b([A-Z]{2,6}(?:\.\d+){1,5})\b/g;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isVercelTarget(canonicalVercelProject: string | null, deployTarget: string | null): boolean {
  if (canonicalVercelProject && canonicalVercelProject.trim() !== "") return true;
  if (deployTarget && /vercel\.app|vercel\.com/i.test(deployTarget)) return true;
  return false;
}

function extractClauseIds(commitMessages: string[]): string[] {
  const seen = new Set<string>();
  for (const msg of commitMessages) {
    if (!msg) continue;
    const matches = msg.matchAll(CLAUSE_ID_RE);
    for (const m of matches) seen.add(m[1]);
  }
  return [...seen];
}

interface LockAcquireResult {
  ok: boolean;
  stale?: boolean;
  heldBy?: string | null;
  heldAt?: string | null;
  ageMs?: number;
}

async function acquireMergeLock(
  project: string,
  holder: string,
  requestId: string,
): Promise<LockAcquireResult> {
  const sb = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const { error: insertErr } = await sb
    .from("merge_locks")
    .insert({
      project,
      locked_at: nowIso,
      locked_by: holder,
      request_id: requestId,
      status: "held",
    });

  if (!insertErr) return { ok: true };

  // 23505 = unique_violation — lock row already exists. Anything else is a hard error.
  const code = (insertErr as { code?: string }).code;
  if (code !== "23505") {
    throw new Error(`merge.acquireMergeLock: insert failed — ${insertErr.message}`);
  }

  const { data: existing, error: selErr } = await sb
    .from("merge_locks")
    .select("locked_at, locked_by")
    .eq("project", project)
    .maybeSingle();
  if (selErr) {
    throw new Error(`merge.acquireMergeLock: select after conflict failed — ${selErr.message}`);
  }
  if (!existing) {
    // Race: row was deleted between INSERT and SELECT. Retry once.
    const { error: retryErr } = await sb
      .from("merge_locks")
      .insert({
        project,
        locked_at: nowIso,
        locked_by: holder,
        request_id: requestId,
        status: "held",
      });
    if (!retryErr) return { ok: true };
    return { ok: false, heldBy: null, heldAt: null };
  }

  const heldAt = (existing as { locked_at: string }).locked_at;
  const heldBy = (existing as { locked_by: string }).locked_by;
  const ageMs = Date.now() - new Date(heldAt).getTime();
  return { ok: false, stale: ageMs > LOCK_STALE_MS, heldBy, heldAt, ageMs };
}

async function releaseLock(project: string, requestId: string): Promise<void> {
  const sb = getSupabaseClient();
  // Only delete the row we own — protects against accidentally clearing a
  // lock acquired by a different request after ours expired.
  const { error } = await sb
    .from("merge_locks")
    .delete()
    .eq("project", project)
    .eq("request_id", requestId);
  if (error) {
    console.error(`[conductor/merge] releaseLock(${project}): ${error.message}`);
  }
}

interface MergeApiResult {
  sha: string;
  message: string;
}

async function ghMerge(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<{ created: boolean; sha: string | null; status: number; rawText?: string }> {
  const token =
    (await getConfigValue("GITHUB_TOKEN")) ?? Deno.env.get("GITHUB_TOKEN") ?? null;
  if (!token) {
    throw new Error("merge.ghMerge: no GITHUB_TOKEN configured");
  }
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/merges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nous-agents/conductor/merge.ts",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ base, head, commit_message: `conductor: merge ${head} → ${base}` }),
  });
  // 201 = merge commit created, 204 = base already contains head (nothing to merge).
  if (resp.status === 204) return { created: false, sha: null, status: 204 };
  const text = await resp.text();
  if (resp.status === 201) {
    const data = JSON.parse(text) as MergeApiResult;
    return { created: true, sha: data.sha, status: 201 };
  }
  return { created: false, sha: null, status: resp.status, rawText: text };
}

async function pollVercelDeployment(
  projectKey: string,
  sha: string,
): Promise<{ ready: boolean; state: string | null; url: string | null }> {
  const deadline = Date.now() + VERCEL_POLL_MAX_MS;
  while (Date.now() < deadline) {
    const dep = await getDeploymentBySha(projectKey, sha);
    if (dep) {
      const state = dep.readyState ?? dep.state;
      if (state === "READY") return { ready: true, state, url: dep.url };
      if (state === "ERROR" || state === "CANCELED") {
        return { ready: false, state, url: dep.url ?? null };
      }
    }
    await new Promise((r) => setTimeout(r, VERCEL_POLL_INTERVAL_MS));
  }
  return { ready: false, state: "TIMEOUT", url: null };
}

async function verifyProductionUrl(url: string): Promise<{ ok: boolean; status: number | null }> {
  if (!url) return { ok: false, status: null };
  // Some hosts 405 on HEAD; fall back to GET if so.
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (head.status < 400) return { ok: true, status: head.status };
    if (head.status === 405) {
      const get = await fetch(url, { method: "GET", redirect: "follow" });
      return { ok: get.status < 400, status: get.status };
    }
    return { ok: false, status: head.status };
  } catch (err) {
    console.error(`[conductor/merge] verifyProductionUrl(${url}) failed:`, err);
    return { ok: false, status: null };
  }
}

async function stampShippedAndEmit(
  clauseIds: string[],
  mergeSha: string,
  project: string,
  audit: AuditTrail,
): Promise<void> {
  if (clauseIds.length === 0) return;
  const sb = getSupabaseClient();

  // shipped_in is a text[] — append the SHA per clause. Read-then-write so we
  // don't drop any prior shipped entries.
  for (const cid of clauseIds) {
    const { data: row, error: readErr } = await sb
      .from("bible_clauses")
      .select("shipped_in")
      .eq("id", cid)
      .maybeSingle();
    if (readErr) {
      console.error(`[conductor/merge] read bible_clauses(${cid}): ${readErr.message}`);
      continue;
    }
    if (!row) continue;
    const prior = ((row as { shipped_in: string[] | null }).shipped_in ?? []).filter(
      (x) => typeof x === "string",
    );
    const next = prior.includes(mergeSha) ? prior : [...prior, mergeSha];

    const { error: updErr } = await sb
      .from("bible_clauses")
      .update({ status: "shipped", shipped_in: next, updated_at: new Date().toISOString() })
      .eq("id", cid);
    if (updErr) {
      console.error(`[conductor/merge] update bible_clauses(${cid}): ${updErr.message}`);
    }
  }

  // Fire one shipped event covering the merge. agent_events is the NOUS sink.
  const { error: evtErr } = await sb.from("agent_events").insert({
    event_type: "shipped",
    agent_id: audit.triggered_by_agent_id,
    agent_type: "conductor",
    project,
    summary: `merged ${clauseIds.length} clause(s) at ${mergeSha.slice(0, 7)}`,
    details: { clause_ids: clauseIds, merge_sha: mergeSha, session_id: audit.session_id },
    session_id: audit.session_id,
  });
  if (evtErr) {
    console.error(`[conductor/merge] insert agent_events shipped: ${evtErr.message}`);
  }
}

export async function handleMerge(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", allow: "POST" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const audit = resolveAuditTrail(body);
  const project = typeof body.project === "string" ? body.project : "";
  const dryRun = body.dry_run === true;

  if (!project) return json({ error: "project_required" }, 400);

  const sb = getSupabaseClient();
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();

  // ─── Step 1: input + loop guard ─────────────────────────────────────────
  const { data: projectRow, error: projectErr } = await sb
    .from("projects")
    .select("tag, canonical_repo, canonical_vercel_project, deploy_target")
    .eq("tag", project)
    .maybeSingle();
  if (projectErr) {
    return json({ error: "project_lookup_failed", message: projectErr.message }, 500);
  }
  if (!projectRow) {
    return json({ error: "project_not_found", project }, 404);
  }
  const canonicalRepo = (projectRow as { canonical_repo: string | null }).canonical_repo;
  const canonicalVercelProject = (projectRow as { canonical_vercel_project: string | null })
    .canonical_vercel_project;
  const deployTarget = (projectRow as { deploy_target: string | null }).deploy_target;
  if (!canonicalRepo || !canonicalRepo.includes("/")) {
    await createFuse({
      kind: "unregistered_repo",
      project,
      detail: `canonical_repo missing or malformed (value: ${canonicalRepo ?? "null"})`,
      severity: "blocking",
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
      proposed_resolution: "UPDATE nous.projects SET canonical_repo='kkef26/<repo>' WHERE tag=$1",
    });
    return json({ merged: false, blocked: true, reason: "unregistered_repo" }, 409);
  }
  const [owner, repoName] = canonicalRepo.split("/", 2);

  await writeConductorStep({
    mode: "merge",
    project,
    step: 1,
    step_name: "input_validated",
    step_input: { project, dry_run: dryRun, request_id: requestId },
    org_id: audit.org_id,
    triggered_by_agent_id: audit.triggered_by_agent_id,
    session_id: audit.session_id,
    parent_run_id: audit.parent_run_id,
  });

  // ─── Step 2: acquire merge_lock ─────────────────────────────────────────
  let lock: LockAcquireResult;
  try {
    lock = await acquireMergeLock(project, audit.triggered_by_agent_id || "conductor", requestId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeConductorStep({
      mode: "merge",
      project,
      step: 2,
      step_name: "acquire_lock_error",
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
      error: msg,
      duration_ms: Date.now() - startedAt,
    });
    return json({ merged: false, blocked: true, reason: "lock_error", message: msg }, 500);
  }
  if (!lock.ok) {
    if (lock.stale) {
      await createFuse({
        kind: "merge_lock_jam",
        project,
        detail: `Merge lock held by ${lock.heldBy ?? "unknown"} since ${lock.heldAt ?? "unknown"} (>10min)`,
        severity: "critical",
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        proposed_resolution: "Verify holder is dead, then DELETE FROM nous.merge_locks WHERE project=$1",
        auto_resolution_path: "operator-manual",
      });
    }
    await writeConductorStep({
      mode: "merge",
      project,
      step: 2,
      step_name: "acquire_lock_blocked",
      step_output: { lock_held_by: lock.heldBy, lock_held_at: lock.heldAt, age_ms: lock.ageMs, stale: lock.stale ?? false },
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
      duration_ms: Date.now() - startedAt,
    });
    return json(
      {
        merged: false,
        blocked: true,
        reason: lock.stale ? "merge_lock_jam" : "lock_held",
        lock_held_by: lock.heldBy,
        lock_held_at: lock.heldAt,
      },
      409,
    );
  }

  // From here every return path must release the lock.
  try {
    // ─── Step 3: read staging diff ────────────────────────────────────────
    const compare = await compareCommits(owner, repoName, "main", "staging");

    // Sentinel amendment (AC04): explicit empty-diff guard. GitHub's compare
    // endpoint may report ahead_by=0 while still echoing a base_commit;
    // proceeding to step 5 in that state would hit a 409 from /merges and
    // pollute conductor_log with a misleading failure. Short-circuit cleanly.
    if (compare.ahead_by === 0 || compare.total_commits === 0) {
      await writeConductorStep({
        mode: "merge",
        project,
        step: 3,
        step_name: "diff_empty",
        step_output: {
          status: compare.status,
          ahead_by: compare.ahead_by,
          total_commits: compare.total_commits,
        },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        duration_ms: Date.now() - startedAt,
      });
      return json({
        merged: false,
        reason: "no_changes_to_merge",
        commits_merged: 0,
        ahead_by: compare.ahead_by,
      });
    }

    const clauseIds = extractClauseIds(compare.commits.map((c) => c.commit.message));
    await writeConductorStep({
      mode: "merge",
      project,
      step: 3,
      step_name: "diff_read",
      step_output: { commits: compare.total_commits, clause_ids: clauseIds },
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
    });

    // ─── Step 4: validate all clauses verified (VETO gate) ────────────────
    const failingClauses: string[] = [];
    for (const cid of clauseIds) {
      const { data: latest, error: latestErr } = await sb
        .from("conductor_log")
        .select("verdict, created_at")
        .eq("clause_id", cid)
        .eq("mode", "verify")
        .not("verdict", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestErr) {
        await writeConductorStep({
          mode: "merge",
          project,
          clause_id: cid,
          step: 4,
          step_name: "verdict_lookup_failed",
          error: latestErr.message,
          org_id: audit.org_id,
          triggered_by_agent_id: audit.triggered_by_agent_id,
          session_id: audit.session_id,
          parent_run_id: audit.parent_run_id,
          duration_ms: Date.now() - startedAt,
        });
        return json(
          { merged: false, blocked: true, reason: "verdict_lookup_failed", clause_id: cid },
          500,
        );
      }
      const verdict = (latest as { verdict?: string | null } | null)?.verdict ?? null;
      if (verdict !== "pass") failingClauses.push(cid);
    }

    if (failingClauses.length > 0) {
      // VETO. Release lock and return blocked. Per AC, response carries
      // reason='failing_acs' + the offending clause list.
      await writeConductorStep({
        mode: "merge",
        project,
        step: 4,
        step_name: "veto_failing_acs",
        verdict: "block",
        step_output: { failing_clauses: failingClauses, clauses_checked: clauseIds.length },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        duration_ms: Date.now() - startedAt,
      });
      return json({
        merged: false,
        blocked: true,
        reason: "failing_acs",
        failing_clauses: failingClauses,
      });
    }

    if (dryRun) {
      await writeConductorStep({
        mode: "merge",
        project,
        step: 4,
        step_name: "dry_run_pass",
        verdict: "pass",
        step_output: { clauses_checked: clauseIds.length },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        duration_ms: Date.now() - startedAt,
      });
      return json({
        merged: false,
        reason: "dry_run",
        commits_merged: compare.total_commits,
        clause_ids: clauseIds,
      });
    }

    // ─── Step 5: execute GitHub merge ─────────────────────────────────────
    const mergeRes = await ghMerge(owner, repoName, "main", "staging");
    if (mergeRes.status === 204) {
      // main already contains staging; nothing to do.
      await writeConductorStep({
        mode: "merge",
        project,
        step: 5,
        step_name: "github_merge_noop",
        step_output: { status: 204 },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        duration_ms: Date.now() - startedAt,
      });
      return json({ merged: false, reason: "already_up_to_date", commits_merged: 0 });
    }
    if (!mergeRes.created || !mergeRes.sha) {
      await writeConductorStep({
        mode: "merge",
        project,
        step: 5,
        step_name: "github_merge_failed",
        error: `status=${mergeRes.status} body=${(mergeRes.rawText ?? "").slice(0, 300)}`,
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
        duration_ms: Date.now() - startedAt,
      });
      return json(
        { merged: false, blocked: true, reason: "github_merge_failed", status: mergeRes.status },
        502,
      );
    }
    const mergeSha = mergeRes.sha;
    await writeConductorStep({
      mode: "merge",
      project,
      step: 5,
      step_name: "github_merge_created",
      step_output: { merge_sha: mergeSha, commits_merged: compare.total_commits },
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
    });

    // ─── Step 6: wait for Vercel build ────────────────────────────────────
    let vercelState: string | null = null;
    let vercelUrl: string | null = null;
    let vercelPollTimedOut = false;
    if (isVercelTarget(canonicalVercelProject, deployTarget)) {
      const projectKey = canonicalVercelProject || project;
      const vercelPollStartedAt = Date.now();
      const polled = await pollVercelDeployment(projectKey, mergeSha);
      const vercelPollElapsedMs = Date.now() - vercelPollStartedAt;
      vercelState = polled.state;
      vercelUrl = polled.url;
      vercelPollTimedOut = polled.state === "TIMEOUT";

      // Sentinel amendment (AC06-07): explicit timeout escalation. The merge
      // commit already exists on main — we do NOT roll it back or flip the
      // merge result. We only surface a fuse so the operator notices Vercel
      // never reported ready inside the poll window.
      if (vercelPollTimedOut) {
        await createFuse({
          kind: "production_verify_fail",
          project,
          detail: `vercel_poll_timeout: project=${projectKey} sha=${mergeSha.slice(0, 7)} elapsed_ms=${vercelPollElapsedMs} budget_ms=${VERCEL_POLL_MAX_MS}`,
          severity: "critical",
          triggered_by_agent_id: audit.triggered_by_agent_id,
          session_id: audit.session_id,
          parent_run_id: audit.parent_run_id,
          proposed_resolution:
            "Check Vercel dashboard for build status; if still building extend window, else investigate failed/canceled deployment.",
        });
      }

      await writeConductorStep({
        mode: "merge",
        project,
        step: 6,
        step_name: polled.ready
          ? "vercel_ready"
          : vercelPollTimedOut
            ? "vercel_poll_timeout"
            : "vercel_not_ready",
        step_output: {
          state: polled.state,
          url: polled.url,
          elapsed_ms: vercelPollElapsedMs,
          budget_ms: VERCEL_POLL_MAX_MS,
          timed_out: vercelPollTimedOut,
        },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
      });
    } else {
      await writeConductorStep({
        mode: "merge",
        project,
        step: 6,
        step_name: "vercel_skipped",
        step_output: { reason: "deploy_target not vercel", deploy_target: deployTarget },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
      });
    }

    // ─── Step 7: production verification ──────────────────────────────────
    let productionVerified = false;
    let productionStatus: number | null = null;
    if (deployTarget) {
      const v = await verifyProductionUrl(deployTarget);
      productionVerified = v.ok;
      productionStatus = v.status;
      if (!productionVerified) {
        await createFuse({
          kind: "production_verify_fail",
          project,
          detail: `HEAD ${deployTarget} returned ${productionStatus ?? "fetch_error"} after merge ${mergeSha.slice(0, 7)}`,
          severity: "critical",
          triggered_by_agent_id: audit.triggered_by_agent_id,
          session_id: audit.session_id,
          parent_run_id: audit.parent_run_id,
        });
      }
      await writeConductorStep({
        mode: "merge",
        project,
        step: 7,
        step_name: productionVerified ? "production_verified" : "production_unverified",
        step_output: { url: deployTarget, status: productionStatus },
        org_id: audit.org_id,
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id,
      });
    }

    // ─── Step 8: stamp shipped + fire event ───────────────────────────────
    await stampShippedAndEmit(clauseIds, mergeSha, project, audit);
    await writeConductorStep({
      mode: "merge",
      project,
      step: 8,
      step_name: "shipped_stamped",
      step_output: { clause_ids: clauseIds, merge_sha: mergeSha },
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
    });

    // ─── Step 9: log success (lock release happens in finally) ────────────
    await writeConductorStep({
      mode: "merge",
      project,
      step: 9,
      step_name: "merge_complete",
      verdict: "pass",
      step_output: {
        merge_sha: mergeSha,
        commits_merged: compare.total_commits,
        clause_ids: clauseIds,
        production_verified: productionVerified,
        production_url: deployTarget,
        vercel_state: vercelState,
        vercel_url: vercelUrl,
        vercel_poll_timed_out: vercelPollTimedOut,
      },
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
      duration_ms: Date.now() - startedAt,
    });

    return json({
      merged: true,
      reason: "ok",
      commits_merged: compare.total_commits,
      merge_sha: mergeSha,
      clause_ids: clauseIds,
      production_verified: productionVerified,
      production_url: deployTarget,
      vercel_poll_timed_out: vercelPollTimedOut,
    });
  } catch (err) {
    // Lock release happens in finally; here we only log + respond.
    const msg = err instanceof Error ? err.message : String(err);
    await writeConductorStep({
      mode: "merge",
      project,
      step: 0,
      step_name: "merge_internal_error",
      error: msg,
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id,
      duration_ms: Date.now() - startedAt,
    }).catch(() => {/* logging is best-effort here */});
    return json({ merged: false, blocked: true, reason: "internal_error", message: msg }, 500);
  } finally {
    // Single release point — covers success, every early return in try, and
    // the catch branch. Scoped by request_id so we never clear a peer's lock.
    await releaseLock(project, requestId);
  }
}
