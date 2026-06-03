"""Worker lifecycle: spawn, track, kill, reconcile, boot injection, spawner ops."""
import asyncio
import json
import os
import pwd
import signal
import time
import logging
from typing import Dict, Optional
import httpx
from config import NOUS_URL, NOUS_KEY, SPAWNER_INSTANCE, MAX_WORKERS, PORT, SILENCE_KILL_MIN, BASE_TIMEOUT_MIN_PER_CLAUSE
from thinking_streamer import ThinkingStreamer, classify_cause

logger = logging.getLogger("spawner.pool")

SPAWNER_DIR = os.getenv("SPAWNER_DIR", "/home/ubuntu/spawner-v3")
LOGS_DIR = os.path.join(SPAWNER_DIR, "worker_logs")
os.makedirs(LOGS_DIR, exist_ok=True)

# Disallowed tools for workers (prevent accidental infra damage)
DISALLOWED_TOOLS = (
    "mcp__e71d14e4-551f-4ac8-a323-90725901a790__deploy_edge_function,"
    "mcp__b9fc31b3-f586-41b8-841e-0aeafa688e95__deploy_to_vercel"
)

# In-memory registries
_workers: Dict[str, dict] = {}
_progress: Dict[str, dict] = {}
_worker_counter = 0

PROGRESS_STALE_SECS = SILENCE_KILL_MIN * 60

def _demote(uid, gid):
    """preexec_fn: drop root to given uid/gid before exec."""
    def _inner():
        os.setgid(gid)
        os.setuid(uid)
    return _inner
  # NST.82.3 default; per-worker overrides via _workers[name]['silence_kill_secs']


def _next_worker_id() -> str:
    global _worker_counter
    _worker_counter += 1
    return f"c2-worker-{int(time.time())}-{_worker_counter}"


def active_count() -> int:
    return len(_workers)


def list_workers() -> list:
    now = int(time.time())
    result = []
    for name, w in _workers.items():
        prog = _progress.get(name, {})
        clause_count = w.get("clause_count", 1)
        silence_kill_secs = w.get("silence_kill_secs", SILENCE_KILL_MIN * 60)
        total_timeout_min = w.get("total_timeout_min", clause_count * BASE_TIMEOUT_MIN_PER_CLAUSE)
        entry = {
            "name": name,
            "pid": w["pid"],
            "started": w["started"],
            "running_mins": int((now - w["started"]) / 60),
            "logfile": w.get("logfile", ""),
            "task_id": w.get("task_id", ""),
            "clause_count": clause_count,
            "silence_kill_secs": silence_kill_secs,
            "total_timeout_min": total_timeout_min,
            "clauses": prog.get("clauses", {}),  # NST.82.3 per-clause progress map
        }
        if prog:
            entry["progress"] = prog.get("percent", 0)
            entry["milestone"] = prog.get("milestone", "")
            entry["clause_id"] = prog.get("clause_id")
            entry["clause_percent"] = prog.get("clause_percent")
            entry["progress_age_secs"] = now - prog.get("updated_at", now)
            entry["stale"] = entry["progress_age_secs"] > silence_kill_secs
        else:
            entry["progress"] = 0
            entry["milestone"] = "no progress reported"
            entry["clause_id"] = None
            entry["clause_percent"] = None
            entry["progress_age_secs"] = (now - w["started"])
            entry["stale"] = entry["running_mins"] > (SILENCE_KILL_MIN / 60.0)
        # v3.1: log file age for watchdog liveness check
        lf = w.get("logfile", "")
        if lf:
            try:
                entry["log_age_secs"] = int(now - os.path.getmtime(lf))
            except (OSError, FileNotFoundError):
                entry["log_age_secs"] = None
        else:
            entry["log_age_secs"] = None
        result.append(entry)
    return result


def update_progress(
    agent_id: str,
    percent: int,
    milestone: str = "",
    clause_id: Optional[str] = None,
    clause_percent: Optional[int] = None,
):
    """NST.82.3 — Record progress from a worker.

    Two event kinds (both update updated_at → reset Remora silence timer):
    - MILESTONE: clause_percent set (10/50/80/100) → advances progress bar
    - STATUS:    clause_percent None → narrative only, bar unchanged
    """
    now = int(time.time())
    existing = _progress.get(agent_id, {})
    clauses = existing.get("clauses", {})
    if clause_id:
        clauses.setdefault(clause_id, {"events": []})
        clauses[clause_id]["latest_milestone"] = milestone
        clauses[clause_id]["events"].append({
            "ts": now,
            "milestone": milestone,
            "clause_percent": clause_percent,
            "event_type": "milestone" if clause_percent is not None else "status",
        })
        if clause_percent is not None:
            clauses[clause_id]["percent"] = min(100, max(0, int(clause_percent)))
            if clause_percent >= 100:
                clauses[clause_id]["completed_at"] = now
            if "started_at" not in clauses[clause_id]:
                clauses[clause_id]["started_at"] = now

    _progress[agent_id] = {
        "percent": min(100, max(0, int(percent))),
        "milestone": milestone,
        "clause_id": clause_id,
        "clause_percent": clause_percent,
        "clauses": clauses,
        "updated_at": now,
    }


