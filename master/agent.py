#!/usr/bin/env python3
"""
TensorSwarm Worker Telemetry Agent
Monitors local GPU hardware (GTX 1650, RTX 3050, etc.) via PyNVML.
Sends real-time telemetry heartbeats to the Master Node every 5 seconds.

Runs unchanged in three places:
  - Linux Docker containers (worker/master docker-compose)
  - Linux hosts directly
  - Windows natively, from the portable USB python.exe (no WSL / Docker)
"""

import os
import sys
import time
import shutil
import signal
import socket
import logging
import platform
import ipaddress
import subprocess
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

import requests
import psutil

IS_WINDOWS = sys.platform == "win32"
# Tailscale assigns node addresses from the CGNAT block 100.64.0.0/10.
TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [TelemetryAgent] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("TelemetryAgent")

try:
    import pynvml
    HAS_PYNVML = True
except ImportError:
    HAS_PYNVML = False
    logger.warning("pynvml (nvidia-ml-py) not found. GPU monitoring will be disabled.")


# ==============================================================================
# Cross-platform helpers
# ==============================================================================

def _is_ipv4(value: str) -> bool:
    try:
        return isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address)
    except ValueError:
        return False


def _find_tailscale_cli() -> Optional[str]:
    """Locate the Tailscale CLI on Linux (PATH) or Windows (PATH or default install dir)."""
    found = shutil.which("tailscale")  # honours PATHEXT, so finds tailscale.exe on Windows
    if found:
        return found
    if IS_WINDOWS:
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                candidate = os.path.join(base, "Tailscale", "tailscale.exe")
                if os.path.isfile(candidate):
                    return candidate
    return None


def _run_quiet(cmd: List[str], timeout: float = 5.0) -> Optional[str]:
    """Run a short command and return stdout, or None on any failure.

    On Windows, CREATE_NO_WINDOW stops a console window flashing up when the agent itself
    runs hidden in the background.
    """
    kwargs: Dict[str, Any] = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    try:
        res = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            **kwargs,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("Command %s failed: %s", cmd, exc)
        return None
    if res.returncode != 0:
        logger.debug("Command %s exited %s: %s", cmd, res.returncode, (res.stderr or "").strip())
        return None
    return res.stdout


def _tailscale_ip_from_interfaces() -> Optional[str]:
    """Find a 100.64.0.0/10 address on a local NIC (works without the CLI, on any OS).

    Interfaces named like Tailscale ("Tailscale" on Windows, "tailscale0" on Linux) win;
    otherwise any CGNAT address is used.
    """
    try:
        interfaces = psutil.net_if_addrs()
    except Exception:
        return None
    fallback = None
    for name, addrs in interfaces.items():
        for addr in addrs:
            if addr.family != socket.AF_INET or not _is_ipv4(addr.address):
                continue
            if ipaddress.ip_address(addr.address) not in TAILSCALE_NET:
                continue
            if "tailscale" in name.lower():
                return addr.address
            fallback = fallback or addr.address
    return fallback


AGENT_VERSION = "2.2"

# NVML "clocks event / throttle reason" bits -> readable labels.
_THROTTLE_BITS = {
    0x0000000000000001: "idle",
    0x0000000000000002: "app clock setting",
    0x0000000000000004: "power cap",
    0x0000000000000008: "hw slowdown",
    0x0000000000000020: "sync boost",
    0x0000000000000040: "thermal (sw)",
    0x0000000000000080: "thermal (hw)",
    0x0000000000000100: "power brake (hw)",
    0x0000000000000200: "display clock",
}

_ARCH_NAMES = {2: "Kepler", 3: "Maxwell", 4: "Pascal", 5: "Volta", 6: "Turing",
               7: "Ampere", 8: "Ada", 9: "Hopper", 10: "Blackwell"}


def _nv(fn, *args, default=None):
    """Call an NVML function; any NotSupported / missing-symbol error becomes `default`."""
    try:
        if fn is None:
            return default
        return fn(*args)
    except Exception:
        return default


def _nvml_fn(name: str):
    return getattr(pynvml, name, None) if HAS_PYNVML else None


def _text(value) -> Optional[str]:
    if value is None:
        return None
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)


