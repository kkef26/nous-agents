#!/bin/bash
# Conductor sweep — safety net cron
# Runs every 5 minutes via crontab on Hetzner (nous user)
# 1. Batch-verify: sweep dispatch_queue for completed-but-unverified
# 2. Batch-merge: scan all projects, merge staging→main where staging is ahead

CONDUCTOR="http://localhost:8791"
LOG="/opt/nous/logs/conductor-sweep.log"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "[$(ts)] sweep start" >> "$LOG"

# Step 1: batch verify
VERIFY=$(curl -sf -X POST "$CONDUCTOR/batch/verify" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}' 2>/dev/null)
VERIFIED=$(echo "$VERIFY" | jq -r '.verified // 0' 2>/dev/null)
echo "[$(ts)] batch/verify: verified=$VERIFIED" >> "$LOG"

# Step 2: batch merge (only if verifications passed)
MERGE=$(curl -sf -X POST "$CONDUCTOR/batch/merge" \
  -H "Content-Type: application/json" \
  -d '{}' 2>/dev/null)
MERGED=$(echo "$MERGE" | jq -r '.merged_count // 0' 2>/dev/null)
echo "[$(ts)] batch/merge: merged=$MERGED" >> "$LOG"

echo "[$(ts)] sweep done" >> "$LOG"

# Trim log to last 500 lines
tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
