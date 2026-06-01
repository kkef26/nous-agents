// hetzner/scoper/src/audit.ts
// POST /audit — deterministic Pocock codebase quality audit
// Clones a repo, runs jscpd + 8 grep metrics, scores with exemptions, stores in nous.pocock_audits.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@supabase/supabase-js";

const RUNNER_VERSION = "pocock-audit-v1";

// ── Scoring rubric (weights sum to 100) ──────────────────────────────────────
interface Band { max: number; score: number }
interface MetricDef {
  key: string;
  weight: number;
  bands: Band[];            // ordered ascending by max; first match wins
  useEffective?: boolean;   // subtract exempt from raw before banding
}

const METRICS: MetricDef[] = [
  { key: "clone_groups", weight: 20, bands: [
    { max: 0, score: 100 }, { max: 5, score: 85 }, { max: 15, score: 70 },
    { max: 30, score: 50 }, { max: 50, score: 30 }, { max: Infinity, score: 0 },
  ]},
  { key: "hex", weight: 15, useEffective: true, bands: [
    { max: 0, score: 100 }, { max: 5, score: 85 }, { max: 15, score: 60 },
    { max: 30, score: 40 }, { max: Infinity, score: 0 },
  ]},
  { key: "bare_stores", weight: 5, bands: [
    { max: 0, score: 100 }, { max: 3, score: 40 }, { max: Infinity, score: 0 },
  ]},
  { key: "inline_styles", weight: 15, useEffective: true, bands: [
    { max: 0, score: 100 }, { max: 5, score: 85 }, { max: 20, score: 50 },
    { max: Infinity, score: 0 },
  ]},
  { key: "imports", weight: 10, bands: [
    // special: scored by alias percentage, not raw count
    { max: -1, score: 0 },  // placeholder — computed separately
  ]},
  { key: "file_size", weight: 10, useEffective: true, bands: [
    { max: 0, score: 100 }, { max: 3, score: 70 }, { max: Infinity, score: 40 },
  ]},
  { key: "any_types", weight: 15, useEffective: true, bands: [
    { max: 0, score: 100 }, { max: 3, score: 85 }, { max: 10, score: 50 },
    { max: Infinity, score: 0 },
  ]},
  { key: "console_log", weight: 10, bands: [
    { max: 0, score: 100 }, { max: 5, score: 70 }, { max: 20, score: 40 },
    { max: Infinity, score: 0 },
  ]},
];

function bandScore(value: number, bands: Band[]): number {
  for (const b of bands) {
    if (value <= b.max) return b.score;
  }
  return 0;
}

function importScore(aliasPct: number): number {
  if (aliasPct >= 99) return 100;
  if (aliasPct >= 95) return 85;
  if (aliasPct >= 80) return 70;
  if (aliasPct >= 50) return 40;
  return 0;
}

function grade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 75) return "B";
  if (score >= 70) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  if (score >= 50) return "C-";
  if (score >= 40) return "D";
  return "F";
}

// ── Exemption helpers ────────────────────────────────────────────────────────

interface PocockRules {
  src_dir?: string;
  hex_exempt_files?: string[];
  hex_exempt_patterns?: string[];
  any_exempt_patterns?: string[];
  files_over_400_exempt?: string[];
  inline_dynamic_patterns?: string[];
  score_target?: number;
  clone_target?: number;
}

