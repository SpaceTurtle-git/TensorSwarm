#!/usr/bin/env bash
# ==============================================================================
# TensorSwarm Worker - "One-Click" Bootstrap & Launch Script
# Target: College Lab Laptops / PCs (Ubuntu 20.04/22.04/24.04, Debian 11/12)
# Usage:
#   sudo ./start_worker.sh <MASTER_TAILSCALE_IP>
#   e.g.: sudo ./start_worker.sh 100.80.45.12
# ==============================================================================

set -euo pipefail

RED='\033[031m'
GREEN='\033[032m'
YELLOW='\033[1;33m'
CYAN='\033[036m'
NC='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# 1. Root & Sudo Preflight
if [ "$EUID" -ne 0 ]; then
    log_error "Please run this script with sudo: sudo ./start_worker.sh <MASTER_TAILSCALE_IP>"
    exit 1
fi

echo -e "${CYAN}==================================================================${NC}"
echo -e "${CYAN}        ⚡ TensorSwarm Worker - One-Click Deployment Script        ${NC}"
echo -e "${CYAN}==================================================================${NC}"

# 2. Automatically install Docker if missing
if ! command -v docker &> /dev/null; then
    log_info "Docker is missing. Installing Docker Engine & Compose plugin..."
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
    log_success "Docker Engine installed successfully."
else
    log_info "Docker already installed ($(docker --version))."
fi

# Ensure docker compose command is available
if ! docker compose version &> /dev/null; then
    log_info "Installing docker-compose-plugin..."
    apt-get install -y docker-compose-plugin
fi

# 3. Automatically install NVIDIA Container Toolkit if missing
if ! dpkg -s nvidia-container-toolkit &> /dev/null; then
    log_info "NVIDIA Container Toolkit missing. Installing..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg --batch --yes
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
      sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
      tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null

    apt-get update -y
    apt-get install -y nvidia-container-toolkit
    log_info "Configuring Docker runtime for NVIDIA..."
    nvidia-ctk runtime configure --runtime=docker
    systemctl restart docker
    log_success "NVIDIA Container Toolkit installed and configured."
else
    log_info "NVIDIA Container Toolkit already installed."
fi

# 4. Verify NVIDIA GPU on the machine
if command -v nvidia-smi &> /dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
    log_success "Detected Host GPU: ${GPU_NAME}"
else
    log_warn "nvidia-smi not found. Ensure NVIDIA proprietary drivers are installed on this laptop."
fi

# 5. Tailscale Connectivity Check
if ! command -v tailscale &> /dev/null; then
    log_info "Tailscale missing. Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
    systemctl enable --now tailscaled
fi

WORKER_TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
if [ -z "$WORKER_TAILSCALE_IP" ]; then
    echo ""
    log_warn "Tailscale is not authenticated on this machine!"
    log_warn "Please authenticate Tailscale now (e.g. login with your Google/GitHub account):"
    tailscale up
    WORKER_TAILSCALE_IP=$(tailscale ip -4)
fi
log_success "Local Tailscale IP detected: ${WORKER_TAILSCALE_IP}"

# 6. Read or Prompt for Master Tailscale IP
MASTER_TAILSCALE_IP="${1:-${MASTER_TAILSCALE_IP:-}}"
if [ -z "$MASTER_TAILSCALE_IP" ]; then
    echo ""
    read -r -p "Enter Master Node Tailscale IP (e.g., 100.80.20.1): " MASTER_TAILSCALE_IP
fi

if [ -z "$MASTER_TAILSCALE_IP" ]; then
    log_error "Master Tailscale IP is required. Exiting."
    exit 1
fi

# 7. Write runtime environment file (.env) for Docker Compose
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cat <<EOF > .env
MASTER_TAILSCALE_IP=${MASTER_TAILSCALE_IP}
WORKER_TAILSCALE_IP=${WORKER_TAILSCALE_IP}
MASTER_PORT=8000
EOF

log_info "Saved configuration to .env"
log_info "Building and launching Worker container in background via Docker Compose..."

# 8. Launch Worker container via Docker Compose
docker compose down 2>/dev/null || true
docker compose up -d --build

echo ""
log_success "=================================================================="
log_success "  TensorSwarm Worker is now UP and connected to Master!"
log_success "  Local GPU: ${GPU_NAME:-Unknown}"
log_success "  Worker IP: ${WORKER_TAILSCALE_IP}"
log_success "  Master IP: ${MASTER_TAILSCALE_IP}"
log_success "  View live logs anytime: docker compose logs -f"
log_success "=================================================================="
