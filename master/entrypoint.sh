#!/usr/bin/env bash
set -e

export PYTHONPATH="/app:${PYTHONPATH:-}"
cd /app

echo "=== [Master Node] Initializing Ray Head + Local GPU Worker ==="
echo "Master Tailscale IP: ${MASTER_TAILSCALE_IP}"

# 1. Start Telemetry Agent in background
echo "[1/2] Launching Master GPU Telemetry Agent in background..."
python3 /app/agent.py &
AGENT_PID=$!

# 2. Stop any lingering Ray instance
ray stop --force 2>/dev/null || true

# 3. Start Ray Head node with local GPU allocation
echo "[2/2] Launching Ray Head node with local GPU allocation on ${MASTER_TAILSCALE_IP}:6379..."
exec ray start --head \
  --node-ip-address="${MASTER_TAILSCALE_IP}" \
  --port=6379 \
  --ray-client-server-port=10001 \
  --dashboard-host=0.0.0.0 \
  --dashboard-port=8265 \
  --min-worker-port=20000 \
  --max-worker-port=20050 \
  --num-gpus=1 \
  --block
