"""FastAPI spawner v3 — lifespan, routes, sd_notify. Full v2 feature parity."""
import asyncio
import logging
import os
import socket
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import pool
import poller
import watchdog
from config import (
    MAX_WORKERS,
    NOUS_KEY,
    NOUS_URL,
    PORT,
    SPAWNER_API_KEY,
    SPAWNER_INSTANCE,
    VERSION,
)

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="[spawner] %(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("spawner.main")

# Background task handles
_poller_task: Optional[asyncio.Task] = None
_watchdog_task: Optional[asyncio.Task] = None
_start_time = time.time()

# Status cache
_status_cache: dict = {}
_STATUS_CACHE_TTL = 15


def _sd_notify(msg: str):
    """Send systemd sd_notify message if socket available."""
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    if addr.startswith("@"):
        addr = "\0" + addr[1:]
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.connect(addr)
        sock.sendall(msg.encode())
        sock.close()
    except Exception as e:
        logger.warning(f"sd_notify failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: reconcile + start background tasks. Shutdown: cancel tasks."""
    global _poller_task, _watchdog_task, _start_time
    _start_time = time.time()

    logger.info(f"Spawner v{VERSION} starting on port {PORT} (instance={SPAWNER_INSTANCE})")

    # Verify claude CLI
    try:
        proc = await asyncio.create_subprocess_exec(
            "which", "claude",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if proc.returncode != 0:
            logger.error("'claude' CLI not found in PATH")
    except Exception:
        logger.error("Could not check for claude CLI")

    # Kill orphans from previous run
    await pool.reconcile()

    # Start background tasks
    _poller_task = asyncio.create_task(poller.run(), name="poller")
    _watchdog_task = asyncio.create_task(watchdog.run(), name="watchdog")

    # Signal systemd ready
    _sd_notify("READY=1")
    logger.info("Ready — accepting requests")

    yield

    # Shutdown
    logger.info("Shutting down...")
    _sd_notify("STOPPING=1")
    for task in [_poller_task, _watchdog_task]:
        if task and not task.done():
            task.cancel()
    await asyncio.gather(_poller_task, _watchdog_task, return_exceptions=True)
    logger.info("Shutdown complete")


app = FastAPI(title="NOUS Spawner", version=VERSION, lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# --- Auth helper ---
def _require_api_key(x_api_key: Optional[str] = Header(None)):
    if not SPAWNER_API_KEY:
        return  # No key configured = dev mode
    if x_api_key != SPAWNER_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


# --- Routes ---

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": VERSION,
        "workers": pool.active_count(),
        "max_workers": MAX_WORKERS,
        "port": PORT,
    }


@app.get("/workers")
async def workers():
    return {"workers": pool.list_workers()}


@app.post("/spawn")
async def spawn(x_api_key: Optional[str] = Header(None)):
    """Claim next pending task from NOUS and spawn a worker."""
    _require_api_key(x_api_key)
    result = await pool.claim_and_spawn()
    code = 200 if result.get("spawned") else 200  # v2 compat: always 200
    return result


class PromptSpawnRequest(BaseModel):
    prompt: str
    agent_id: Optional[str] = None


@app.post("/spawn/prompt")
async def spawn_prompt(req: PromptSpawnRequest, x_api_key: Optional[str] = Header(None)):
    """Direct prompt spawn (testing/manual)."""
    _require_api_key(x_api_key)
    agent_id = req.agent_id or pool._next_worker_id()
    if not req.prompt:
        raise HTTPException(status_code=400, detail="prompt required")
    ok, pid = await pool.spawn_worker(agent_id, req.prompt)
    if ok:
        return {"spawned": True, "session": agent_id, "pid": pid}
    else:
        raise HTTPException(status_code=500, detail="process launch failed")


class ProgressRequest(BaseModel):
    agent_id: str
    percent: int = 0
    milestone: str = ""
    # NST.82.3 per-clause granularity (optional; absent = legacy worker-level event)
    clause_id: Optional[str] = None
    clause_percent: Optional[int] = None


@app.post("/progress")
async def progress_update(req: ProgressRequest):
    """Workers report progress here. NST.82.3 per-clause aware."""
    pool.update_progress(
        req.agent_id, req.percent, req.milestone,
        clause_id=req.clause_id,
        clause_percent=req.clause_percent,
    )
    # Forward to NOUS — include clause fields when present so Fleet UI + Conductor see per-clause progress
    nous_payload = {
        "event_type": "progress",
        "agent_id": req.agent_id,
        "agent_type": "claude2",
        "summary": f"[{req.percent}%] {req.milestone}",
    }
    if req.clause_id:
        details = {"clause_id": req.clause_id}
        if req.clause_percent is not None:
            details["clause_percent"] = req.clause_percent
        nous_payload["details"] = details
        # Fire clause_complete event when a clause hits 100% so Conductor can verify granularly
        if req.clause_percent is not None and req.clause_percent >= 100:
            await pool._nous_post("/event", {
                "event_type": "clause_complete",
                "agent_id": req.agent_id,
                "agent_type": "claude2",
                "summary": f"{req.clause_id} complete",
                "details": {"clause_id": req.clause_id},
            })
    await pool._nous_post("/event", nous_payload)
    return {"ok": True, "agent_id": req.agent_id, "percent": req.percent}


@app.get("/progress")
async def progress_get():
    """Get all worker progress."""
    return {"workers": pool.list_workers()}


class KillRequest(BaseModel):
    session: str


@app.post("/workers/kill")
async def workers_kill(req: KillRequest):
    """Kill a specific worker."""
    ok = await pool.kill_worker(req.session)
    return {"killed": ok, "session": req.session}


@app.get("/status")
@app.get("/status.json")
async def status():
    """Full dashboard payload — cached for 15s."""
    global _status_cache
    now = time.time()
    if _status_cache and (now - _status_cache.get("_ts", 0)) < _STATUS_CACHE_TTL:
        return _status_cache.get("_data", {})

    try:
        worker_list = pool.list_workers()

        queue_summary = await pool.nous_get("/queue?status=pending&limit=1") or {}
        recent_complete = await pool.nous_get("/queue?status=complete&hours=24&limit=30") or {}
        recent_failed = await pool.nous_get("/queue?status=failed&hours=24&limit=20") or {}

        def _trim(rows):
            out = []
            for r in (rows or []):
                out.append({
                    "id": r.get("id"),
                    "agent_id": r.get("agent_id"),
                    "project": r.get("project"),
                    "bible_clause": r.get("bible_clause"),
                    "tier": r.get("tier"),
                    "model": r.get("model"),
                    "status": r.get("status"),
                    "started_at": r.get("started_at"),
                    "completed_at": r.get("completed_at"),
                    "created_at": r.get("created_at"),
                    "result": (r.get("result") or "")[:160] or None,
                    "error": (r.get("error") or "")[:160] or None,
                })
            return out

        payload = {
            "health": {
                "status": "ok",
                "version": VERSION,
                "active_workers": pool.active_count(),
                "max_workers": MAX_WORKERS,
                "port": PORT,
                "now": int(now),
                "now_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            },
            "workers": worker_list,
            "queue": {
                "counts": queue_summary.get("counts") or {},
                "window_counts": queue_summary.get("window_counts") or {},
            },
            "recent": {
                "complete": _trim(recent_complete.get("queue", [])),
                "failed": _trim(recent_failed.get("queue", [])),
            },
        }

        _status_cache = {"_ts": now, "_data": payload}
        return payload
    except Exception as e:
        logger.error(f"Status build error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class LogRequest(BaseModel):
    session: str
    lines: int = 100


@app.post("/workers/log")
async def worker_log(req: LogRequest):
    """Read the last N lines of a worker's log file. Works for active and completed workers."""
    import subprocess
    logfile = os.path.join(pool.LOGS_DIR, f"{req.session}.log")
    if not os.path.exists(logfile):
        raise HTTPException(status_code=404, detail=f"No log file for session {req.session}")
    try:
        r = subprocess.run(
            ["tail", "-n", str(min(req.lines, 500)), logfile],
            capture_output=True, text=True, timeout=5,
        )
        return {
            "session": req.session,
            "lines": req.lines,
            "size_bytes": os.path.getsize(logfile),
            "mtime": os.path.getmtime(logfile),
            "content": r.stdout,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/workers/logs")
async def list_worker_logs():
    """List all available worker log files with sizes and ages."""
    logs = []
    now = time.time()
    for f in sorted(os.listdir(pool.LOGS_DIR)):
        if f.endswith(".log"):
            path = os.path.join(pool.LOGS_DIR, f)
            try:
                stat = os.stat(path)
                logs.append({
                    "session": f.replace(".log", ""),
                    "size_bytes": stat.st_size,
                    "age_min": int((now - stat.st_mtime) / 60),
                    "active": f.replace(".log", "") in pool._workers,
                })
            except OSError:
                pass
    return {"logs": logs, "count": len(logs)}


@app.post("/watchdog/run")
async def watchdog_run():
    """Manually trigger ghost task cleanup."""
    try:
        await watchdog.reset_ghost_tasks()
        return {"status": "watchdog ran"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/shutdown")
async def shutdown(x_api_key: Optional[str] = Header(None)):
    _require_api_key(x_api_key)
    logger.info("Shutdown requested via API")
    os.kill(os.getpid(), 15)
    return {"status": "shutting down"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")
