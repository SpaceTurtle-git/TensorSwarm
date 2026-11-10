#!/usr/bin/env bash
set -e

export PYTHONPATH="/app:${PYTHONPATH:-}"
cd /app

echo "=== [TensorSwarm Worker] Starting Services ==="
echo "Master Tailscale IP: ${MASTER_TAILSCALE_IP}"
echo "Worker Tailscale IP: ${WORKER_TAILSCALE_IP}"

# 1. Start Telemetry Agent in background
echo "[1/2] Launching PyNVML Telemetry Agent in background..."
python3 /app/agent.py &
AGENT_PID=$!

# 2. Stop any lingering Ray instance
ray stop --force 2>/dev/null || true

# 3. Connect Ray Worker to Head
echo "[2/2] Connecting Ray Worker to Head at ${MASTER_TAILSCALE_IP}:6379..."
exec ray start \
  --address="${MASTER_TAILSCALE_IP}:6379" \
  --node-ip-address="${WORKER_TAILSCALE_IP}" \
  --min-worker-port=20000 \
  --max-worker-port=20050 \
  --block
