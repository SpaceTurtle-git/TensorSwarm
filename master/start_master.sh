#!/usr/bin/env bash
# ==============================================================================
# TensorSwarm Master - One-Click Hybrid Startup Script
# Starts Ray Head, Master Local GPU Worker, and FastAPI Backend via Docker Compose.
# ==============================================================================

set -euo pipefail

CYAN='\033[036m'
GREEN='\033[032m'
YELLOW='\033[1;33m'
RED='\033[031m'
NC='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    log_error "Please run with sudo: sudo ./start_master.sh"
    exit 1
fi

echo -e "${CYAN}==================================================================${NC}"
echo -e "${CYAN}        ⚡ TensorSwarm Master Node - One-Click Launcher          ${NC}"
echo -e "${CYAN}==================================================================${NC}"

# 1. Install Docker & Compose plugin if missing
if ! command -v docker &> /dev/null; then
    log_info "Installing Docker Engine & Compose plugin..."
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    DISTRO_ID=$(lsb_release -is | tr '[:upper:]' '[:lower:]')
    CODENAME=$(lsb_release -cs)
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DISTRO_ID} ${CODENAME} stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
fi

# 2. Install NVIDIA Container Toolkit if missing
if ! dpkg -s nvidia-container-toolkit &> /dev/null; then
    log_info "Installing NVIDIA Container Toolkit..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg --batch --yes
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
      sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
      tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
    apt-get update -y
    apt-get install -y nvidia-container-toolkit
    nvidia-ctk runtime configure --runtime=docker
    systemctl restart docker
fi

# 3. Detect Host GPU
if command -v nvidia-smi &> /dev/null; then
    MASTER_GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
    log_success "Master GPU detected: ${MASTER_GPU}"
else
    log_warn "nvidia-smi not found. Master will participate without hardware GPU acceleration."
fi

# 4. Tailscale Check & IP Resolution
if ! command -v tailscale &> /dev/null; then
    log_info "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
    systemctl enable --now tailscaled
fi

MASTER_TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
if [ -z "$MASTER_TAILSCALE_IP" ]; then
    log_warn "Tailscale is not authenticated on this machine!"
    log_warn "Please authenticate Tailscale now:"
    tailscale up
    MASTER_TAILSCALE_IP=$(tailscale ip -4)
fi
log_success "Master Tailscale IP: ${MASTER_TAILSCALE_IP}"

# 5. Write .env configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cat <<EOF > .env
MASTER_TAILSCALE_IP=${MASTER_TAILSCALE_IP}
MASTER_PORT=8000
EOF

# 6. Launch services via Docker Compose
log_info "Building and starting Master services via Docker Compose..."
docker compose down 2>/dev/null || true
docker compose up -d --build

log_info "Waiting for the FastAPI backend health check..."
API_HEALTHY=false
for attempt in $(seq 1 30); do
    if curl --fail --silent "http://127.0.0.1:8000/healthz" > /dev/null; then
        API_HEALTHY=true
        break
    fi
    sleep 1
done

if [ "$API_HEALTHY" != true ]; then
    log_error "Master API did not become healthy at http://127.0.0.1:8000/healthz."
    log_error "Recent backend logs:"
    docker compose logs --tail=80 backend
    exit 1
fi

echo ""
log_success "=================================================================="
log_success "  TensorSwarm Master is UP and operational!"
log_success "  Master Tailscale IP: ${MASTER_TAILSCALE_IP}"
log_success "  FastAPI Endpoints:   http://${MASTER_TAILSCALE_IP}:8000/docs"
log_success "  Ray Web Dashboard:   http://${MASTER_TAILSCALE_IP}:8265"
log_success "=================================================================="
log_info "To connect worker laptops, run on each laptop:"
log_info "  sudo ./start_worker.sh ${MASTER_TAILSCALE_IP}"
