#!/bin/bash
# Deploy scoper + conductor to Hetzner
# Run from the Hetzner server at /opt/nous-agents/hetzner
set -e

echo "[deploy] Installing dependencies..."
npm install --production=false

echo "[deploy] Creating log directory..."
mkdir -p /var/log/nous

echo "[deploy] Stopping existing services..."
pm2 delete scoper 2>/dev/null || true
pm2 delete conductor 2>/dev/null || true

echo "[deploy] Starting scoper (port 8790) + conductor (port 8791)..."
pm2 start ecosystem.config.cjs

echo "[deploy] Saving PM2 config..."
pm2 save

echo "[deploy] Verifying..."
sleep 3
curl -s http://localhost:8790/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Scoper: {d}')"
curl -s http://localhost:8791/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Conductor: {d}')"

echo "[deploy] Done."
