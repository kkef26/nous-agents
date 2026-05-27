// supabase/functions/conductor/tactical_amend.ts
//
// AGT.1.1.5 — Structured hint dispatch with retry cap.
//
// When verify.ts (AGT.1.1.2) returns verdict='fail_tactical', this module
// builds a structured amendment hint and re-dispatches the clause through
// POST /dispatch/tree with parent_dispatch_id + incremented attempt_count.
//
// Hard cap: retry_count <= 2. On the third tactical failure we INSERT into
// nous.amendment_queue with source_action='strategic_escalation' and fire
// a 'tactical_retry_exhausted' fuse. Scoper (Mode B/C) picks up from there.
//
// Tactical amendments fix shallow problems (typos, missed edge cases).
// Anything structural escalates to Scoper for rescoping.

import { getSupabaseClient } from "./lib/common/db.js";
import { createFuse } from "./fuse_manager.js";

// ─── Public types ───────────────────────────────────────────────────────────

/** Single acceptance-criterion row, as carried in the failing_acs payload. */
export interface ACRow {
  id?: string;
  text: string;
  verification?: "auto" | "physical_qa" | "kosta_review";
  status?: "pass" | "fail" | "skipped";
  detail?: string;
}

export interface TacticalAmendOpts {
  clause_id: string;
  parent_dispatch_id: string;
  attempt_count: number;
  sentinel_notes: string;
  amendments_suggested: string[];
  failing_acs: ACRow[];
  pillar_failures: string[];
}

export interface TacticalAmendResult {
  retry_dispatched: boolean;
  new_dispatch_id?: string;
  escalated_to_scoper?: boolean;
  amendment_queue_id?: string;
  reason: string;
}

// ─── Local DB extension (amendment_queue + dispatch_queue) ──────────────────
// Mirrors the pattern in fuse_manager.ts: extend NousDatabase locally and cast
// the shared client through `unknown`. Collapses once these tables land in
// the canonical NousDatabase type.

interface AmendmentQueueInsert {
  clause_id: string | null;
  feature_id: string | null;
  project: string | null;
  source_action: string;
  audit_item_id: string;
  observations: unknown;
  reason: string | null;
  tag: string | null;
  status?: string;
  created_by: string;
  owner?: string;
}

interface AmendmentQueueRow extends AmendmentQueueInsert {
  id: string;
  created_at: string;
  updated_at: string;
}

interface DispatchQueueProjectRow {
  id: string;
  project: string | null;
  feature_id: string | null;
  clause_id: string | null;
}

// Untyped — amendment_queue + dispatch_queue aren't enumerated in NousDatabase
// and the v2 supabase-js schema-generic collapses to `never` here regardless.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  return getSupabaseClient();
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Hard cap on tactical retries. AC #8: enforced in code, no path bypasses. */
const MAX_TACTICAL_ATTEMPTS = 2;

const STRATEGIC_ESCALATION = "strategic_escalation";
const CREATED_BY = "conductor-tactical-amend";

// ─── Helpers ────────────────────────────────────────────────────────────────

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`tactical_amend: missing required env var ${name}`);
  }
  return v;
}

/** Max attempts for transient DB / network retry loops. */
const DB_RETRY_MAX_ATTEMPTS = 3;
/** Base delay for exponential backoff in ms (100, 200, 400). */
const DB_RETRY_BASE_DELAY_MS = 100;

/**
 * Run `fn` with exponential backoff. Used to insulate the conductor from
 * transient Supabase / network blips (dropped pool connections, brief 5xx).
 * Logs each retry; on final failure, rethrows the original error so callers
 * see the underlying message.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number = DB_RETRY_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delayMs = DB_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `tactical_amend.${label}: attempt ${attempt}/${maxAttempts} failed, ` +
          `retrying in ${delayMs}ms — ${msg}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(
    `tactical_amend.${label}: failed after ${maxAttempts} attempts`,
  );
}

async function lookupProject(parent_dispatch_id: string): Promise<{
  project: string;
  feature_id: string | null;
}> {
  return await withRetry("lookupProject", async () => {
    const { data, error } = await db()
      .from("dispatch_queue")
      .select("project, feature_id")
      .eq("id", parent_dispatch_id)
      .maybeSingle();
    if (error) {
      throw new Error(
        `tactical_amend.lookupProject: select failed — ${error.message}`,
      );
    }
    return {
      project: data?.project ?? "unknown",
      feature_id: data?.feature_id ?? null,
    };
  });
}

/**
 * Typed guard for /dispatch/tree response. Returns the extracted dispatch_id
 * if the payload matches one of the three accepted shapes, otherwise null.
 *
 * Accepted shapes:
 *   { dispatch_id: string }           // single-clause shortcut
 *   { dispatch_ids: string[] }        // multi-clause
 *   { tasks: [{ id: string, ... }] }  // legacy/task envelope
 *
 * A `null` return is the caller's signal to fire a `compile_fail` fuse and
 * abort the retry — silently dropping new_dispatch_id would let the verify
 * loop think a retry succeeded when nothing actually ran.
 */