function grepLines(dir: string, pattern: string, include: string): string[] {
  try {
    const out = execSync(
      `grep -rn '${pattern}' --include='${include}' ${dir} 2>/dev/null || true`,
      { encoding: "utf-8", maxBuffer: 10_000_000 }
    );
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

function countGrep(dir: string, pattern: string, include: string): number {
  return grepLines(dir, pattern, include).length;
}

function isExemptFile(line: string, exemptFiles: string[], exemptPatterns: string[]): boolean {
  const lower = line.toLowerCase();
  for (const f of exemptFiles) {
    if (lower.includes(f.toLowerCase())) return true;
  }
  for (const p of exemptPatterns) {
    if (lower.includes(p.toLowerCase())) return true;
  }
  return false;
}

// ── Main audit runner ────────────────────────────────────────────────────────

interface AuditRequest {
  project: string;
  repo?: string;       // override; otherwise looked up from nous.projects
  branch?: string;
  triggered_by?: string;
}

interface AuditResult {
  ok: boolean;
  project: string;
  repo: string;
  branch: string;
  commit_sha: string;
  score: number;
  grade: string;
  metric_scores: Record<string, { raw: number; exempt: number; effective: number; points: number; weighted: number }>;
  clone_groups: number;
  clone_lines: number;
  clone_pct: number;
  violations: Array<{ metric: string; file: string; line?: number; detail?: string }>;
  clone_pairs: Array<{ file1: string; lines1: string; file2: string; lines2: string }>;
  total_files: number;
  total_lines: number;
  duration_ms: number;
  runner_version: string;
  audit_id?: string;
}

export async function runPocockAudit(req: AuditRequest): Promise<AuditResult> {
  const start = Date.now();

  // 1. Look up project in DB
  const sb = createClient(
    process.env.SUPABASE_URL || "https://oozlawunlkkuaykfunan.supabase.co",
    process.env.SUPABASE_SERVICE_KEY || process.env.NOUS_SERVICE_KEY || ""
  );

  let repo = req.repo || "";
  let rules: PocockRules = {};

  if (!repo) {
    const { data: proj } = await sb
      .from("projects")
      .select("canonical_repo, pocock_rules")
      .or(`tag.eq.${req.project},aliases.cs.{${req.project}}`)
      .limit(1)
      .single();

    if (proj?.canonical_repo) repo = proj.canonical_repo;
    if (proj?.pocock_rules) rules = proj.pocock_rules as PocockRules;
  }

  if (!repo) throw new Error(`No canonical_repo found for project '${req.project}'`);

  const branch = req.branch || "main";
  const srcDir = rules.src_dir || "src";

  // 2. Clone repo to temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), "pocock-"));
  const repoDir = join(tmpDir, "repo");

  try {
    const ghPat = process.env.GITHUB_PAT || process.env.GITHUB_PAT_KKEF26 || "";
    const cloneUrl = `https://${ghPat}@github.com/${repo}.git`;
    execSync(`git clone --depth 1 --branch ${branch} ${cloneUrl} ${repoDir}`, {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });

    // Get commit SHA
    const commitSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    const src = join(repoDir, srcDir);
    if (!existsSync(src)) throw new Error(`src_dir '${srcDir}' not found in repo`);

    // 3. Count total files and lines
    const totalFiles = parseInt(
      execSync(`find ${src} \\( -name '*.ts' -o -name '*.tsx' \\) | wc -l`, { encoding: "utf-8" }).trim()
    ) || 0;
    const totalLines = parseInt(
      execSync(`find ${src} \\( -name '*.ts' -o -name '*.tsx' \\) -exec cat {} + | wc -l`, { encoding: "utf-8" }).trim()
    ) || 0;

    // ── Metric 1: Clone detection (jscpd) ────────────────────────────────
    let cloneGroups = 0, cloneLines = 0, clonePct = 0;
    const clonePairs: AuditResult["clone_pairs"] = [];

    try {
      execSync("which jscpd || npm install -g jscpd@4", { encoding: "utf-8", stdio: "pipe", timeout: 30_000 });
      const jscpdOut = execSync(
        `jscpd ${src} --min-lines 5 --min-tokens 50 --format "typescript,typescriptreact" --reporters json 2>/dev/null || true`,
        { encoding: "utf-8", maxBuffer: 10_000_000, timeout: 120_000 }
      );

      // jscpd writes to report/jscpd-report.json
      const reportPath = join(repoDir, "report", "jscpd-report.json");
      if (existsSync(reportPath)) {
        const report = JSON.parse(execSync(`cat ${reportPath}`, { encoding: "utf-8" }));
        cloneGroups = report.statistics?.total?.clones || 0;
        cloneLines = report.statistics?.total?.duplicatedLines || 0;
        const totalDetectedLines = report.statistics?.total?.lines || totalLines;
        clonePct = totalDetectedLines > 0 ? parseFloat(((cloneLines / totalDetectedLines) * 100).toFixed(2)) : 0;

        for (const dup of (report.duplicates || [])) {
          clonePairs.push({
            file1: dup.firstFile?.name?.replace(repoDir + "/", "") || "",
            lines1: `${dup.firstFile?.startLoc?.line}-${dup.firstFile?.endLoc?.line}`,
            file2: dup.secondFile?.name?.replace(repoDir + "/", "") || "",
            lines2: `${dup.secondFile?.startLoc?.line}-${dup.secondFile?.endLoc?.line}`,
          });
        }
      }
    } catch (e) {
      // jscpd not available — still score other metrics
      console.error("jscpd failed:", (e as Error).message);
    }

    // ── Metric 2: Hardcoded hex ──────────────────────────────────────────
    const hexExemptFiles = rules.hex_exempt_files || [];
    const hexExemptPatterns = rules.hex_exempt_patterns || ["theme", "palette", "colors.ts", "config", ".css", "tailwind"];

    const hexAllTs = grepLines(src, "#[0-9a-fA-F]\\{3,8\\}", "*.ts");
    const hexAllTsx = grepLines(src, "#[0-9a-fA-F]\\{3,8\\}", "*.tsx");
    const hexAll = [...hexAllTs, ...hexAllTsx];
    const hexExemptCount = hexAll.filter(l => isExemptFile(l, hexExemptFiles, hexExemptPatterns)).length;
    const hexRaw = hexAll.length;

    // ── Metric 3: Bare Zustand create() ──────────────────────────────────
    const bareStores = countGrep(src, "^export const.*= create(", "*.ts") +
                       countGrep(src, "^export const.*= create(", "*.tsx");

    // ── Metric 4: Inline styles ──────────────────────────────────────────
    const inlineAll = grepLines(src, "style={{", "*.tsx");
    const dynamicPatterns = rules.inline_dynamic_patterns || ["style={/* dynamic", "width:", "height:"];
    const inlineDynamic = inlineAll.filter(l => {
      const lower = l.toLowerCase();
      return dynamicPatterns.some(p => lower.includes(p.toLowerCase()));
    }).length;
    const inlineRaw = inlineAll.length;

    // ── Metric 5: Import discipline ──────────────────────────────────────
    const relativeTs = countGrep(src, "from '\\.\\.", "*.ts") + countGrep(src, 'from "\\.\\.',  "*.ts");
    const relativeTsx = countGrep(src, "from '\\.\\.", "*.tsx") + countGrep(src, 'from "\\.\\.',  "*.tsx");
    const relativeImports = relativeTs + relativeTsx;

    const aliasTs = countGrep(src, "from '@/", "*.ts") + countGrep(src, 'from "@/',  "*.ts");
    const aliasTsx = countGrep(src, "from '@/", "*.tsx") + countGrep(src, 'from "@/',  "*.tsx");
    const aliasImports = aliasTs + aliasTsx;

    const totalImports = relativeImports + aliasImports;
    const aliasPct = totalImports > 0 ? (aliasImports / totalImports) * 100 : 100;

    // ── Metric 6: Files over 400 lines ───────────────────────────────────
    const filesOver400Exempt = rules.files_over_400_exempt || [];
    const bigFiles = execSync(
      `find ${src} \\( -name '*.ts' -o -name '*.tsx' \\) -exec wc -l {} + 2>/dev/null | awk '$1 > 400 && !/total/' || true`,
      { encoding: "utf-8" }
    ).trim().split("\n").filter(Boolean);

    const filesOver400Raw = bigFiles.length;
    const filesOver400ExemptCount = bigFiles.filter(l =>
      filesOver400Exempt.some(ex => l.includes(ex))
    ).length;

    // ── Metric 7: :any types ─────────────────────────────────────────────
    const anyExemptPatterns = rules.any_exempt_patterns || [];
    const anyColonTs = grepLines(src, ": any", "*.ts").filter(l => !l.includes(".d.ts"));
    const anyColonTsx = grepLines(src, ": any", "*.tsx");
    const anyAsTs = grepLines(src, "as any", "*.ts").filter(l => !l.includes(".d.ts"));
    const anyAsTsx = grepLines(src, "as any", "*.tsx");
    const anyAll = [...anyColonTs, ...anyColonTsx, ...anyAsTs, ...anyAsTsx];

    const anyExemptCount = anyAll.filter(l =>
      anyExemptPatterns.some(p => l.includes(p))
    ).length;
    // Also exclude comment-only lines mentioning :any
    const anyCommentExempt = anyAll.filter(l => {
      const trimmed = l.substring(l.indexOf(":") + 1).trim();
      return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
    }).length;
    const anyRaw = anyAll.length;
    const anyTotalExempt = anyExemptCount + anyCommentExempt;

    // ── Metric 8: console.log ────────────────────────────────────────────
    const consoleLogs = countGrep(src, "console\\.log", "*.ts") + countGrep(src, "console\\.log", "*.tsx");

    // ── Collect violations ───────────────────────────────────────────────
    const violations: AuditResult["violations"] = [];

    for (const line of hexAll.filter(l => !isExemptFile(l, hexExemptFiles, hexExemptPatterns))) {
      const [fileLine, ...rest] = line.split(":");
      const parts = fileLine.split(":"); // not reliable, re-split
      violations.push({ metric: "hex", file: line.split(":")[0]?.replace(src + "/", ""), line: parseInt(line.split(":")[1]) || 0 });
    }
    for (const line of inlineAll) {
      violations.push({ metric: "inline_style", file: line.split(":")[0]?.replace(src + "/", ""), line: parseInt(line.split(":")[1]) || 0 });
    }
    for (const line of anyAll.filter(l => !anyExemptPatterns.some(p => l.includes(p)))) {
      violations.push({ metric: "any_type", file: line.split(":")[0]?.replace(src + "/", ""), line: parseInt(line.split(":")[1]) || 0 });
    }

    // ── Score ────────────────────────────────────────────────────────────
    const metricScores: AuditResult["metric_scores"] = {};
    let totalScore = 0;

    // Clone groups
    const clonePoints = bandScore(cloneGroups, METRICS[0].bands);
    metricScores["clone_groups"] = { raw: cloneGroups, exempt: 0, effective: cloneGroups, points: clonePoints, weighted: clonePoints * (METRICS[0].weight / 100) };
    totalScore += clonePoints * (METRICS[0].weight / 100);

    // Hex
    const hexEffective = hexRaw - hexExemptCount;
    const hexPoints = bandScore(hexEffective, METRICS[1].bands);
    metricScores["hex"] = { raw: hexRaw, exempt: hexExemptCount, effective: hexEffective, points: hexPoints, weighted: hexPoints * (METRICS[1].weight / 100) };
    totalScore += hexPoints * (METRICS[1].weight / 100);

    // Bare stores
    const storePoints = bandScore(bareStores, METRICS[2].bands);
    metricScores["bare_stores"] = { raw: bareStores, exempt: 0, effective: bareStores, points: storePoints, weighted: storePoints * (METRICS[2].weight / 100) };
    totalScore += storePoints * (METRICS[2].weight / 100);

    // Inline styles
    const inlineEffective = inlineRaw - inlineDynamic;
    const inlinePoints = bandScore(inlineEffective, METRICS[3].bands);
    metricScores["inline_styles"] = { raw: inlineRaw, exempt: inlineDynamic, effective: inlineEffective, points: inlinePoints, weighted: inlinePoints * (METRICS[3].weight / 100) };
    totalScore += inlinePoints * (METRICS[3].weight / 100);

    // Imports
    const importPoints = importScore(aliasPct);
    metricScores["imports"] = { raw: relativeImports, exempt: 0, effective: relativeImports, points: importPoints, weighted: importPoints * (METRICS[4].weight / 100) };
    totalScore += importPoints * (METRICS[4].weight / 100);

    // File size
    const fileSizeEffective = filesOver400Raw - filesOver400ExemptCount;
    const fileSizePoints = bandScore(fileSizeEffective, METRICS[5].bands);
    metricScores["file_size"] = { raw: filesOver400Raw, exempt: filesOver400ExemptCount, effective: fileSizeEffective, points: fileSizePoints, weighted: fileSizePoints * (METRICS[5].weight / 100) };
    totalScore += fileSizePoints * (METRICS[5].weight / 100);

    // :any types
    const anyEffective = anyRaw - anyTotalExempt;
    const anyPoints = bandScore(anyEffective, METRICS[6].bands);
    metricScores["any_types"] = { raw: anyRaw, exempt: anyTotalExempt, effective: anyEffective, points: anyPoints, weighted: anyPoints * (METRICS[6].weight / 100) };
    totalScore += anyPoints * (METRICS[6].weight / 100);

    // Console.log
    const consolePoints = bandScore(consoleLogs, METRICS[7].bands);
    metricScores["console_log"] = { raw: consoleLogs, exempt: 0, effective: consoleLogs, points: consolePoints, weighted: consolePoints * (METRICS[7].weight / 100) };
    totalScore += consolePoints * (METRICS[7].weight / 100);

    const finalScore = parseFloat(totalScore.toFixed(1));
    const finalGrade = grade(finalScore);
    const durationMs = Date.now() - start;

    // ── Store in DB ──────────────────────────────────────────────────────
    const { data: inserted, error: insertErr } = await sb
      .from("pocock_audits")
      .insert({
        project: req.project,
        repo,
        branch,
        commit_sha: commitSha,
        clone_groups: cloneGroups,
        clone_lines: cloneLines,
        clone_pct: clonePct,
        hex_raw: hexRaw,
        hex_exempt: hexExemptCount,
        bare_stores: bareStores,
        inline_styles_raw: inlineRaw,
        inline_styles_dynamic: inlineDynamic,
        relative_imports: relativeImports,
        alias_imports: aliasImports,
        files_over_400_raw: filesOver400Raw,
        files_over_400_exempt: filesOver400ExemptCount,
        any_raw: anyRaw,
        any_exempt: anyTotalExempt,
        console_logs: consoleLogs,
        score: finalScore,
        grade: finalGrade,
        metric_scores: metricScores,
        violations: violations.slice(0, 200), // cap at 200
        clone_pairs: clonePairs,
        exemptions_applied: rules,
        triggered_by: req.triggered_by || "manual",
        duration_ms: durationMs,
        runner_version: RUNNER_VERSION,
        total_files: totalFiles,
        total_lines: totalLines,
      })
      .select("id")
      .single();

    if (insertErr) console.error("Failed to store audit:", insertErr.message);

    return {
      ok: true,
      project: req.project,
      repo,
      branch,
      commit_sha: commitSha,
      score: finalScore,
      grade: finalGrade,
      metric_scores: metricScores,
      clone_groups: cloneGroups,
      clone_lines: cloneLines,
      clone_pct: clonePct,
      violations,
      clone_pairs: clonePairs,
      total_files: totalFiles,
      total_lines: totalLines,
      duration_ms: durationMs,
      runner_version: RUNNER_VERSION,
      audit_id: inserted?.id,
    };

  } finally {
    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Express route handler ────────────────────────────────────────────────────

export async function handleAudit(req: Request): Promise<Response> {
  try {
    const body = await req.json() as AuditRequest;
    if (!body.project) {
      return new Response(JSON.stringify({ error: "project is required" }), { status: 400 });
    }

    const result = await runPocockAudit(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