def get_progress(agent_id: str) -> Optional[dict]:
    return _progress.get(agent_id)


def get_task_id(agent_id: str) -> Optional[str]:
    """Get dispatch task_id for a worker by agent_id."""
    info = _workers.get(agent_id)
    return info.get("task_id") if info else None


# ─── Boot Injection ──────────────────────────────────────────────────────────
async def ensure_boot_context(prompt: str, project: str) -> str:
    """If prompt missing ## BOOT CONTEXT, call /boot and prepend it."""
    if "## BOOT CONTEXT" in prompt:
        return prompt

    logger.info(f"Prompt missing BOOT CONTEXT — calling /boot for {project}")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{NOUS_URL}/boot",
                params={"project": project, "agent_type": "claude2", "task_type": "build"},
                headers={"x-api-key": NOUS_KEY},
            )
            if resp.status_code != 200:
                logger.warning(f"Boot injection failed ({resp.status_code})")
                return prompt

            boot = resp.json()
            creds = boot.get("credentials", {})
            laws = boot.get("laws", [])

            header = "## BOOT CONTEXT\n"
            header += f"Session: spawner-injected-{int(time.time())}\n"
            header += "Protocol: 2026-05-05\n\n"
            header += "### Credentials\n"
            for k, v in creds.items():
                v_str = str(v)
                if "\n" in v_str or len(v_str) > 200:
                    import base64 as _b64
                    encoded = _b64.b64encode(v_str.encode()).decode()
                    header += f"{k}=BASE64:{encoded}\n"
                    header += f"# ^ To decode: echo \"{encoded}\" | base64 -d > /tmp/{k.lower()}\n"
                else:
                    header += f"{k}={v_str}\n"
            header += "\n### Laws\n"
            for law in laws:
                header += f"- {law}\n"
            header += "\n---\n\n"
            return header + prompt
    except Exception as e:
        logger.error(f"Boot injection error: {e}")
        return prompt


def wrap_with_spawner_ops(prompt: str, agent_id: str, task_id: str, project: str) -> str:
    """Append progress reporting + dispatch close instructions."""
    ops = f"""

## SPAWNER OPERATIONAL INSTRUCTIONS
The spawner already claimed this task and fired the NOUS start event.
DO NOT fire another start event.

### Progress Reporting — MANDATORY
Report progress at each major milestone:
```bash
curl -s -X POST http://localhost:{PORT}/progress \\
  -H 'Content-Type: application/json' \\
  -d '{{"agent_id":"{agent_id}","percent":<0-100>,"milestone":"<what just completed>"}}'
```
Suggested milestones:
  10% — context loaded, task understood
  30% — implementation started
  50% — core logic done
  70% — deployed / pushed
  85% — QA / verification

DO NOT fire a 100% progress event. The complete event below IS the 100% signal.
After 85%, go straight to closing the task.
If you don't report progress, the spawner assumes you're stuck after 10 minutes.

### Closing the Task — MANDATORY. DO NOT SKIP.
The complete event MUST be the absolute LAST thing you fire. No progress events,
no memory saves, no inbox posts AFTER complete. Anything after complete causes
the Fleet board to show you as stale.

When done, you MUST close the dispatch:
```bash
curl -s -X POST {NOUS_URL}/dispatch/complete \\
  -H "x-api-key: {NOUS_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{{"task_id":"{task_id}","agent_id":"{agent_id}","status":"complete","summary":"<1-line what you built>"}}'
```

Then fire the NOUS complete event:
```bash
curl -s -X POST {NOUS_URL}/event \\
  -H "x-api-key: {NOUS_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{{"event_type":"complete","agent_id":"{agent_id}","agent_type":"claude2","project":"{project}","summary":"<what you built>","duration_minutes":<N>}}'
```

A session with no saved output is wasted compute.
"""
    return prompt + ops


