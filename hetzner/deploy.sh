#!/bin/bash
# Deploy scoper to Hetzner.
# Run from the Hetzner server at /opt/nous-agents/hetzner.
set -e

mkdir -p /var/log/nous

for svc in scoper; do
  echo "[deploy] Building $svc..."
  pushd "$svc" >/dev/null
  npm install --no-audit --no-fund
  npx tsc
  popd >/dev/null
done

echo "[deploy] Restarting services via PM2..."
pm2 delete scoper 2>/dev/null || true
pm2 start scoper/ecosystem.config.js
pm2 save

echo "[deploy] Verifying..."
sleep 2
curl -fsS http://localhost:8090/health && echo

echo "[deploy] Done."
