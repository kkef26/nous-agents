"""NST.LIVE.1 — Per-worker log tailer that streams thinking chunks to NOUS.

Tails the worker stdout log (Claude Code --output-format stream-json), extracts
structured tool_call / thinking / file_touch / error / progress chunks, batches
them every BATCH_INTERVAL_SECS, and POSTs to NOUS /worker/thinking.

On worker death (clean exit, watchdog kill, crash), call death_report() to POST
a final summary to /worker/death-report with stderr tail, last chunks, and a
cause classification (clean_exit | silent_death | oom | api_timeout | crash |
unknown). The death report is idempotent per streamer instance.

The streamer must never crash the spawner: every NOUS call is wrapped, parse
errors are logged + skipped, and an unreachable NOUS endpoint drops chunks.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import deque
from typing import Optional

import httpx

from config import NOUS_URL, NOUS_KEY

logger = logging.getLogger("spawner.thinking")

BATCH_INTERVAL_SECS = 5
MAX_BATCH_BYTES = 10_000  # 10 KB per POST
MAX_CHUNK_CHARS = 300
RING_BUFFER_SIZE = 50
TAIL_POLL_SECS = 0.5

_FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit"}
_PROGRESS_RE = re.compile(r"\[(\d+)%\]\s*(.*)")


def _now_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _trim(s: Optional[str], n: int = MAX_CHUNK_CHARS) -> str:
    if not s:
        return ""
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def _file_path_from_input(tool: str, inp: dict) -> Optional[str]:
    if tool in _FILE_TOOLS:
        return inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
    return None


def _file_action(tool: str) -> str:
    if tool == "Read":
        return "read"
    if tool == "Write":
        return "write"
    if tool in ("Edit", "MultiEdit", "NotebookEdit"):
        return "edit"
    return "touch"


def _tool_target(tool: str, inp: dict) -> str:
    for key in ("file_path", "path", "notebook_path", "command", "pattern", "url", "query", "prompt"):
        if key in inp and inp[key]:
            return _trim(str(inp[key]), 120)
    return ""


class ThinkingStreamer:
    """Tail a worker log, parse, batch-POST chunks to NOUS."""

    def __init__(
        self,
        agent_id: str,
        dispatch_id: str,
        logfile: str,
        started: int,
        clause_id: Optional[str] = None,
    ):
        self.agent_id = agent_id
        self.dispatch_id = dispatch_id or ""
        self.logfile = logfile
        self.started = started
        self.clause_id = clause_id
        self._buffer: list[dict] = []
        self._ring: deque = deque(maxlen=RING_BUFFER_SIZE)
        self._position = 0
        self._stop = asyncio.Event()
        self._tail_task: Optional[asyncio.Task] = None
        self._flush_task: Optional[asyncio.Task] = None
        self._death_sent = False
        self._complete_signaled = False
        self._chunks_sent = 0
        self._http: Optional[httpx.AsyncClient] = None

    # ─── Lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        self._http = httpx.AsyncClient(timeout=15.0)
        if self._tail_task is None:
            self._tail_task = asyncio.create_task(
                self._tail_loop(), name=f"thinking-tail-{self.agent_id}"
            )
        if self._flush_task is None:
            self._flush_task = asyncio.create_task(
                self._flush_loop(), name=f"thinking-flush-{self.agent_id}"
            )
        logger.info(f"[thinking] streamer started for {self.agent_id} (log={self.logfile})")

    async def stop(self) -> None:
        self._stop.set()
        for t in (self._tail_task, self._flush_task):
            if t and not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
        try:
            # Final drain — pick up anything written since last poll.
            await self._drain_log()
        except Exception as e:
            logger.warning(f"[thinking] final drain error for {self.agent_id}: {e}")
        try:
            await self._flush()
        except Exception as e:
            logger.warning(f"[thinking] final flush error for {self.agent_id}: {e}")
        if self._http:
            await self._http.aclose()
            self._http = None

    # ─── Tail loop ────────────────────────────────────────────────────────
    async def _tail_loop(self) -> None:
        partial = ""
        while not self._stop.is_set():
            try:
                partial = await self._drain_log(partial)
                await asyncio.sleep(TAIL_POLL_SECS)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"[thinking] tail error {self.agent_id}: {e}")
                await asyncio.sleep(1)

    def _sync_read_log(self) -> str:
        """Synchronous file read — runs in executor to avoid blocking event loop."""
        try:
            size = os.path.getsize(self.logfile)
            if size <= self._position:
                return ""
            with open(self.logfile, "rb") as f:
                f.seek(self._position)
                data = f.read(size - self._position)
            self._position = size
            return data.decode("utf-8", errors="replace")
        except Exception:
            return ""

    async def _drain_log(self, partial: str = "") -> str:
        if not os.path.exists(self.logfile):
            return partial
        new_data = await asyncio.get_event_loop().run_in_executor(
            None, self._sync_read_log
        )
        if not new_data:
            return partial
        text = partial + new_data
        lines = text.split("\n")
        partial = lines[-1]
        for line in lines[:-1]:
            try:
                self._parse_line(line)
            except Exception as e:
                logger.debug(f"[thinking] parse error: {e}")
        return partial

    # ─── Parsers ──────────────────────────────────────────────────────────
    def _parse_line(self, line: str) -> None:
        s = line.strip()
        if not s:
            return
        if s.startswith("{") and s.endswith("}"):
            try:
                ev = json.loads(s)
                self._parse_stream_event(ev)
                return
            except (json.JSONDecodeError, ValueError):
                pass
        self._parse_text_line(s)

    def _parse_text_line(self, s: str) -> None:
        ts = _now_ts()
        m = _PROGRESS_RE.match(s)
        if m:
            self._emit({
                "type": "progress",
                "percent": int(m.group(1)),
                "content": _trim(m.group(2)),
                "ts": ts,
            })
            return
        low = s.lower()
        if (
            "traceback (most recent call last)" in low
            or low.startswith("error:")
            or low.startswith("error ")
            or "exception:" in low
            or "fatal:" in low
        ):
            self._emit({"type": "error", "content": _trim(s), "ts": ts})

    def _parse_stream_event(self, ev: dict) -> None:
        etype = ev.get("type")
        ts = _now_ts()
        if etype == "assistant":
            msg = ev.get("message") or {}
            for block in (msg.get("content") or []):
                self._parse_assistant_block(block, ts)
        elif etype == "user":
            msg = ev.get("message") or {}
            for block in (msg.get("content") or []):
                if block.get("type") == "tool_result" and block.get("is_error"):
                    content = block.get("content")
                    text = ""
                    if isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "text":
                                text = c.get("text", "")
                                break
                    elif isinstance(content, str):
                        text = content
                    if text:
                        self._emit({"type": "error", "content": _trim(text), "ts": ts})
        elif etype == "result":
            # Signal complete FIRST — clears buffer and blocks future _emit calls.
            # The 100% progress is intentionally NOT emitted. The worker's own
            # complete event to NOUS is the terminal signal Fleet should see.
            self.signal_complete()

    def _parse_assistant_block(self, block: dict, ts: str) -> None:
        btype = block.get("type")
        if btype == "tool_use":
            name = block.get("name", "?")
            inp = block.get("input") or {}
            if not isinstance(inp, dict):
                inp = {}
            try:
                preview = _trim(json.dumps(inp, separators=(",", ":"), default=str), 150)
            except (TypeError, ValueError):
                preview = ""
            self._emit({
                "type": "tool_call",
                "tool": name,
                "target": _tool_target(name, inp),
                "preview": preview,
                "ts": ts,
            })
            fp = _file_path_from_input(name, inp)
            if fp:
                self._emit({
                    "type": "file_touch",
                    "path": _trim(str(fp), 200),
                    "action": _file_action(name),
                    "ts": ts,
                })
            # Progress curl detection: spawner reports go through POST /progress.
            if name == "Bash":
                cmd = inp.get("command", "")
                if isinstance(cmd, str) and "/progress" in cmd and "clause_id" in cmd:
                    cm = re.search(r'"clause_id"\s*:\s*"([^"]+)"', cmd)
                    if cm:
                        self.clause_id = cm.group(1)
        elif btype == "text":
            txt = (block.get("text") or "").strip()
            if txt:
                self._emit({"type": "thinking", "content": _trim(txt, 200), "ts": ts})
        elif btype == "thinking":
            txt = (block.get("thinking") or "").strip()
            if txt:
                self._emit({"type": "thinking", "content": _trim(txt, 200), "ts": ts})

    # ─── Emit / buffer ────────────────────────────────────────────────────
    def _emit(self, chunk: dict) -> None:
        if self._complete_signaled:
            return  # Don't buffer after complete — prevents stale progress on Fleet
        self._ring.append(chunk)
        self._buffer.append(chunk)

    # ─── Flush loop ───────────────────────────────────────────────────────
    async def _flush_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.sleep(BATCH_INTERVAL_SECS)
                await self._flush()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"[thinking] flush loop error {self.agent_id}: {e}")

    async def _flush(self) -> None:
        if not self._buffer or self._complete_signaled:
            return
        # NST.GHOST.2 — take a snapshot via slice so a POST failure can restore
        # the original chunks back to the head of _buffer instead of dropping them.
        chunks = self._buffer[:]
        self._buffer = []
        payload = {
            "agent_id": self.agent_id,
            "dispatch_id": self.dispatch_id,
            "chunks": chunks,
        }
        if self.clause_id:
            payload["clause_id"] = self.clause_id
        # Cap payload at MAX_BATCH_BYTES by dropping oldest chunks.
        try:
            body = json.dumps(payload, default=str)
        except (TypeError, ValueError):
            return
        while len(body) > MAX_BATCH_BYTES and len(chunks) > 1:
            chunks.pop(0)
            payload["chunks"] = chunks
            try:
                body = json.dumps(payload, default=str)
            except (TypeError, ValueError):
                return
        try:
            resp = await self._http.post(
                f"{NOUS_URL}/worker/thinking",
                headers={"x-api-key": NOUS_KEY, "Content-Type": "application/json"},
                content=body,
            )
            if resp.status_code >= 400:
                # 4xx/5xx → payload rejected. Logging only; do not restore
                # since re-sending the same body would loop on the same error.
                logger.warning(
                    f"[thinking] POST {self.agent_id} HTTP {resp.status_code}: "
                    f"{resp.text[:200]}"
                )
            else:
                self._chunks_sent += len(chunks)
        except Exception as e:
            # NST.GHOST.2 — transient network error: restore chunks at the head
            # so the next flush retries instead of silently dropping them.
            self._buffer = chunks + self._buffer
            logger.warning(
                f"[thinking] flush failed for {self.agent_id}, "
                f"{len(chunks)} chunks restored: {e}"
            )

    # ─── Death report ─────────────────────────────────────────────────────
    def signal_complete(self) -> None:
        """Called when result event seen. Stops buffering AND clears pending buffer."""
        self._complete_signaled = True
        self._buffer.clear()

    async def death_report(
        self,
        exit_code: int,
        complete_fired: bool = False,
        kill_reason: Optional[str] = None,
    ) -> None:
        """Build + POST a death report. Idempotent."""
        if self._death_sent:
            return
        self._death_sent = True
        # Drain any remaining log content before reporting.
        try:
            await self._drain_log()
        except Exception:
            pass
        # Only flush buffered chunks if complete hasn't fired yet.
        # When complete_fired=True, flushing would emit progress events
        # AFTER the complete event, causing Fleet to show the worker as
        # still active (progress is the latest event, not complete).
        if not complete_fired:
            try:
                await self._flush()
            except Exception:
                pass

        stderr_tail = ""
        log_size = 0
        if self.logfile and os.path.exists(self.logfile):
            try:
                log_size = os.path.getsize(self.logfile)
                with open(self.logfile, "rb") as f:
                    f.seek(max(0, log_size - 2048))
                    stderr_tail = f.read().decode("utf-8", errors="replace")
            except Exception as e:
                logger.debug(f"[thinking] stderr_tail read error {self.agent_id}: {e}")

        wall_time_secs = max(0, int(time.time()) - int(self.started))
        cause = classify_cause(exit_code, complete_fired, stderr_tail, kill_reason)

        payload = {
            "agent_id": self.agent_id,
            "dispatch_id": self.dispatch_id,
            "exit_code": int(exit_code) if exit_code is not None else -1,
            "stderr_tail": stderr_tail[-2048:],
            "last_chunks": list(self._ring)[-10:],
            "cause_class": cause,
            "wall_time_secs": wall_time_secs,
            "log_size_bytes": log_size,
        }
        if self.clause_id:
            payload["clause_id"] = self.clause_id
        if kill_reason:
            payload["kill_reason"] = _trim(kill_reason, 500)

        try:
            resp = await self._http.post(
                f"{NOUS_URL}/worker/death-report",
                headers={"x-api-key": NOUS_KEY, "Content-Type": "application/json"},
                json=payload,
            )
            if resp.status_code >= 400:
                logger.warning(
                    f"[thinking] death-report {self.agent_id} HTTP {resp.status_code}: "
                    f"{resp.text[:200]}"
                )
            else:
                logger.info(
                    f"[thinking] death-report sent {self.agent_id} cause={cause} "
                    f"exit={exit_code} wall={wall_time_secs}s log={log_size}B"
                )
        except Exception as e:
            logger.warning(f"[thinking] death-report POST failed {self.agent_id}: {e}")


def classify_cause(
    exit_code: Optional[int],
    complete_fired: bool,
    stderr_tail: str,
    kill_reason: Optional[str] = None,
) -> str:
    """Heuristic classifier per NST.LIVE.1 spec."""
    if kill_reason:
        low = kill_reason.lower()
        if "timeout" in low:
            return "api_timeout" if "rate" in low or "api" in low else "silent_death"
        if "oom" in low or "memory" in low:
            return "oom"
        if "silence" in low or "stalled" in low or "no_progress" in low:
            return "silent_death"
    if exit_code == 0 and complete_fired:
        return "clean_exit"
    if exit_code == 0 and not complete_fired:
        return "silent_death"
    if exit_code in (137, -9, -15):
        return "oom" if exit_code == 137 else "silent_death"
    low = (stderr_tail or "").lower()
    if "rate_limit" in low or "rate limit" in low or "ratelimit" in low:
        return "api_timeout"
    if "timeout" in low or "timed out" in low:
        return "api_timeout"
    if "traceback (most recent call last)" in low or "exception:" in low or "fatal:" in low:
        return "crash"
    if exit_code is not None and exit_code != 0:
        return "crash"
    return "unknown"
