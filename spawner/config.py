"""Configuration for spawner-v3. All values from env + .env file with sane defaults."""
import os
import socket

# Load .env if present (same as v2)
_env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_file):
    with open(_env_file) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

NOUS_URL = os.getenv("NOUS_URL", "https://oozlawunlkkuaykfunan.supabase.co/functions/v1/nous")
NOUS_KEY = os.getenv("NOUS_KEY", "")
SPAWNER_API_KEY = os.getenv("SPAWNER_API_KEY", "")
PORT = int(os.getenv("SPAWNER_PORT", "8788"))
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "12"))
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "30"))
# NST.82.3 — Remora scaling
# SILENCE_KILL_MIN: workers with no progress event for this many minutes get killed.
#                  Each /progress POST resets the silence timer. Status events count.
# BASE_TIMEOUT_MIN_PER_CLAUSE: total elapsed timeout = clause_count × this.
#                              A 5-clause feature_group worker gets 5 × 30 = 150 min total.
SILENCE_KILL_MIN = int(os.getenv("SILENCE_KILL_MIN", "10"))
BASE_TIMEOUT_MIN_PER_CLAUSE = int(os.getenv("BASE_TIMEOUT_MIN_PER_CLAUSE", "30"))
# HEARTBEAT_TIMEOUT retained as legacy fallback (sponsor heartbeat logic).
# Per-worker kill thresholds derive from SILENCE_KILL_MIN + BASE_TIMEOUT_MIN_PER_CLAUSE.
HEARTBEAT_TIMEOUT = int(os.getenv("HEARTBEAT_TIMEOUT", "900"))
SPAWNER_INSTANCE = os.getenv("SPAWNER_INSTANCE", socket.gethostname())
VERSION = "3.0.0"
