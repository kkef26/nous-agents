"""Heartbeat monitoring + ghost task cleanup. NST.82.3: per-worker silence + total kill."""
import asyncio
import logging
import os
import time
from config import NOUS_URL, NOUS_KEY, SILENCE_KILL_MIN, BASE_TIMEOUT_MIN_PER_CLAUSE
import pool

logger = logging.getLogger("spawner.watchdog")

CHECK_INTERVAL = 60  # NST.82.3: check every minute (was 5min — finer for silence kill)

# NST.GHOST.1 — workers that have produced zero log bytes after EMPTY_LOG_KILL_SECS
# never actually started. The spawn-verification window in pool.py catches most of
# these inside 5s, but a process can survive that window and still hang silently
# (network stall during auth, prompt-file read failure). Catch it fast instead of
# waiting for the normal silence_kill_secs (10–15min).
EMPTY_LOG_KILL_SECS = 30


async def run():
    """Main watchdog loop. Runs until cancelled."""
    logger.info(
        f"Watchdog started (interval={CHECK_INTERVAL}s, "
        f"silence={SILENCE_KILL_MIN}min, base_per_clause={BASE_TIMEOUT_MIN_PER_CLAUSE}min)"
    )

    while True:
        try:
            await asyncio.sleep(CHECK_INTERVAL)

            # Sponsor heartbeats for alive workers (legacy)
            await pool.send_sponsor_heartbeats()

            # NST.82.3 — per-worker silence + total kill
            await _check_workers_for_kill()

        except asyncio.CancelledError:
            logger.info("Watchdog cancelled — exiting cleanly")
            return
        except Exception as e:
            logger.error(f"Watchdog error: {e}")


async def _check_workers_for_kill():
    """NST.82.3 — per-worker kill: silence (no event > N min) or total elapsed > scaled timeout.

    NST.87 — after the process is killed, atomically flip dispatch_queue.status to
    'failed' via POST /dispatch/fail. The BEFORE trigger trg_dispatch_classify_on_fail
    stamps failure_class from the kill_reason (formatted to match
    nous.classify_remora_kill patterns); AFTER triggers fire retry/cascade/conductor
    surfacing and emit the terminal agent_event. The prior flow only fired /event,
    leaving rows stuck as status=running with no failure_class for retry.
    """
    now = int(time.time())
    for w in pool.list_workers():
        name = w.get("name", "unknown")
        progress = w.get("progress", 0)
        if progress >= 100:
            continue  # worker is done; spawner watcher will clean up

        silence_secs = w.get("progress_age_secs", 0)
        running_mins = w.get("running_mins", 0)
        running_secs = now - int(w.get("started", now))
        clause_count = w.get("clause_count", 1)
        silence_kill_secs = w.get("silence_kill_secs", SILENCE_KILL_MIN * 60)
        total_timeout_min = w.get("total_timeout_min", clause_count * BASE_TIMEOUT_MIN_PER_CLAUSE)
        logfile = w.get("logfile", "")

        # NST.GHOST.1 — empty-log fast kill. If running > EMPTY_LOG_KILL_SECS
        # and the log file is still 0 bytes, the worker never produced output
        # (claude died on launch, prompt was unreadable, stdin pipe broke).
        # Classify as spawn_failed so the failure_class trigger maps it to a
        # retryable class instead of waiting 10+ minutes for the silence kill.
        log_bytes = -1
        if logfile:
            try:
                log_bytes = os.path.getsize(logfile)
            except OSError:
                log_bytes = -1

        kill_reason = None
        if log_bytes == 0 and running_secs > EMPTY_LOG_KILL_SECS:
            kill_reason = (
                f"spawn_failed_silent_{running_secs}s "
                f"(log_bytes=0, never started, clauses={clause_count})"
            )
        # NST.87: format kill_reason so nous.classify_remora_kill maps it to a stall_* class.
        # 'stalled_no_progress_<N>s' → stall_no_progress; 'hard_timeout_<N>min' → stall_no_progress.
        elif silence_secs > silence_kill_secs:
            kill_reason = (
                f"stalled_no_progress_{silence_secs}s "
                f"(silence_kill_secs={silence_kill_secs}, clauses={clause_count})"
            )
        elif running_mins > total_timeout_min:
            kill_reason = (
                f"hard_timeout_{running_mins}min "
                f"(total_timeout={total_timeout_min}min, clauses={clause_count})"
            )

        if kill_reason:
            logger.warning(f"[remora] killing {name}: {kill_reason}")
            task_id = pool.get_task_id(name) if hasattr(pool, "get_task_id") else None
            # NST.LIVE.1 — pass kill_reason so the death-report's cause_class
            # reflects the actual stall mode instead of guessing from exit code.
            await pool.kill_worker(name, kill_reason=kill_reason)

            if task_id:
                # NST.87: single atomic call. The UPDATE fires triggers that fill
                # failure_class, clone the retry row, surface to conductor, emit the
                # terminal agent_event, and cascade dependents.
                await pool._nous_post("/dispatch/fail", {
                    "dispatch_id": task_id,
                    "agent_id": name,
                    "agent_type": "claude2",
                    "error": kill_reason,
                    "summary": f"[remora] killed: {kill_reason}",
                })
            else:
                # Fallback when task_id was never stashed (early-spawn failure):
                # at minimum log the kill so the operator sees it.
                await pool._nous_post("/event", {
                    "event_type": "error",
                    "agent_id": name,
                    "agent_type": "claude2",
                    "summary": f"[remora] killed (no task_id): {kill_reason}",
                })

