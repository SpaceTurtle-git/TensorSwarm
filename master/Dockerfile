# ==============================================================================
# TensorSwarm Master Container
# Supports Ray Head, Hybrid GPU execution, and FastAPI Telemetry Backend
# ==============================================================================

FROM rayproject/ray:2.58.0-py310-gpu

USER root

# Install system utilities
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
        curl \
        iputils-ping \
        net-tools \
        procps && \
    rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Application setup
WORKDIR /app
COPY server.py /app/server.py
# Data layer: imported by server.py; its source is also shipped to every worker as `tensorswarm`.
COPY tensorswarm_client.py datasets_api.py /app/
COPY samples /app/samples
COPY dashboard /app/dashboard
COPY agent.py /app/agent.py

RUN chmod +x /app/agent.py

WORKDIR /home/ray