def _cpu_model() -> str:
    """Human CPU name ('AMD Ryzen 5 4600H'), not platform.processor()'s family string."""
    try:
        if IS_WINDOWS:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or platform.machine()


def _local_datasets() -> List[Dict[str, str]]:
    """Datasets this PC can use without a network transfer (same layout as tensorswarm_client):
    cache/<name>@<version>/.ready (pulled from the Master) and store/<name>@<version> (the Master's
    own store, or copies seeded from the USB stick). Lets the Master show where data lives and
    schedule jobs next to their data."""
    root = os.environ.get("TENSORSWARM_DATA_DIR")
    if not root:
        if os.name == "nt":
            root = os.path.join(os.environ.get("ProgramData") or r"C:\ProgramData", "TensorSwarm", "datasets")
        else:
            root = os.path.join(os.path.expanduser("~"), ".tensorswarm", "datasets")
    out: List[Dict[str, str]] = []
    seen = set()
    for kind, marker in (("store", "manifest.json"), ("cache", ".ready")):
        try:
            entries = list(os.scandir(os.path.join(root, kind)))
        except OSError:
            continue
        for e in entries:
            if e.name.startswith(".") or "@" not in e.name or e.name in seen:
                continue
            if e.is_dir() and os.path.exists(os.path.join(e.path, marker)):
                seen.add(e.name)
                out.append({"id": e.name, "location": kind})
    return out


def _process_name(pid: int) -> str:
    try:
        return psutil.Process(pid).name()
    except Exception:
        return "pid %d" % pid


