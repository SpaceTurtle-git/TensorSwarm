# TensorSwarm: Worker Node Security & Container Hardening Guide

When pooling consumer laptops and remote PCs across the internet to execute arbitrary Python code and AI jobs via Ray, host isolation is paramount. An untrusted or buggy Python script must **never** be able to escape the container, read host files, or pivot to the worker's local home network (LAN).

---

## 1. Filesystem & Host Isolation Checklist

| Control | Implementation | Security Rationale |
| :--- | :--- | :--- |
| **No Docker Socket Mounting** | Never mount `/var/run/docker.sock` | Mounting the Docker socket grants full root privileges on the host machine via the Docker daemon API. |
| **No Host Root / Home Mounts** | Do not use `-v /:/host` or `-v /home/$USER:/...` | Prevents arbitrary code from modifying SSH keys (`~/.ssh/authorized_keys`), reading browser sessions, or stealing local credentials. |
| **Drop All Linux Capabilities** | `--cap-drop=ALL` | Strips raw socket creation, kernel module loading, and system administrative capabilities. |
| **Prevent Privilege Escalation** | `--security-opt=no-new-privileges:true` | Disallows binaries with `setuid` bits (e.g. `sudo`) from escalating privileges inside the container. |
| **Non-Root Execution** | Container user `ray` (`UID:GID 1000:1000`) | Minimizes blast radius if an unpatched kernel vulnerability is exploited. |
| **Ephemeral In-Memory `/tmp`** | `--tmpfs /tmp:rw,noexec,nosuid,size=4g` | Mounts `/tmp` in RAM with execution disallowed (`noexec`), preventing dropped shellcode execution. |

---

## 2. Network Isolation & Anti-Lateral Movement

When workers run arbitrary training code, they must **only** be able to talk to the Master node (Tailscale IP) and public package repositories (e.g., PyPI, HuggingFace), and **never** the user's private home network (192.168.x.x, local NAS, printer, or smart devices).

### A. Host-Level IPTables Rules (for `--net=host` setups)
If running with host networking to leverage the laptop's Tailscale interface, apply these rules on the worker laptop to restrict the `ray` user UID (1000) from scanning the local home Wi-Fi:

```bash
# Block UID 1000 from reaching RFC 1918 private subnets (Home LAN)
sudo iptables -A OUTPUT -m owner --uid-owner 1000 -d 192.168.0.0/16 -j DROP
sudo iptables -A OUTPUT -m owner --uid-owner 1000 -d 172.16.0.0/12 -j DROP
sudo iptables -A OUTPUT -m owner --uid-owner 1000 -d 10.0.0.0/8 -j DROP

# Allow Tailscale CGNAT subnet (100.64.0.0/10)
sudo iptables -I OUTPUT 1 -m owner --uid-owner 1000 -d 100.64.0.0/10 -j ACCEPT
```

### B. Tailscale ACL Configuration (Coordination Server)
In the Tailscale Admin Console (`Access Controls`), enforce strict tag-based routing:

```jsonc
{
  "tagOwners": {
    "tag:master": ["admin@yourdomain.com"],
    "tag:worker": ["admin@yourdomain.com"]
  },
  "acls": [
    // 1. Workers can ONLY send traffic to Master on designated ports
    {
      "action": "accept",
      "src": ["tag:worker"],
      "dst": [
        "tag:master:6379",     // Ray GCS
        "tag:master:10001",    // Ray Client
        "tag:master:8000",     // FastAPI Telemetry
        "tag:master:20000-20050" // Ray Worker Ports
      ]
    },
    // 2. Master can communicate with Workers on Ray ports
    {
      "action": "accept",
      "src": ["tag:master"],
      "dst": ["tag:worker:20000-20050"]
    }
    // 3. Workers CANNOT communicate with other Workers (P2P cross-talk disabled)
  ]
}
```

---

## 3. Resource & Hardware Clamping

To prevent runaway training scripts from crashing the worker's laptop:

```bash
docker run --rm \
    --gpus all \
    --memory="28g" \
    --memory-swap="28g" \
    --cpus="12.0" \
    --shm-size="8g" \
    ...
```
* **`--memory` & `--memory-swap`**: Prevents OOM thrashing on the host OS. If the script exceeds 28GB, only the container process is terminated.
* **`--cpus`**: Leaves host CPU cores free for host system processes and UI responsiveness.
* **`--shm-size`**: Required for Ray Plasma object store without touching disk.

---

## 4. Multi-Tenant Sandbox Architecture (Production Recommendation)

For true multi-tenant untrusted execution (e.g. public platform like Vast.ai / RunPod):
* Wrap worker execution inside **gVisor (`runsc`)** or **Kata Containers** (microVMs).
* These replace standard runc with an isolated kernel emulation layer, preventing kernel exploit escapes to the host hardware.
