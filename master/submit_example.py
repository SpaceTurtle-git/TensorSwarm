#!/usr/bin/env python3
"""
TensorSwarm Job Submission Example
Demonstrates how to submit a custom Python workload to run strictly on a specific
remote GPU node (e.g., the GTX 1650 or RTX 3050 laptop) via:
  Method A: Ray Native API with NodeAffinitySchedulingStrategy
  Method B: FastAPI HTTP REST API
"""

import os
import sys
import time
import requests

MASTER_TAILSCALE_IP = os.getenv("MASTER_TAILSCALE_IP", "100.64.0.1")
MASTER_API_URL = f"http://{MASTER_TAILSCALE_IP}:8000"


# ==============================================================================
# Method A: Direct Ray API with Node Affinity
# ==============================================================================
def submit_via_ray(target_node_ip: str):
    import ray
    from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy

    print(f"\n[Method A] Connecting to Ray Cluster at ray://{MASTER_TAILSCALE_IP}:10001...")
    ray.init(address=f"ray://{MASTER_TAILSCALE_IP}:10001", ignore_reinit_error=True)

    # 1. Discover all active Ray nodes and match the target Tailscale IP
    nodes = ray.nodes()
    matched = next((n for n in nodes if n["NodeManagerAddress"] == target_node_ip and n["Alive"]), None)

    if not matched:
        print(f"[ERROR] Node with Tailscale IP {target_node_ip} not found in Ray cluster!")
        return

    target_node_id = matched["NodeID"]
    print(f"[INFO] Found target node: {matched['NodeName']} (NodeID: {target_node_id})")

    # 2. Define a remote function pinned strictly to that NodeID
    @ray.remote(
        num_gpus=1,
        scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=target_node_id, soft=False)
    )
    def gpu_benchmark_task():
        import socket
        import torch

        hostname = socket.gethostname()
        gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "No GPU"

        print(f"[Remote Execution] Running on '{hostname}' using GPU: '{gpu_name}'")

        # Execute matrix multiplication
        if torch.cuda.is_available():
            x = torch.randn(8192, 8192, device="cuda")
            y = torch.matmul(x, x)
            return {
                "hostname": hostname,
                "gpu": gpu_name,
                "norm": y.norm().item(),
                "status": "SUCCESS"
            }
        return {"hostname": hostname, "gpu": "CPU", "status": "NO_CUDA"}

    # 3. Dispatch the task
    print(f"[INFO] Dispatching GPU task to {target_node_ip}...")
    future = gpu_benchmark_task.remote()
    result = ray.get(future)
    print(f"[SUCCESS] Ray Execution Result: {result}")


# ==============================================================================
# Method B: HTTP REST API Submission (Used by Web Dashboard / CLI)
# ==============================================================================
def submit_via_api(target_node_ip: str):
    print(f"\n[Method B] Submitting job via FastAPI endpoint to target {target_node_ip}...")

    custom_python_script = """
import torch
import socket

hostname = socket.gethostname()
gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "No GPU"

print(f"Task executed on host: {hostname}")
print(f"Active GPU device: {gpu_name}")

if torch.cuda.is_available():
    a = torch.randn(2048, 2048, device="cuda")
    b = torch.matmul(a, a)
    result = f"Matrix calculation succeeded on {gpu_name}! Tensor sum: {b.sum().item():.2f}"
else:
    result = "Executed without GPU."
"""

    payload = {
        "script_code": custom_python_script,
        "target_node_ip": target_node_ip,
        "num_gpus": 1.0,
        "job_name": "cli_benchmark",
    }

    resp = requests.post(f"{MASTER_API_URL}/api/v1/jobs/submit", json=payload)
    if resp.status_code not in (200, 202):
        print(f"[ERROR] API submission failed: {resp.status_code} - {resp.text}")
        return

    job_data = resp.json()
    job_id = job_data["job_id"]
    print(f"[INFO] Job submitted! Job ID: {job_id}. Polling for completion...")

    # Poll status
    for _ in range(15):
        time.sleep(1)
        poll_resp = requests.get(f"{MASTER_API_URL}/api/v1/jobs/{job_id}")
        data = poll_resp.json()
        status = data["status"]
        if status in ("COMPLETED", "FAILED"):
            print("\n==================== Job Finished ====================")
            print(f"Status:       {status}")
            print(f"Executed On:  {data.get('executed_on_node')}")
            print(f"GPU Used:     {data.get('gpu_used')}")
            print(f"Duration:     {data.get('execution_time_sec')}s")
            print(f"Stdout:\n{data.get('stdout')}")
            print(f"Result:       {data.get('result')}")
            if data.get("error"):
                print(f"Error:\n{data.get('error')}")
            print("======================================================\n")
            return

    print("[WARN] Job polling timed out.")


if __name__ == "__main__":
    target_ip = sys.argv[1] if len(sys.argv) > 1 else input("Enter Target Worker Tailscale IP: ").strip()
    # Execute via REST API
    submit_via_api(target_ip)
