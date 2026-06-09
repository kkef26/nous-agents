"""NOUS.SALVAGE.2 — unit tests for the push-before-die module.

Covers the three contract branches:
  1. progress >= threshold → push attempted, dispatch_queue write happens.
  2. progress <  threshold → no push, no write.
  3. push command fails    → WARN-level log, no retry, no DB write.

Implementation detail under test:
  * The module isolates side effects (asyncio subprocess + httpx) behind
    helper functions. We monkey-patch those helpers so the test is fully
    hermetic — no real git, no real network.
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import patch

# Make `spawner/` importable from this test file's location.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..", "spawner")))

import push_before_die as pbd  # noqa: E402


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if asyncio.get_event_loop().is_running() is False else asyncio.run(coro)


class PushBeforeDieTests(unittest.TestCase):
    def setUp(self):
        # Force-known threshold so the test is independent of operator env.
        os.environ["SALVAGE_MILESTONE_THRESHOLD"] = "0.30"

    # ── 1. Above-threshold push path ────────────────────────────────────────
    def test_push_attempted_when_above_threshold(self):
        async def fake_push_one(repo_dir, agent_id, per_repo_timeout):
            return pbd.SalvageResult(
                repo_dir=repo_dir, pushed=True,
                branch="salvage/agt1-repo", sha="deadbeef", file_count=3,
            )
        records: list[dict] = []

        async def fake_record(nous_url, nous_key, task_id, result, http_timeout):
            records.append({"task_id": task_id, "branch": result.branch, "sha": result.sha, "n": result.file_count})
            return True

        with patch.object(pbd, "_push_one", fake_push_one), patch.object(pbd, "_record_salvage", fake_record):
            results = asyncio.run(pbd.push_before_die(
                agent_id="agt1",
                task_id="task-uuid-1",
                repo_dirs=["/tmp/agt1-repo"],
                progress_fraction=0.55,
                nous_url="http://nous",
                nous_key="k",
                deadline_secs=10.0,
            ))

        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].pushed)
        self.assertEqual(results[0].file_count, 3)
        self.assertEqual(records, [{"task_id": "task-uuid-1", "branch": "salvage/agt1-repo", "sha": "deadbeef", "n": 3}])

    # ── 2. Below-threshold skip path ────────────────────────────────────────
    def test_no_push_below_threshold(self):
        async def explode(*a, **k):
            raise AssertionError("must not be called below threshold")

        with patch.object(pbd, "_push_one", explode), patch.object(pbd, "_record_salvage", explode):
            results = asyncio.run(pbd.push_before_die(
                agent_id="agt2",
                task_id="task-uuid-2",
                repo_dirs=["/tmp/agt2-repo"],
                progress_fraction=0.15,
                nous_url="http://nous",
                nous_key="k",
                deadline_secs=10.0,
            ))

        self.assertEqual(results, [])

    # ── 3. Push failure → WARN, no retry, no DB write ──────────────────────
    def test_push_failure_logs_and_skips_record(self):
        call_count = {"push": 0, "record": 0}

        async def failing_push(repo_dir, agent_id, per_repo_timeout):
            call_count["push"] += 1
            return pbd.SalvageResult(
                repo_dir=repo_dir, pushed=False, reason="git_push_failed: remote rejected",
            )

        async def fake_record(*a, **k):
            call_count["record"] += 1
            return True

        with patch.object(pbd, "_push_one", failing_push), patch.object(pbd, "_record_salvage", fake_record):
            results = asyncio.run(pbd.push_before_die(
                agent_id="agt3",
                task_id="task-uuid-3",
                repo_dirs=["/tmp/agt3-repo"],
                progress_fraction=0.99,
                nous_url="http://nous",
                nous_key="k",
                deadline_secs=10.0,
            ))

        self.assertEqual(call_count["push"], 1, "exactly one push attempt — no retry per clause constraint")
        self.assertEqual(call_count["record"], 0, "failed push must not produce a dispatch_queue write")
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].pushed)
        self.assertIn("git_push_failed", results[0].reason or "")

    # ── Threshold override via explicit arg ────────────────────────────────
    def test_explicit_threshold_overrides_env(self):
        async def fake_push_one(repo_dir, agent_id, per_repo_timeout):
            return pbd.SalvageResult(repo_dir=repo_dir, pushed=True, branch="b", sha="s", file_count=1)

        async def fake_record(*a, **k):
            return True

        with patch.object(pbd, "_push_one", fake_push_one), patch.object(pbd, "_record_salvage", fake_record):
            # 0.20 < env 0.30 default, but explicit threshold=0.10 lets it through.
            results = asyncio.run(pbd.push_before_die(
                agent_id="agt4",
                task_id="t",
                repo_dirs=["/tmp/x"],
                progress_fraction=0.20,
                nous_url="http://n", nous_key="k", deadline_secs=10.0,
                threshold=0.10,
            ))
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].pushed)

    # ── Empty repo list short-circuits cleanly ─────────────────────────────
    def test_no_repos_returns_empty(self):
        results = asyncio.run(pbd.push_before_die(
            agent_id="agt5",
            task_id="t",
            repo_dirs=[],
            progress_fraction=0.99,
            nous_url="http://n", nous_key="k", deadline_secs=10.0,
        ))
        self.assertEqual(results, [])


if __name__ == "__main__":
    unittest.main()
