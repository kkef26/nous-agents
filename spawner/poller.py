"""Queue polling as asyncio task. Claims up to MAX_WORKERS tasks per cycle."""
import asyncio
import logging
import httpx
from config import NOUS_URL, NOUS_KEY, POLL_INTERVAL, MAX_WORKERS, PORT, SPAWNER_INSTANCE
import pool

logger = logging.getLogger("spawner.poller")

_consecutive_failures = 0


def _get_interval() -> int:
    if _consecutive_failures == 0:
        return POLL_INTERVAL
    return min(POLL_INTERVAL * (2 ** _consecutive_failures), 300)


def _record(success: bool):
    global _consecutive_failures
    if success:
        _consecutive_failures = 0
    else:
        _consecutive_failures += 1


async def run():
    """Main polling loop. Runs until cancelled."""
    logger.info(f"Poller started (interval={POLL_INTERVAL}s, max_workers={MAX_WORKERS})")
    await asyncio.sleep(10)  # let spawner fully start

    while True:
        interval = _get_interval()
        try:
            await _poll_cycle()
        except asyncio.CancelledError:
            logger.info("Poller cancelled — exiting cleanly")
            return
        except Exception as e:
            logger.error(f"Poll cycle error: {e}")
            _record(False)

        await asyncio.sleep(interval)


async def _poll_cycle():
    """Single poll: claim+spawn up to available capacity."""
    active = pool.active_count()
    available = MAX_WORKERS - active
    if available <= 0:
        logger.debug(f"At capacity ({active}/{MAX_WORKERS}) — skipping")
        return

    # Check for pending tasks
    pending = await pool.nous_get(f"/queue?status=pending&limit={available}")
    queue = pending.get("queue", []) if pending else []
    if not queue:
        return

    logger.info(f"{len(queue)} pending task(s), {available} slot(s) free — claiming batch")

    # Claim and spawn up to available capacity
    spawned = 0
    for task in queue:
        if pool.active_count() >= MAX_WORKERS:
            logger.info(f"Hit capacity after spawning {spawned} — stopping")
            break

        task_preview = task.get("id", "?")[:8]
        logger.info(f"Claiming task {task_preview}...")

        result = await pool.claim_and_spawn()
        if result.get("spawned"):
            logger.info(f"Spawned {result.get('session','?')} for {result.get('project','?')}")
            spawned += 1
            _record(True)
            # Small delay between spawns to avoid thundering herd
            await asyncio.sleep(2)
        else:
            reason = result.get("reason", result.get("error", "unknown"))
            logger.info(f"No spawn: {reason}")
            if reason == "no pending tasks":
                break  # queue drained
            _record(False)

    if spawned:
        logger.info(f"Batch complete: spawned {spawned} worker(s)")


async def reconcile_ghost_claims():
    """Find tasks claimed by this spawner that have no local worker process.

    This catches the case where /dispatch/claim succeeded (task marked running 
    in DB) but spawn_worker failed silently — no _workers entry exists.
    Called by watchdog on each cycle.
    """
    try:
        resp = await pool.nous_get(
            f"/queue?status=running&spawner={SPAWNER_INSTANCE}&limit=20"
        )
        if not resp:
            return

        running_in_db = resp.get("queue", [])
        if not running_in_db:
            return

        # Get set of task_ids we actually have workers for
        local_task_ids = set()
        for w in pool.list_workers():
            tid = w.get("task_id")
            if tid:
                local_task_ids.add(tid)

        ghosts = []
        for task in running_in_db:
            task_id = task.get("id")
            if task_id and task_id not in local_task_ids:
                ghosts.append(task)

        for ghost in ghosts:
            task_id = ghost.get("id")
            clause = ghost.get("clause_id") or ghost.get("bible_clause") or "?"
            logger.warning(f"[ghost-recovery] task {task_id[:8]} ({clause}) claimed but no local worker — releasing")
            # FIX: /dispatch/release returns 404. Use /dispatch/complete instead.
            await pool._nous_post("/dispatch/complete", {
                "dispatch_id": task_id,
                "result": "ghost_claim: spawner claimed but worker process never started",
            })
            await pool._nous_post("/event", {
                "event_type": "abandoned",
                "agent_id": ghost.get("agent_id", "unknown"),
                "agent_type": "claude2",
                "project": ghost.get("project", "unknown"),
                "summary": "[ghost-recovery] " + clause + " ghost claim released",
            })

        if ghosts:
            logger.info(f"[ghost-recovery] released {len(ghosts)} ghost claim(s)")

    except Exception as e:
        logger.error(f"Ghost claim reconciliation error: {e}")