# ─── Spawn ────────────────────────────────────────────────────────────────────
async def spawn_worker(
    session_name: str,
    prompt: str,
    clause_count: int = 1,
    silence_kill_secs: Optional[int] = None,
    total_timeout_min: Optional[int] = None,
) -> tuple:
    """Spawn claude -p with stdin prompt file. Returns (ok, pid).

    NST.82.3: clause_count/silence/total_timeout determine Remora kill thresholds
    per-worker. Feature-group dispatches pass clause_count from claim response.
    """
    if active_count() >= MAX_WORKERS:
        return False, 0
    if silence_kill_secs is None:
        # NST.82.3 fix: feature groups (clause_count > 1) get 15min silence kill
        # to avoid premature Remora kills between complex clauses.
        # Single-clause workers keep the standard 10min.
        silence_kill_secs = (15 * 60) if clause_count > 1 else (SILENCE_KILL_MIN * 60)
    if total_timeout_min is None:
        total_timeout_min = clause_count * BASE_TIMEOUT_MIN_PER_CLAUSE

    logfile = os.path.join(LOGS_DIR, f"{session_name}.log")
    prompt_file = os.path.join(LOGS_DIR, f"{session_name}.prompt")

    with open(prompt_file, "w") as f:
        f.write(prompt)

    # Get ubuntu uid/gid for worker isolation
    try:
        pw = pwd.getpwnam(os.getenv("SPAWNER_USER", "nous"))
        ubuntu_uid, ubuntu_gid = pw.pw_uid, pw.pw_gid
    except KeyError:
        ubuntu_uid = ubuntu_gid = os.getuid()

    for fp in [prompt_file, logfile]:
        if os.path.exists(fp):
            try:
                os.chown(fp, ubuntu_uid, ubuntu_gid)
            except PermissionError:
                pass

    # Open files for stdin/stdout
    pf = open(prompt_file, "r")
    lf = open(logfile, "w")

    process = await asyncio.create_subprocess_exec(
        "claude", "-p",
        "--allow-dangerously-skip-permissions",
        "--permission-mode", "bypassPermissions",
        "--disallowed-tools", DISALLOWED_TOOLS,
        "--output-format", "stream-json", "--verbose",
        stdin=pf,
        stdout=lf,
        stderr=lf,
        cwd=SPAWNER_DIR,
        env={**os.environ, "PYTHONUNBUFFERED": "1", "HOME": "/opt/nous/station-proxy", "CLAUDE_CONFIG_DIR": "/opt/nous/station-proxy/.claude-c2", "CLAUDE_CODE_BUBBLEWRAP": "1"},
        preexec_fn=_demote(ubuntu_uid, ubuntu_gid),
        start_new_session=True,
    )

    pf.close()  # stdin file can be closed after exec

    _workers[session_name] = {
        "pid": process.pid,
        "process": process,
        "started": int(time.time()),
        "logfile": logfile,
        "log_file_obj": lf,
        "task_id": "",
        # NST.82.3 per-worker Remora thresholds
        "clause_count": clause_count,
        "silence_kill_secs": silence_kill_secs,
        "total_timeout_min": total_timeout_min,
    }

    logger.info(f"Spawned {session_name} PID={process.pid}")

    # Fire-and-forget completion watcher
    # Start thinking streamer for live visibility
    streamer = ThinkingStreamer(
        agent_id=session_name,
        dispatch_id="",
        logfile=os.path.join(LOGS_DIR, f"{session_name}.log"),
        started=int(time.time()),
    )
    streamer.start()
    _workers[session_name]["streamer"] = streamer
    asyncio.create_task(_watch_completion(session_name, process))

    return True, process.pid


async def claim_and_spawn() -> dict:
    """Claim next pending task from NOUS and spawn a worker. Returns result dict."""
    worker_id = _next_worker_id()

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{NOUS_URL}/dispatch/claim",
            headers={"x-api-key": NOUS_KEY, "Content-Type": "application/json"},
            json={"agent_id": worker_id, "agent_type": "claude2", "spawner_instance": SPAWNER_INSTANCE},
        )

    if resp.status_code != 200:
        return {"spawned": False, "reason": f"claim HTTP {resp.status_code}"}

    claim = resp.json()
    if not claim.get("claimed"):
        return {"spawned": False, "reason": claim.get("reason", "no pending tasks")}

    task_id = claim.get("dispatch_id", "")
    task_agent_id = claim.get("task_agent_id", worker_id)
    project = claim.get("project", "")
    prompt = claim.get("prompt", "")

    if not prompt:
        return {"spawned": False, "reason": "claimed task has empty prompt"}

    # NST.82.3 — extract clause_count + effort from claim (set by core.ts handleDispatchClaim)
    clause_count = int(claim.get("clause_count") or 1)
    expected_effort = claim.get("expected_effort") or {}
    # Optional explicit overrides from expected_effort (computed by estimateFeatureGroupEffort)
    total_timeout_min_override = None
    if isinstance(expected_effort, dict):
        # expected_sec is seconds; convert to minutes ceiling
        exp_sec = expected_effort.get("expected_sec")
        if isinstance(exp_sec, (int, float)) and exp_sec > 0:
            total_timeout_min_override = max(int(exp_sec / 60) + 5, clause_count * BASE_TIMEOUT_MIN_PER_CLAUSE)

    # Boot injection + spawner ops
    prompt = await ensure_boot_context(prompt, project)
    prompt = wrap_with_spawner_ops(prompt, task_agent_id, task_id, project)

    # Fire start event
    await _nous_post("/event", {
        "event_type": "start",
        "agent_id": task_agent_id,
        "agent_type": "claude2",
        "project": project,
        "summary": f"Claimed: {prompt[:100]} (clause_count={clause_count})",
    })

    ok, pid = await spawn_worker(
        task_agent_id, prompt,
        clause_count=clause_count,
        silence_kill_secs=None,
        total_timeout_min=total_timeout_min_override,
    )
    if ok:
        _workers[task_agent_id]["task_id"] = task_id
        # Wire dispatch_id to streamer
        if _workers[task_agent_id].get("streamer"):
            _workers[task_agent_id]["streamer"].dispatch_id = task_id
        return {
            "spawned": True,
            "session": task_agent_id,
            "pid": pid,
            "project": project,
            "task_id": task_id,
        }
    else:
        # Release task back to queue
        await _nous_post("/dispatch/release", {"task_id": task_id})
        await _nous_post("/event", {
            "event_type": "error",
            "agent_id": task_agent_id,
            "agent_type": "claude2",
            "project": project,
            "summary": "Spawn failed — released back to queue",
        })
        return {"spawned": False, "error": "process launch failed"}


