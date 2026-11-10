# ==============================================================================
# TensorSwarm Worker Container
# Pre-installed with Ray, PyTorch CUDA support, and PyNVML
# ==============================================================================

FROM rayproject/ray:2.58.0-py310-gpu

USER root

# Install system utilities
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
        curl \
        iputils-ping \
        procps && \
    rm -rf /var/lib/apt/lists/*

# Install PyNVML (nvidia-ml-py), requests, and psutil for telemetry
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Setup app directory
WORKDIR /app
COPY agent.py /app/agent.py

RUN chmod +x /app/agent.py

# Run commands as root or default user (trusted lab environment, priority is frictionless access)
WORKDIR /home/ray
