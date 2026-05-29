// hetzner/scoper/src/deploy.ts
// PIPE.CLEANUP — Self-deploy endpoint for Hetzner services.
// POST /deploy { service: "scoper" | "conductor", api_key: string }
//
// Runs: git pull → npm install → tsc → pm2 reload → health check
// Proxied via nous-edge: POST /nous/scoper/deploy
//
// Safety: checks active dispatches before restarting. Refuses if workers
// are in-flight unless force=true.

import { execSync } from "child_process";
import { getSupabaseClient } from "./lib/common/db.js";

const NOUS_API_KEY = process.env.NOUS_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const REPO_ROOT = process.env.REPO_ROOT || "/opt/nous-agents";
const HETZNER_DIR = `${REPO_ROOT}/hetzner`;

interface DeployRequest {
  service?: string;
  api_key?: string;
  force?: boolean;
  branch?: string;
}

interface DeployStep {
  step: string;
  ok: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
}

function run(cmd: string, cwd?: string, timeoutSec = 60): { stdout: string; ok: boolean; error?: string } {
  try {
    const stdout = execSync(cmd, {
      cwd: cwd || REPO_ROOT,
      timeout: timeoutSec * 1000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return { stdout: "", ok: false, error: (e.stderr || e.message || String(err)).slice(0, 500) };
  }
}

async function checkActiveDispatches(): Promise<{ active: number; details: string[] }> {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from("dispatch_queue")
      .select("id, clause_id, status")
      .in("status", ["claimed", "running"]);
    if (error) return { active: 0, details: [`query error: ${error.message}`] };
    const rows = (data || []) as Array<{ id: string; clause_id: string; status: string }>;
    return {
      active: rows.length,
      details: rows.map(r => `${r.clause_id} (${r.status})`),
    };
  } catch (err) {
    return { active: 0, details: [`check failed: ${(err as Error).message}`] };
  }
}

export async function handleDeploy(req: Request): Promise<Response> {
  let body: DeployRequest;
  try {
    body = await req.json() as DeployRequest;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  // Auth check
  const apiKey = body.api_key || req.headers.get("x-api-key") || "";
  if (!apiKey || (apiKey !== NOUS_API_KEY && apiKey !== process.env.NOUS_API_KEY)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const service = body.service || "scoper";
  if (service !== "scoper" && service !== "conductor") {
    return new Response(JSON.stringify({ error: "service must be 'scoper' or 'conductor'" }), { status: 400 });
  }

  const branch = body.branch || "staging";
  const force = body.force === true;
  const steps: DeployStep[] = [];

  // Step 1: Check active dispatches
  const t0 = Date.now();
  const dispatches = await checkActiveDispatches();
  steps.push({
    step: "check_dispatches",
    ok: dispatches.active === 0 || force,
    output: `${dispatches.active} active dispatches`,
    duration_ms: Date.now() - t0,
  });

  if (dispatches.active > 0 && !force) {
    return new Response(JSON.stringify({
      error: "workers_active",
      active_dispatches: dispatches.active,
      details: dispatches.details,
      hint: "Pass force=true to deploy anyway, or wait for workers to finish",
      steps,
    }), { status: 409 });
  }

  // Step 2: Git fetch + checkout
  const t1 = Date.now();
  const gitFetch = run(`git fetch origin ${branch}`, REPO_ROOT);
  const gitCheckout = run(`git checkout origin/${branch} -- hetzner/${service}/`, REPO_ROOT);
  steps.push({
    step: "git_pull",
    ok: gitFetch.ok && gitCheckout.ok,
    output: gitCheckout.ok ? `checked out hetzner/${service}/ from origin/${branch}` : undefined,
    error: gitFetch.error || gitCheckout.error,
    duration_ms: Date.now() - t1,
  });
  if (!gitFetch.ok || !gitCheckout.ok) {
    return new Response(JSON.stringify({ error: "git_failed", steps }), { status: 500 });
  }

  // Also pull shared/ if it exists
  run(`git checkout origin/${branch} -- hetzner/shared/ 2>/dev/null || true`, REPO_ROOT);

  // Step 3: npm install
  const svcDir = `${HETZNER_DIR}/${service}`;
  const t2 = Date.now();
  const npmResult = run("npm install --no-audit --no-fund", svcDir, 120);
  steps.push({
    step: "npm_install",
    ok: npmResult.ok,
    output: npmResult.ok ? "dependencies installed" : undefined,
    error: npmResult.error,
    duration_ms: Date.now() - t2,
  });
  if (!npmResult.ok) {
    return new Response(JSON.stringify({ error: "npm_failed", steps }), { status: 500 });
  }

  // Step 4: TypeScript compile
  const t3 = Date.now();
  const tscResult = run("npx tsc", svcDir, 60);
  steps.push({
    step: "tsc_compile",
    ok: tscResult.ok,
    output: tscResult.ok ? "compiled successfully" : undefined,
    error: tscResult.error,
    duration_ms: Date.now() - t3,
  });
  if (!tscResult.ok) {
    return new Response(JSON.stringify({ error: "tsc_failed", steps }), { status: 500 });
  }

  // Step 5: PM2 graceful reload (not restart — keeps old process until new one is ready)
  const t4 = Date.now();
  const pm2Result = run(`pm2 reload ${service} --update-env`, svcDir, 30);
  steps.push({
    step: "pm2_reload",
    ok: pm2Result.ok,
    output: pm2Result.ok ? `${service} reloaded` : undefined,
    error: pm2Result.error,
    duration_ms: Date.now() - t4,
  });

  // Step 6: Health check (wait 2s for process to start)
  const t5 = Date.now();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const port = service === "scoper" ? 8090 : 8091;
  const healthResult = run(`curl -fsS http://localhost:${port}/health`, undefined, 5);
  steps.push({
    step: "health_check",
    ok: healthResult.ok,
    output: healthResult.stdout,
    error: healthResult.error,
    duration_ms: Date.now() - t5,
  });

  const allOk = steps.every(s => s.ok);
  return new Response(JSON.stringify({
    ok: allOk,
    service,
    branch,
    steps,
    deployed_at: new Date().toISOString(),
  }), { status: allOk ? 200 : 500 });
}