# ─── Worker lifecycle ─────────────────────────────────────────────────────────
async def _watch_completion(session_name: str, process: asyncio.subprocess.Process):
    """Wait for worker exit, then clean up."""
    await process.wait()
    # Stop thinking streamer and fire death report
    worker = _workers.get(session_name, {})
    streamer = worker.get("streamer")
    if streamer:
        try:
            await streamer.stop()
            complete_fired = worker.get("complete_fired", False)
            await streamer.death_report(
                exit_code=process.returncode or 0,
                complete_fired=complete_fired,
            )
        except Exception as e:
            logging.getLogger("spawner.pool").warning(f"Streamer cleanup error: {e}")
    worker = _workers.pop(session_name, None)
    if worker and worker.get("log_file_obj"):
        try:
            worker["log_file_obj"].close()
        except Exception:
            pass
    logger.info(f"Worker {session_name} exited (code={process.returncode})")


async def kill_worker(session_name: str, kill_reason: str = None) -> bool:
    """Kill a worker by session name."""
    info = _workers.get(session_name)
    if not info:
        return False
    try:
        os.killpg(os.getpgid(info["pid"]), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    _workers.pop(session_name, None)
    return True


def is_pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


# ─── Sponsor Heartbeats ──────────────────────────────────────────────────────
async def send_sponsor_heartbeats():
    """Spawner vouches that worker processes are alive."""
    alive = []
    for name, info in _workers.items():
        if info.get("task_id") and is_pid_alive(info["pid"]):
            alive.append((name, info["task_id"]))
    if not alive:
        return
    for name, task_id in alive:
        await _nous_post("/dispatch/heartbeat", {"task_id": task_id, "agent_id": name})
    logger.info(f"Sent {len(alive)} sponsor heartbeats")


# ─── Reconcile ────────────────────────────────────────────────────────────────
async def reconcile():
    """On startup: kill orphan claude -p processes from previous run."""
    logger.info("Reconciling orphans...")
    try:
        result = await asyncio.create_subprocess_exec(
            "pgrep", "-f", "claude -p",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await result.communicate()
        pids = [int(p) for p in stdout.decode().strip().split("\n") if p.strip()]
    except Exception:
        pids = []

    killed = 0
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            killed += 1
        except (ProcessLookupError, PermissionError, OSError):
            pass

    if killed:
        logger.info(f"Killed {killed} orphan(s) from previous run")
    else:
        logger.info("No orphans found")


# ─── NOUS helpers ─────────────────────────────────────────────────────────────
async def _nous_post(path: str, payload: dict):
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await client.post(
                f"{NOUS_URL}{path}",
                headers={"x-api-key": NOUS_KEY, "Content-Type": "application/json"},
                json=payload,
            )
    except Exception as e:
        logger.error(f"NOUS POST {path} failed: {e}")


async def _nous_post_with_response(path: str, payload: dict) -> Optional[dict]:
    """POST to NOUS and return response dict."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{NOUS_URL}{path}",
                headers={"x-api-key": NOUS_KEY, "Content-Type": "application/json"},
                json=payload,
            )
            return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}"}
    except Exception as e:
        logger.error(f"NOUS POST {path} failed: {e}")
        return None


async def nous_get(path: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{NOUS_URL}{path}",
                headers={"x-api-key": NOUS_KEY},
            )
            return resp.json() if resp.status_code == 200 else None
    except Exception as e:
        logger.error(f"NOUS GET {path} failed: {e}")
        return None