class TelemetryAgent:
    def __init__(self):
        # Networking Configuration
        self.master_ip = os.getenv("MASTER_TAILSCALE_IP", "100.64.0.1")
        self.master_port = int(os.getenv("MASTER_PORT", "8000"))
        self.master_url = f"http://{self.master_ip}:{self.master_port}/api/v1/telemetry/heartbeat"
        self.heartbeat_interval = int(os.getenv("HEARTBEAT_INTERVAL", "5"))

        # Node Identity
        self.hostname = socket.gethostname()
        self.tailscale_ip = self._resolve_tailscale_ip()
        self.node_id = os.getenv("NODE_ID", f"{self.hostname}-{self.tailscale_ip}")

        # Hardware Initialization
        self.nvml_initialized = False
        self._init_nvml()
        self.system_info = self._collect_system_info()

        # Lifecycle control
        self.running = True
        signal.signal(signal.SIGINT, self._handle_shutdown)
        # SIGTERM: Linux/Docker stop. SIGBREAK: Ctrl+Break / console close on Windows.
        # (Stop-Process / TerminateProcess on Windows cannot be caught by any handler.)
        for sig_name in ("SIGTERM", "SIGBREAK"):
            sig = getattr(signal, sig_name, None)
            if sig is not None:
                try:
                    signal.signal(sig, self._handle_shutdown)
                except (ValueError, OSError):
                    pass

    def _resolve_tailscale_ip(self) -> str:
        """Resolve this node's Tailscale IP. It must match Ray's --node-ip-address."""
        # 1. Explicit override (the start scripts and docker-compose set this).
        env_ip = (os.getenv("WORKER_TAILSCALE_IP") or "").strip()
        if env_ip:
            if _is_ipv4(env_ip):
                return env_ip
            logger.warning("Ignoring WORKER_TAILSCALE_IP=%r: not an IPv4 address.", env_ip)

        # 2. Tailscale CLI (Linux: tailscale, Windows: C:\Program Files\Tailscale\tailscale.exe).
        cli = _find_tailscale_cli()
        if cli:
            out = _run_quiet([cli, "ip", "-4"])
            if out:
                for line in out.splitlines():
                    if _is_ipv4(line.strip()):
                        return line.strip()

        # 3. A Tailscale address on a local network interface.
        nic_ip = _tailscale_ip_from_interfaces()
        if nic_ip:
            return nic_ip

        # 4. Last resort: primary outbound IP (will NOT match the Ray node IP over Tailscale).
        logger.warning("No Tailscale IP found; falling back to the primary LAN IP. "
                       "Set WORKER_TAILSCALE_IP to fix node matching in the dashboard.")
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect(("10.255.255.255", 1))
                return s.getsockname()[0]
            finally:
                s.close()
        except Exception:
            return "127.0.0.1"

    def _init_nvml(self) -> None:
        """Initialize NVML connection."""
        if not HAS_PYNVML:
            return
        try:
            pynvml.nvmlInit()
            self.nvml_initialized = True
            driver_ver = pynvml.nvmlSystemGetDriverVersion()
            driver_str = driver_ver.decode("utf-8") if isinstance(driver_ver, bytes) else driver_ver
            logger.info("PyNVML connected successfully. Driver: %s", driver_str)
        except Exception as e:
            logger.warning("Could not initialize NVML: %s. Continuing in CPU-only mode.", e)
            self.nvml_initialized = False

    def _collect_system_info(self) -> Dict[str, Any]:
        """Static facts about this machine, sent with every heartbeat (cheap, never changes)."""
        info: Dict[str, Any] = {
            "os": platform.platform(terse=False),
            "cpu_model": _cpu_model(),
            "cpu_cores_physical": psutil.cpu_count(logical=False),
            "cpu_cores_logical": psutil.cpu_count(logical=True),
            "python_version": platform.python_version(),
            "agent_version": AGENT_VERSION,
            "boot_time": datetime.fromtimestamp(psutil.boot_time(), timezone.utc).isoformat(),
            "driver_version": None,
            "cuda_driver_version": None,
            "nvml_version": None,
        }
        if self.nvml_initialized:
            info["driver_version"] = _text(_nv(_nvml_fn("nvmlSystemGetDriverVersion")))
            info["nvml_version"] = _text(_nv(_nvml_fn("nvmlSystemGetNVMLVersion")))
            cuda = _nv(_nvml_fn("nvmlSystemGetCudaDriverVersion"))
            if isinstance(cuda, int) and cuda > 0:
                info["cuda_driver_version"] = "%d.%d" % (cuda // 1000, (cuda % 1000) // 10)
        return info

    def _gpu_processes(self, handle) -> List[Dict[str, Any]]:
        """Processes holding a CUDA / graphics context on this GPU.

        On Windows (WDDM driver model) NVML cannot attribute VRAM per process, so
        used_vram_mb is null there; on Linux it is exact.
        """
        procs: Dict[int, Dict[str, Any]] = {}
        for kind, fn_names in (("compute", ("nvmlDeviceGetComputeRunningProcesses_v3",
                                            "nvmlDeviceGetComputeRunningProcesses")),
                               ("graphics", ("nvmlDeviceGetGraphicsRunningProcesses_v3",
                                             "nvmlDeviceGetGraphicsRunningProcesses"))):
            items = None
            for fn_name in fn_names:
                items = _nv(_nvml_fn(fn_name), handle)
                if items is not None:
                    break
            for item in items or []:
                pid = int(getattr(item, "pid", 0) or 0)
                if pid <= 0:
                    continue
                used = getattr(item, "usedGpuMemory", None)
                # NVML reports "not available" as None or a huge sentinel value.
                used_mb = round(used / (1024 ** 2), 1) if isinstance(used, int) and 0 <= used < (1 << 50) else None
                entry = procs.setdefault(pid, {"pid": pid, "name": _process_name(pid),
                                               "type": kind, "used_vram_mb": used_mb})
                if entry["type"] != kind:
                    entry["type"] = "compute+graphics"
                if used_mb is not None:
                    entry["used_vram_mb"] = max(entry["used_vram_mb"] or 0.0, used_mb)
        ordered = sorted(procs.values(), key=lambda p: (p["used_vram_mb"] or 0.0), reverse=True)
        return ordered[:25]

    def _collect_gpu_stats(self) -> List[Dict[str, Any]]:
        """Collect real-time metrics for all NVIDIA GPUs (GTX 1650, RTX 3050, etc.)."""
        gpus: List[Dict[str, Any]] = []
        if not self.nvml_initialized:
            return gpus

        try:
            device_count = pynvml.nvmlDeviceGetCount()
        except Exception as e:
            logger.error("Error collecting GPU stats: %s", e)
            return gpus

        clock_g = getattr(pynvml, "NVML_CLOCK_GRAPHICS", 0)
        clock_sm = getattr(pynvml, "NVML_CLOCK_SM", 1)
        clock_mem = getattr(pynvml, "NVML_CLOCK_MEM", 2)

        for idx in range(device_count):
            try:
                handle = pynvml.nvmlDeviceGetHandleByIndex(idx)
                name = _text(pynvml.nvmlDeviceGetName(handle)) or ("GPU %d" % idx)
                uuid = _text(_nv(pynvml.nvmlDeviceGetUUID, handle)) or ("gpu-%d" % idx)

                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                util = _nv(pynvml.nvmlDeviceGetUtilizationRates, handle)
                temp_c = _nv(pynvml.nvmlDeviceGetTemperature, handle, getattr(pynvml, "NVML_TEMPERATURE_GPU", 0))
                power_mw = _nv(_nvml_fn("nvmlDeviceGetPowerUsage"), handle)
                limit_mw = _nv(_nvml_fn("nvmlDeviceGetEnforcedPowerLimit"), handle)
                cc = _nv(_nvml_fn("nvmlDeviceGetCudaComputeCapability"), handle)
                enc = _nv(_nvml_fn("nvmlDeviceGetEncoderUtilization"), handle)
                dec = _nv(_nvml_fn("nvmlDeviceGetDecoderUtilization"), handle)
                pstate = _nv(_nvml_fn("nvmlDeviceGetPerformanceState"), handle)
                arch = _nv(_nvml_fn("nvmlDeviceGetArchitecture"), handle)
                reasons = _nv(_nvml_fn("nvmlDeviceGetCurrentClocksEventReasons"), handle)
                if reasons is None:
                    reasons = _nv(_nvml_fn("nvmlDeviceGetCurrentClocksThrottleReasons"), handle)
                clock = _nvml_fn("nvmlDeviceGetClockInfo")
                max_clock = _nvml_fn("nvmlDeviceGetMaxClockInfo")

                gpus.append({
                    "index": idx,
                    "name": name,
                    "uuid": uuid,
                    "total_vram_mb": round(mem.total / (1024 ** 2), 2),
                    "free_vram_mb": round(mem.free / (1024 ** 2), 2),
                    "used_vram_mb": round(mem.used / (1024 ** 2), 2),
                    "gpu_utilization_pct": getattr(util, "gpu", 0) if util else 0,
                    "memory_utilization_pct": getattr(util, "memory", 0) if util else 0,
                    "temperature_c": temp_c,
                    "power_watts": round(power_mw / 1000.0, 2) if isinstance(power_mw, (int, float)) else None,
                    # --- extended details (all optional; null when the GPU/driver does not report it) ---
                    "power_limit_watts": round(limit_mw / 1000.0, 1) if isinstance(limit_mw, (int, float)) else None,
                    "fan_speed_pct": _nv(_nvml_fn("nvmlDeviceGetFanSpeed"), handle),
                    "clock_graphics_mhz": _nv(clock, handle, clock_g),
                    "clock_sm_mhz": _nv(clock, handle, clock_sm),
                    "clock_memory_mhz": _nv(clock, handle, clock_mem),
                    "clock_graphics_max_mhz": _nv(max_clock, handle, clock_g),
                    "clock_sm_max_mhz": _nv(max_clock, handle, clock_sm),
                    "clock_memory_max_mhz": _nv(max_clock, handle, clock_mem),
                    "pcie_gen": _nv(_nvml_fn("nvmlDeviceGetCurrPcieLinkGeneration"), handle),
                    "pcie_gen_max": _nv(_nvml_fn("nvmlDeviceGetMaxPcieLinkGeneration"), handle),
                    "pcie_width": _nv(_nvml_fn("nvmlDeviceGetCurrPcieLinkWidth"), handle),
                    "pcie_width_max": _nv(_nvml_fn("nvmlDeviceGetMaxPcieLinkWidth"), handle),
                    "performance_state": ("P%d" % pstate) if isinstance(pstate, int) and 0 <= pstate < 32 else None,
                    "compute_capability": ("%d.%d" % (cc[0], cc[1])) if isinstance(cc, (tuple, list)) and len(cc) == 2 else None,
                    "architecture": _ARCH_NAMES.get(arch) if isinstance(arch, int) else None,
                    "encoder_utilization_pct": enc[0] if isinstance(enc, (tuple, list)) and enc else None,
                    "decoder_utilization_pct": dec[0] if isinstance(dec, (tuple, list)) and dec else None,
                    "memory_bus_width_bits": _nv(_nvml_fn("nvmlDeviceGetMemoryBusWidth"), handle),
                    "cuda_cores": _nv(_nvml_fn("nvmlDeviceGetNumGpuCores"), handle),
                    "throttle_reasons": [label for bit, label in _THROTTLE_BITS.items()
                                         if isinstance(reasons, int) and reasons & bit],
                    "processes": self._gpu_processes(handle),
                })
            except Exception as e:
                logger.error("Error collecting stats for GPU %d: %s", idx, e)

        return gpus

    def _collect_host_stats(self) -> Dict[str, Any]:
        """Collect host CPU & RAM utilization."""
        ram = psutil.virtual_memory()
        freq = _nv(psutil.cpu_freq)
        return {
            "cpu_utilization_pct": psutil.cpu_percent(interval=None),
            "ram_total_mb": round(ram.total / (1024 ** 2), 2),
            "ram_used_mb": round(ram.used / (1024 ** 2), 2),
            "ram_free_mb": round(ram.available / (1024 ** 2), 2),
            "cpu_freq_mhz": round(freq.current) if freq and freq.current else None,
            "swap_used_pct": _nv(lambda: psutil.swap_memory().percent),
        }

    def send_heartbeat(self, session: requests.Session) -> bool:
        gpus = self._collect_gpu_stats()
        host = self._collect_host_stats()

        # Derive computed node status
        # If any GPU is operating under high load, mark COMPUTING, else AVAILABLE
        is_computing = any(g["gpu_utilization_pct"] > 50 for g in gpus)
        node_status = "COMPUTING" if is_computing else "AVAILABLE"

        payload = {
            "node_id": self.node_id,
            "hostname": self.hostname,
            "tailscale_ip": self.tailscale_ip,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": node_status,
            "gpu_count": len(gpus),
            "gpus": gpus,
            "host": host,
            "system": self.system_info,
            "datasets": _local_datasets(),
        }

        try:
            resp = session.post(self.master_url, json=payload, timeout=3.0)
            if resp.status_code in (200, 201):
                logger.info(
                    "Heartbeat ACK -> Master (%s) | %s | GPUs: %d | Host CPU: %s%%",
                    self.master_ip,
                    node_status,
                    len(gpus),
                    host["cpu_utilization_pct"],
                )
                return True
            else:
                logger.warning("Master returned status %d: %s", resp.status_code, resp.text)
                return False
        except requests.exceptions.RequestException as e:
            logger.warning("Heartbeat failed (Master unreachable at %s): %s", self.master_url, e)
            return False

    def start(self) -> None:
        logger.info("Starting Telemetry Agent [Node: %s | IP: %s | Cadence: %ds]",
                    self.node_id, self.tailscale_ip, self.heartbeat_interval)
        logger.info("Destination: %s", self.master_url)

        # Warm up psutil CPU baseline
        psutil.cpu_percent(interval=None)

        with requests.Session() as session:
            # On Windows, requests picks up the system proxy from the registry; lab PCs
            # often have one, and it would swallow traffic to the Master's 100.x address.
            # Heartbeats go over Tailscale and must always be direct.
            session.trust_env = False
            while self.running:
                start_time = time.monotonic()
                self.send_heartbeat(session)
                elapsed = time.monotonic() - start_time
                sleep_duration = max(0.2, self.heartbeat_interval - elapsed)

                end_sleep = time.monotonic() + sleep_duration
                while self.running and time.monotonic() < end_sleep:
                    time.sleep(0.2)

        self._cleanup()

    def _handle_shutdown(self, signum, frame):
        logger.info("Shutdown signal received (%s). Exiting...", signum)
        self.running = False

    def _cleanup(self):
        if self.nvml_initialized:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass
        logger.info("Telemetry Agent shut down cleanly.")


if __name__ == "__main__":
    agent = TelemetryAgent()
    agent.start()
