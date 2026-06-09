"""NOUS.SALVAGE.2 — push-before-die protocol for the Spawner worker template.

When the spawner is about to kill a worker (SIGTERM / timeout / reconcile),
this module pushes the worker's in-progress git changes to a salvage branch
and atomically records {branch, sha, file_count} on the worker's
dispatch_queue row. Conductor's /salvage/rebase + cleanup layer (SALVAGE.4/6)
reads those columns to recover work that would otherwise be discarded.

Contract (per the clause):
  * Workers below SALVAGE_MILESTONE_THRESHOLD (default 0.30) shut down
    immediately — no push attempt. The recovery value below 30% does not
    justify the push cost.
  * The push attempt is wrapped in a hard timeout aligned to the worker
    kill grace period. Never block shutdown indefinitely.
  * Branch / sha / file_count must land in dispatch_queue in a single
    UPDATE — partial atomic writes are forbidden. We delegate this to
    POST /dispatch/salvage on NOUS so the write happens server-side.
  * No raw shell-string interpolation around git; we use asyncio.subprocess
    with argv lists.
  * Push failures are logged at WARN — never retried. The worker exits
    cleanly so the kill path is not blocked.

This module is pure-ish: side effects (git, HTTP) are injected via
explicit parameters / patchable module globals, so the unit tests can
drive every branch without spawning a worker.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Iterable, Optional

import httpx

logger = logging.getLogger("spawner.push_before_die")

# Threshold below which we skip the push entirely. The clause forbids
# hardcoding it — read from env, fall back to the default agreed in
# SALVAGE.D4 (0.30).
_DEFAULT_THRESHOLD = 0.30


def _read_threshold() -> float:
    raw = os.environ.get("SALVAGE_MILESTONE_THRESHOLD", "").strip()
    if not raw:
        return _DEFAULT_THRESHOLD
    try:
        v = float(raw)
    except ValueError:
        logger.warning("SALVAGE_MILESTONE_THRESHOLD=%r is not a float; using default", raw)
        return _DEFAULT_THRESHOLD
    if v < 0 or v > 1:
        logger.warning("SALVAGE_MILESTONE_THRESHOLD=%s out of [0,1]; using default", v)
        return _DEFAULT_THRESHOLD
    return v


def _safe_branch_segment(s: str) -> str:
    """Strip characters disallowed in a git ref name."""
    cleaned = re.sub(r"[^A-Za-z0-9._/-]+", "-", s).strip("-/.")
    return cleaned or "anon"


@dataclass(frozen=True)
class SalvageResult:
    """Outcome of one push attempt against one repo."""
    repo_dir: str
    pushed: bool
    branch: Optional[str] = None
    sha: Optional[str] = None
    file_count: Optional[int] = None
    reason: Optional[str] = None  # WARN-level explanation when pushed=False


async def _git(repo_dir: str, *args: str, timeout: float) -> tuple[int, str, str]:
    """Run `git ...` in repo_dir. Returns (rc, stdout, stderr).

    Uses argv list — never shell string interpolation (clause constraint).
    """
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", repo_dir, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", "timeout"
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def _push_one(
    repo_dir: str,
    agent_id: str,
    per_repo_timeout: float,
) -> SalvageResult:
    """Stage everything, commit, push to salvage/<agent_id>-<repo-name>."""
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason="not_a_git_repo")

    # Discover dirty file count first — if zero, skip the push (nothing to salvage).
    rc, out, err = await _git(repo_dir, "status", "--porcelain", timeout=per_repo_timeout)
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_status_failed: {err.strip()}")
    dirty_lines = [ln for ln in out.splitlines() if ln.strip()]
    file_count = len(dirty_lines)
    if file_count == 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason="clean_tree")

    safe_agent = _safe_branch_segment(agent_id)
    safe_repo = _safe_branch_segment(os.path.basename(os.path.abspath(repo_dir)))
    branch = f"salvage/{safe_agent}-{safe_repo}"

    rc, _, err = await _git(repo_dir, "checkout", "-B", branch, timeout=per_repo_timeout)
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_checkout_failed: {err.strip()}")

    rc, _, err = await _git(repo_dir, "add", "-A", timeout=per_repo_timeout)
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_add_failed: {err.strip()}")

    rc, _, err = await _git(
        repo_dir,
        "-c", "user.email=kefalos.kosta@gmail.com",
        "-c", "user.name=kkef26",
        "commit", "-m", f"salvage: {agent_id} WIP push-before-die ({file_count} files)",
        "--allow-empty",
        timeout=per_repo_timeout,
    )
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_commit_failed: {err.strip()}")

    rc, sha_out, err = await _git(repo_dir, "rev-parse", "HEAD", timeout=per_repo_timeout)
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_rev_parse_failed: {err.strip()}")
    sha = sha_out.strip()

    # Force push: salvage branch is uniquely named per (agent, repo) and may
    # already exist from a prior attempt. Single push attempt — no retry
    # (clause constraint).
    rc, _, err = await _git(repo_dir, "push", "--force-with-lease", "origin", branch, timeout=per_repo_timeout)
    if rc != 0:
        return SalvageResult(repo_dir=repo_dir, pushed=False, reason=f"git_push_failed: {err.strip()}")

    return SalvageResult(repo_dir=repo_dir, pushed=True, branch=branch, sha=sha, file_count=file_count)


async def _record_salvage(
    nous_url: str,
    nous_key: str,
    task_id: str,
    result: SalvageResult,
    http_timeout: float,
) -> bool:
    """POST /dispatch/salvage — server-side atomic UPDATE."""
    if not result.pushed or not task_id:
        return False
    payload = {
        "task_id": task_id,
        "salvage_branch": result.branch,
        "salvage_sha": result.sha,
        "salvage_file_count": result.file_count,
    }
    try:
        async with httpx.AsyncClient(timeout=http_timeout) as client:
            resp = await client.post(
                f"{nous_url}/dispatch/salvage",
                headers={"x-api-key": nous_key, "Content-Type": "application/json"},
                json=payload,
            )
            if resp.status_code != 200:
                logger.warning(
                    "salvage record failed for task_id=%s: HTTP %s %s",
                    task_id, resp.status_code, resp.text[:200],
                )
                return False
            return True
    except Exception as exc:
        logger.warning("salvage record errored for task_id=%s: %s", task_id, exc)
        return False


async def push_before_die(
    *,
    agent_id: str,
    task_id: Optional[str],
    repo_dirs: Iterable[str],
    progress_fraction: float,
    nous_url: str,
    nous_key: str,
    deadline_secs: float,
    threshold: Optional[float] = None,
) -> list[SalvageResult]:
    """Push the worker's in-progress repos to salvage branches before exit.

    Returns one SalvageResult per repo attempted. An empty list means the
    progress threshold was not reached and no push was attempted.

    All work is bounded by `deadline_secs` total — this is the spawner's
    worker-kill grace period. Individual git ops get an even slice; the
    overall wall clock is hard-capped via asyncio.wait_for.
    """
    eff_threshold = _read_threshold() if threshold is None else threshold

    if progress_fraction < eff_threshold:
        logger.info(
            "skipping salvage push for %s — progress=%.2f below threshold %.2f",
            agent_id, progress_fraction, eff_threshold,
        )
        return []

    repos = [r for r in repo_dirs if r]
    if not repos:
        return []

    per_repo_timeout = max(2.0, deadline_secs / max(len(repos), 1) / 6)  # 6 git ops per repo
    http_timeout = min(deadline_secs / 4, 5.0)

    async def _drive() -> list[SalvageResult]:
        results: list[SalvageResult] = []
        for repo in repos:
            try:
                r = await _push_one(repo, agent_id, per_repo_timeout)
            except Exception as exc:
                r = SalvageResult(repo_dir=repo, pushed=False, reason=f"unexpected: {exc}")
            results.append(r)
            if r.pushed:
                await _record_salvage(nous_url, nous_key, task_id or "", r, http_timeout)
                logger.info("salvaged %s → %s @ %s (%d files)", repo, r.branch, r.sha, r.file_count or 0)
            else:
                logger.warning("salvage skipped for %s: %s", repo, r.reason)
        return results

    try:
        return await asyncio.wait_for(_drive(), timeout=deadline_secs)
    except asyncio.TimeoutError:
        logger.warning("push_before_die hit hard deadline (%.1fs) for %s", deadline_secs, agent_id)
        return []