function parseDispatchResponse(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  if (typeof obj.dispatch_id === "string" && obj.dispatch_id.length > 0) {
    return obj.dispatch_id;
  }
  if (Array.isArray(obj.dispatch_ids)) {
    const first = obj.dispatch_ids[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  if (Array.isArray(obj.tasks)) {
    const first = obj.tasks[0] as { id?: unknown } | undefined;
    if (first && typeof first.id === "string" && first.id.length > 0) {
      return first.id;
    }
  }
  return null;
}

/**
 * Compose the structured hint payload that downstream Cowork reads as
 * "what was wrong last time + what to try this time". Plain prose so the
 * worker model can consume it without any schema-specific parsing.
 */
function buildHintPayload(opts: TacticalAmendOpts): {
  prose: string;
  structured: Record<string, unknown>;
} {
  const lines: string[] = [];
  lines.push(`## Prior attempt feedback (attempt ${opts.attempt_count})`);
  lines.push("");

  if (opts.sentinel_notes && opts.sentinel_notes.trim() !== "") {
    lines.push("### Sentinel notes");
    lines.push(opts.sentinel_notes.trim());
    lines.push("");
  }

  if (opts.pillar_failures.length > 0) {
    lines.push("### Failed pillars");
    for (const p of opts.pillar_failures) lines.push(`- ${p}`);
    lines.push("");
  }

  if (opts.failing_acs.length > 0) {
    lines.push("### Failing acceptance criteria");
    for (const ac of opts.failing_acs) {
      const tag = ac.id ? `[${ac.id}] ` : "";
      const detail = ac.detail ? ` — ${ac.detail}` : "";
      lines.push(`- ${tag}${ac.text}${detail}`);
    }
    lines.push("");
  }

  if (opts.amendments_suggested.length > 0) {
    lines.push("### Suggested amendments");
    for (const a of opts.amendments_suggested) lines.push(`- ${a}`);
    lines.push("");
  }

  return {
    prose: lines.join("\n"),
    structured: {
      sentinel_notes: opts.sentinel_notes,
      pillar_failures: opts.pillar_failures,
      failing_acs: opts.failing_acs,
      amendments_suggested: opts.amendments_suggested,
    },
  };
}

// ─── Strategic escalation (cap hit) ─────────────────────────────────────────

async function escalateToScoper(
  opts: TacticalAmendOpts,
  project: string,
  featureId: string | null,
  hint: ReturnType<typeof buildHintPayload>,
): Promise<TacticalAmendResult> {
  const observations = {
    parent_dispatch_id: opts.parent_dispatch_id,
    attempt_count: opts.attempt_count,
    sentinel_notes: opts.sentinel_notes,
    pillar_failures: opts.pillar_failures,
    failing_acs: opts.failing_acs,
    amendments_suggested: opts.amendments_suggested,
    hint_prose: hint.prose,
  };

  const insertRow: AmendmentQueueInsert = {
    clause_id: opts.clause_id,
    feature_id: featureId,
    project,
    source_action: STRATEGIC_ESCALATION,
    audit_item_id: opts.parent_dispatch_id,
    observations,
    reason: "retry_cap_exhausted",
    tag: STRATEGIC_ESCALATION,
    status: "pending",
    created_by: CREATED_BY,
    owner: "scoper",
  };

  const inserted = await withRetry("escalateToScoper.insert", async () => {
    const { data, error } = await db()
      .from("amendment_queue")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) {
      throw new Error(
        `tactical_amend.escalateToScoper: insert failed — ${error.message}`,
      );
    }
    return data;
  });

  const amendment_queue_id = inserted.id;

  await createFuse({
    kind: "tactical_retry_exhausted",
    project,
    detail:
      `Tactical retry cap (${MAX_TACTICAL_ATTEMPTS}) reached on clause ` +
      `${opts.clause_id} after parent_dispatch_id=${opts.parent_dispatch_id}. ` +
      `Escalating to Scoper. amendment_queue.id=${amendment_queue_id}.`,
    severity: "blocking",
    clause_id: opts.clause_id,
    feature_id: featureId ?? undefined,
    triggered_by_agent_id: CREATED_BY,
    parent_run_id: opts.parent_dispatch_id,
    proposed_resolution:
      "Scoper Mode B/C rescoping — the clause as written cannot be " +
      "satisfied by tactical hints alone.",
    auto_resolution_path: `amendment_queue.id=${amendment_queue_id}`,
    kosta_escalation_path:
      "Surface in decision_queue if Scoper produces no plan within 1 wave.",
  });

  return {
    retry_dispatched: false,
    escalated_to_scoper: true,
    amendment_queue_id,
    reason: "retry_cap_exhausted",
  };
}

// ─── Tactical retry (under cap) ─────────────────────────────────────────────

async function dispatchRetry(
  opts: TacticalAmendOpts,
  project: string,
  featureId: string | null,
  hint: ReturnType<typeof buildHintPayload>,
): Promise<TacticalAmendResult> {
  const nousUrl = readEnv("NOUS_URL").replace(/\/$/, "");
  const nousKey = readEnv("NOUS_API_KEY");

  const body = {
    clause_ids: [opts.clause_id],
    context: {
      parent_dispatch_id: opts.parent_dispatch_id,
      attempt_count: opts.attempt_count + 1,
      amendment_hints: {
        prose: hint.prose,
        ...hint.structured,
      },
    },
  };

  const res = await fetch(`${nousUrl}/dispatch/tree`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": nousKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "<no body>");
    throw new Error(
      `tactical_amend.dispatchRetry: /dispatch/tree returned ${res.status} — ${txt}`,
    );
  }

  const rawText = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch (_e) {
    json = null;
  }

  const new_dispatch_id = parseDispatchResponse(json);

  if (new_dispatch_id === null) {
    // Response shape is none of { dispatch_id }, { dispatch_ids[] }, { tasks[] }.
    // Fire a compile_fail fuse so the conductor surface flags it loudly instead
    // of silently returning retry_dispatched:true with no usable dispatch_id.
    const snippet = rawText.length > 0
      ? rawText.slice(0, 500)
      : "<empty body>";
    console.error(
      `tactical_amend.dispatchRetry: dispatch_response_malformed — ` +
        `status=${res.status} body=${snippet}`,
    );
    await createFuse({
      kind: "compile_fail",
      project,
      detail:
        `dispatch_response_malformed: POST ${nousUrl}/dispatch/tree returned ` +
        `HTTP ${res.status} with a payload that matched none of the accepted ` +
        `shapes ({dispatch_id} | {dispatch_ids[]} | {tasks[{id}]}). ` +
        `Body snippet: ${snippet}`,
      severity: "critical",
      clause_id: opts.clause_id,
      feature_id: featureId ?? undefined,
      triggered_by_agent_id: CREATED_BY,
      parent_run_id: opts.parent_dispatch_id,
      proposed_resolution:
        "Inspect nous-edge /dispatch/tree response contract and align " +
        "either the producer or parseDispatchResponse() guard.",
    });
    throw new Error(
      `tactical_amend.dispatchRetry: /dispatch/tree returned a payload ` +
        `that did not contain a usable dispatch_id (shape mismatch). ` +
        `Fired compile_fail fuse. Body snippet: ${snippet}`,
    );
  }

  return {
    retry_dispatched: true,
    new_dispatch_id,
    reason: `tactical_retry_attempt_${opts.attempt_count + 1}`,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Decide whether to dispatch a tactical retry or escalate to Scoper, then
 * execute that path. Returns the disposition for the caller (verify.ts).
 *
 * Hard cap: opts.attempt_count >= MAX_TACTICAL_ATTEMPTS triggers escalation.
 * No path bypasses this check.
 */
export async function tacticalAmend(
  opts: TacticalAmendOpts,
): Promise<TacticalAmendResult> {
  if (!opts.clause_id || opts.clause_id.trim() === "") {
    throw new Error("tactical_amend: clause_id is required");
  }
  if (!opts.parent_dispatch_id || opts.parent_dispatch_id.trim() === "") {
    throw new Error("tactical_amend: parent_dispatch_id is required");
  }
  if (typeof opts.attempt_count !== "number" || opts.attempt_count < 0) {
    throw new Error("tactical_amend: attempt_count must be a non-negative number");
  }

  const { project, feature_id } = await lookupProject(opts.parent_dispatch_id);
  const hint = buildHintPayload(opts);

  if (opts.attempt_count >= MAX_TACTICAL_ATTEMPTS) {
    return await escalateToScoper(opts, project, feature_id, hint);
  }

  return await dispatchRetry(opts, project, feature_id, hint);
}
