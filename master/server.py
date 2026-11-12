"""
TensorSwarm Master Orchestrator & Telemetry Backend
FastAPI server running on the Master node.
- Ingests 5-second worker telemetry heartbeats via PyNVML and keeps ~30 min of history.
- Tracks online, computing, and offline node states.
- Exposes REST APIs for the React/Next.js frontend.
- Provides a Ray job dispatch endpoint targeting specific remote GPUs/nodes.
- Provides Colab-style notebook runtimes: a persistent Python process (Ray actor) pinned
  to a chosen GPU node, executing cells one at a time with streamed output.

Platform notes: runs unchanged in the Linux Docker image and natively on Windows from the
portable python.exe. Nothing here touches /dev/shm or other POSIX-only paths: this
process only *attaches* to a Ray cluster that `ray start` already created, and each node's
object store backing (/dev/shm on Linux, Ray-managed shared memory on Windows) is chosen by
`ray start` on that node.
"""

import os
import sys
import uuid
import time
import asyncio
import logging
import threading
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Deque, Dict, List, Optional, Any

from fastapi import FastAPI, HTTPException, Query, status, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [MasterServer] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("TensorSwarm.Server")

# Lazy Ray import for clean execution
try:
    import ray
    from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy
    HAS_RAY = True
except ImportError:
    HAS_RAY = False
    logger.warning("Ray is not installed in the current environment. Job scheduling will run in mock mode.")

if HAS_RAY:
    # Ship job functions and the notebook kernel class defined in this module *by value*.
    # By default cloudpickle sends a reference ("server.execute_script_on_node"), so every
    # worker would need server.py on its import path. Workers (Windows or Linux Docker)
    # only carry agent.py, so jobs pinned to them would fail with "No module named 'server'".
    try:
        from ray import cloudpickle as _ray_cloudpickle
        _ray_cloudpickle.register_pickle_by_value(sys.modules[__name__])
    except Exception as exc:  # pragma: no cover - defensive, depends on Ray version
        logger.warning("Could not enable by-value pickling for job functions: %s", exc)

# ---- Data layer --------------------------------------------------------------------------
# tensorswarm_client.py is both a helper module for this server AND, as source text, the
# `tensorswarm` module installed inside every notebook runtime and job on the workers
# (`ts.dataset("name")`). Shipping source (not a pickled reference) means workers need no
# extra files, and a code update on the Master reaches every worker on its next runtime.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tensorswarm_client as tsc            # noqa: E402
import datasets_api                         # noqa: E402

TS_CLIENT_SOURCE = (Path(__file__).resolve().parent / "tensorswarm_client.py").read_text(encoding="utf-8")


def master_api_url() -> str:
    """How workers reach this API. Workers are other PCs, so never 127.0.0.1 unless forced."""
    explicit = os.getenv("TENSORSWARM_MASTER_API", "").strip()
    if explicit:
        return explicit.rstrip("/")
    return f"http://{os.getenv('MASTER_TAILSCALE_IP', '127.0.0.1')}:{os.getenv('MASTER_PORT', os.getenv('PORT', '8000'))}"


def _install_ts_client(source: str, master_api: str):
    """Runs on the worker: install the client source as module `tensorswarm` (once per process)."""
    import types

    mod = sys.modules.get("tensorswarm")
    if mod is None or mod.__dict__.get("_TS_SOURCE") != source:
        mod = types.ModuleType("tensorswarm", "TensorSwarm data client (ts.dataset, ts.download, ...)")
        mod.__file__ = "tensorswarm_client.py"
        sys.modules["tensorswarm"] = mod          # before exec: dataclasses/typing look it up
        exec(compile(source, "tensorswarm_client.py", "exec"), mod.__dict__)
        mod.__dict__["_TS_SOURCE"] = source
    mod._activate(master_api)
    return mod


SAMPLES_DIR = Path(os.getenv("TENSORSWARM_SAMPLES_DIR", str(Path(__file__).resolve().parent / "samples")))
HISTORY_SAMPLES = int(os.getenv("TENSORSWARM_HISTORY_SAMPLES", "360"))          # 360 x 5 s = 30 min
KERNEL_IDLE_MINUTES = float(os.getenv("TENSORSWARM_KERNEL_IDLE_MINUTES", "60"))  # free idle GPUs
KERNEL_START_TIMEOUT = float(os.getenv("TENSORSWARM_KERNEL_START_TIMEOUT", "90"))


# ==============================================================================
# Pydantic Schemas
# ==============================================================================

class GPUProcess(BaseModel):
    pid: int
    name: str
    type: str = "compute"
    used_vram_mb: Optional[float] = None   # null on Windows (WDDM cannot attribute VRAM)


class GPUStats(BaseModel):
    index: int
    name: str
    uuid: str
    total_vram_mb: float
    free_vram_mb: float
    used_vram_mb: float
    gpu_utilization_pct: float
    memory_utilization_pct: float
    temperature_c: Optional[float] = None
    power_watts: Optional[float] = None
    # Extended telemetry (agent >= 2.1). Optional so older Linux/Docker agents still validate.
    power_limit_watts: Optional[float] = None
    fan_speed_pct: Optional[float] = None
    clock_graphics_mhz: Optional[float] = None
    clock_sm_mhz: Optional[float] = None
    clock_memory_mhz: Optional[float] = None
    clock_graphics_max_mhz: Optional[float] = None
    clock_sm_max_mhz: Optional[float] = None
    clock_memory_max_mhz: Optional[float] = None
    pcie_gen: Optional[int] = None
    pcie_gen_max: Optional[int] = None
    pcie_width: Optional[int] = None
    pcie_width_max: Optional[int] = None
    performance_state: Optional[str] = None
    compute_capability: Optional[str] = None
    architecture: Optional[str] = None
    encoder_utilization_pct: Optional[float] = None
    decoder_utilization_pct: Optional[float] = None
    memory_bus_width_bits: Optional[int] = None
    cuda_cores: Optional[int] = None
    throttle_reasons: List[str] = Field(default_factory=list)
    processes: List[GPUProcess] = Field(default_factory=list)


class HostStats(BaseModel):
    cpu_utilization_pct: float
    ram_total_mb: float
    ram_used_mb: float
    ram_free_mb: float
    cpu_freq_mhz: Optional[float] = None
    swap_used_pct: Optional[float] = None


class SystemInfo(BaseModel):
    os: Optional[str] = None
    cpu_model: Optional[str] = None
    cpu_cores_physical: Optional[int] = None
    cpu_cores_logical: Optional[int] = None
    python_version: Optional[str] = None
    agent_version: Optional[str] = None
    boot_time: Optional[str] = None
    driver_version: Optional[str] = None
    cuda_driver_version: Optional[str] = None
    nvml_version: Optional[str] = None


class HeartbeatPayload(BaseModel):
    node_id: str
    hostname: str
    tailscale_ip: str
    timestamp: datetime
    status: str = "AVAILABLE"  # AVAILABLE, COMPUTING
    gpu_count: int
    gpus: List[GPUStats] = Field(default_factory=list)
    host: HostStats
    system: Optional[SystemInfo] = None
    # Dataset ids present on this PC: {"id": ..., "location": "cache"|"store"} (agent >= 2.2)
    datasets: Optional[List[Dict[str, str]]] = None


class NodeRecord(BaseModel):
    node_id: str
    hostname: str
    tailscale_ip: str
    status: str  # AVAILABLE, COMPUTING, OFFLINE
    last_heartbeat: datetime
    gpu_count: int
    gpus: List[GPUStats]
    host: HostStats
    system: Optional[SystemInfo] = None
    datasets: List[Dict[str, str]] = Field(default_factory=list)
    active_jobs: int = 0
    active_kernels: int = 0


class JobSubmitRequest(BaseModel):
    script_code: str = Field(..., description="Python script string to execute on the cluster")
    target_node_ip: Optional[str] = Field(
        None, description="Specific worker Tailscale IP (e.g. 100.80.20.5). If omitted, Ray auto-schedules."
    )
    num_gpus: float = Field(1.0, ge=0, description="GPU requirement (e.g. 1.0 for 1 GPU, 0.5 to share, 0 for CPU)")
    num_cpus: Optional[float] = Field(None, ge=0, le=256, description=(
        "CPU cores reserved for the job (default 1). PyTorch/NumPy use this many threads. "
        "With num_gpus=0 the job can run on ANY PC, including PCs without a GPU."))
    job_name: Optional[str] = "custom_script"
    datasets: List[str] = Field(default_factory=list, description=(
        "Dataset refs ('name' or 'name@version') the script needs. They are synced to the worker "
        "BEFORE the script starts, and without target_node_ip a worker that already holds them is preferred."))


class JobResult(BaseModel):
    job_id: str
    job_name: str
    status: str  # PENDING, RUNNING, COMPLETED, FAILED
    submitted_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    execution_time_sec: Optional[float] = None
    target_node_ip: Optional[str] = None
    num_gpus: float = 1.0
    num_cpus: Optional[float] = None
    executed_on_node: Optional[str] = None
    executed_on_ip: Optional[str] = None
    gpu_used: Optional[str] = None
    vram_peak_mb: Optional[float] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    result: Optional[Any] = None
    error: Optional[str] = None


class ClusterSummary(BaseModel):
    total_nodes: int
    active_nodes: int
    offline_nodes: int
    total_gpus: int
    available_gpus: int
    total_vram_gb: float
    used_vram_gb: float
    avg_gpu_utilization_pct: float
    total_power_watts: float = 0.0
    max_temperature_c: Optional[float] = None
    running_jobs: int = 0
    active_kernels: int = 0


class KernelCreateRequest(BaseModel):
    target_node_ip: Optional[str] = Field(None, description="Pin the runtime to this node (Tailscale IP). Omit for any GPU.")
    num_gpus: float = Field(1.0, ge=0, le=8, description="GPU share reserved for the runtime (1 = whole GPU, 0 = CPU only)")
    num_cpus: Optional[float] = Field(None, ge=0, le=256, description="CPU cores reserved (default 1); torch uses this many threads")
    name: Optional[str] = None
    datasets: List[str] = Field(default_factory=list, description="Prefer a worker that already holds these datasets")


class KernelRecord(BaseModel):
    kernel_id: str
    name: Optional[str] = None
    status: str  # STARTING, READY, DEAD, ERROR
    target_node_ip: Optional[str] = None
    num_gpus: float = 1.0
    num_cpus: Optional[float] = None
    created_at: datetime
    last_activity: datetime
    info: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    execution_count: int = 0


class ExecuteRequest(BaseModel):
    code: str


# ==============================================================================
# In-Memory Fleet Registry & Job Store
# ==============================================================================

class FleetRegistry:
    def __init__(self, stale_timeout_sec: int = 15):
        self._nodes: Dict[str, NodeRecord] = {}
        self._history: Dict[str, Deque[Dict[str, Any]]] = {}
        self._jobs: Dict[str, JobResult] = {}
        self._lock = asyncio.Lock()
        self.stale_timeout = timedelta(seconds=stale_timeout_sec)

    async def upsert_heartbeat(self, payload: HeartbeatPayload) -> NodeRecord:
        now = datetime.now(timezone.utc)
        async with self._lock:
            existing = self._nodes.get(payload.node_id)
            active_jobs = existing.active_jobs if existing else 0
            active_kernels = existing.active_kernels if existing else 0

            # If node has active jobs or high GPU load, mark COMPUTING, else AVAILABLE
            status = "COMPUTING" if (active_jobs > 0 or payload.status == "COMPUTING") else "AVAILABLE"

            record = NodeRecord(
                node_id=payload.node_id,
                hostname=payload.hostname,
                tailscale_ip=payload.tailscale_ip,
                status=status,
                last_heartbeat=now,
                gpu_count=payload.gpu_count,
                gpus=payload.gpus,
                host=payload.host,
                system=payload.system or (existing.system if existing else None),
                datasets=payload.datasets if payload.datasets is not None else (existing.datasets if existing else []),
                active_jobs=active_jobs,
                active_kernels=active_kernels,
            )
            self._nodes[payload.node_id] = record

            history = self._history.setdefault(payload.node_id, deque(maxlen=HISTORY_SAMPLES))
            history.append({
                "t": int(now.timestamp() * 1000),
                "cpu": payload.host.cpu_utilization_pct,
                "ram_used_mb": payload.host.ram_used_mb,
                "gpus": [{
                    "index": g.index,
                    "util": g.gpu_utilization_pct,
                    "mem_util": g.memory_utilization_pct,
                    "vram_used_mb": g.used_vram_mb,
                    "vram_total_mb": g.total_vram_mb,
                    "temp": g.temperature_c,
                    "power": g.power_watts,
                    "clock_sm": g.clock_sm_mhz,
                } for g in payload.gpus],
            })
            return record

    async def mark_stale_nodes(self) -> int:
        """Mark nodes that missed heartbeats for > stale_timeout as OFFLINE."""
        now = datetime.now(timezone.utc)
        changed = 0
        async with self._lock:
            for node_id, record in self._nodes.items():
                if record.status != "OFFLINE" and (now - record.last_heartbeat) > self.stale_timeout:
                    record.status = "OFFLINE"
                    changed += 1
                    logger.warning("Node '%s' (%s) marked OFFLINE (timeout > %ds)",
                                   node_id, record.tailscale_ip, self.stale_timeout.total_seconds())
        return changed

    async def get_all_nodes(self) -> List[NodeRecord]:
        await self.mark_stale_nodes()
        async with self._lock:
            return list(self._nodes.values())

    async def get_history(self, node_id: str, minutes: float) -> Optional[List[Dict[str, Any]]]:
        async with self._lock:
            history = self._history.get(node_id)
            if history is None:
                return None
            cutoff = int((time.time() - minutes * 60) * 1000)
            return [s for s in history if s["t"] >= cutoff]

    async def get_node_by_ip(self, ip: str) -> Optional[NodeRecord]:
        await self.mark_stale_nodes()
        async with self._lock:
            for node in self._nodes.values():
                if node.tailscale_ip == ip:
                    return node
            return None

    async def set_kernel_count(self, ip: Optional[str], delta: int):
        if not ip:
            return
        async with self._lock:
            for node in self._nodes.values():
                if node.tailscale_ip == ip:
                    node.active_kernels = max(0, node.active_kernels + delta)

    async def get_cluster_summary(self, active_kernels: int = 0) -> ClusterSummary:
        await self.mark_stale_nodes()
        async with self._lock:
            total_nodes = len(self._nodes)
            active = [n for n in self._nodes.values() if n.status in ("AVAILABLE", "COMPUTING")]
            offline_count = sum(1 for n in self._nodes.values() if n.status == "OFFLINE")

            total_gpus = sum(n.gpu_count for n in active)
            available_gpus = sum(
                1 for n in active if n.status == "AVAILABLE"
                for g in n.gpus if g.gpu_utilization_pct < 40
            )

            all_gpus = [g for n in active for g in n.gpus]
            total_vram_mb = sum(g.total_vram_mb for g in all_gpus)
            used_vram_mb = sum(g.used_vram_mb for g in all_gpus)
            util_sum = sum(g.gpu_utilization_pct for g in all_gpus)
            avg_util = (util_sum / len(all_gpus)) if all_gpus else 0.0
            temps = [g.temperature_c for g in all_gpus if g.temperature_c is not None]
            running_jobs = sum(1 for j in self._jobs.values() if j.status in ("PENDING", "RUNNING"))

            return ClusterSummary(
                total_nodes=total_nodes,
                active_nodes=len(active),
                offline_nodes=offline_count,
                total_gpus=total_gpus,
                available_gpus=available_gpus,
                total_vram_gb=round(total_vram_mb / 1024.0, 2),
                used_vram_gb=round(used_vram_mb / 1024.0, 2),
                avg_gpu_utilization_pct=round(avg_util, 1),
                total_power_watts=round(sum(g.power_watts or 0.0 for g in all_gpus), 1),
                max_temperature_c=max(temps) if temps else None,
                running_jobs=running_jobs,
                active_kernels=active_kernels,
            )

    async def record_job(self, job: JobResult):
        async with self._lock:
            self._jobs[job.job_id] = job
            # Increment active job count on target node
            if job.target_node_ip:
                for node in self._nodes.values():
                    if node.tailscale_ip == job.target_node_ip:
                        node.active_jobs += 1
                        node.status = "COMPUTING"

    async def update_job(self, job_id: str, updates: Dict[str, Any]):
        async with self._lock:
            job = self._jobs.get(job_id)
            if job:
                for k, v in updates.items():
                    setattr(job, k, v)
                # If job finished, decrement node active job count
                if updates.get("status") in ("COMPLETED", "FAILED") and job.target_node_ip:
                    for node in self._nodes.values():
                        if node.tailscale_ip == job.target_node_ip:
                            node.active_jobs = max(0, node.active_jobs - 1)
                            if node.active_jobs == 0 and node.status == "COMPUTING":
                                node.status = "AVAILABLE"

    async def get_job(self, job_id: str) -> Optional[JobResult]:
        async with self._lock:
            return self._jobs.get(job_id)

    async def list_jobs(self, limit: int = 20) -> List[JobResult]:
        async with self._lock:
            all_jobs = list(self._jobs.values())
            all_jobs.sort(key=lambda j: j.submitted_at, reverse=True)
            return all_jobs[:limit]


registry = FleetRegistry(stale_timeout_sec=15)


# ==============================================================================
# Ray Connection Helper
# ==============================================================================

_ray_connection_lock = threading.Lock()


def ensure_ray_connected():
    """Connect to the Ray cluster if not already connected."""
    with _ray_connection_lock:
        if not HAS_RAY:
            return False
        if not ray.is_initialized():
            master_ip = os.getenv("MASTER_TAILSCALE_IP", "127.0.0.1")
            attempts = [
                f"ray://{master_ip}:10001",
                "ray://127.0.0.1:10001",
                "auto",
            ]
            for addr in attempts:
                try:
                    ray.init(address=addr, ignore_reinit_error=True)
                    logger.info("Successfully connected to Ray Cluster via '%s'", addr)
                    return True
                except Exception as e:
                    logger.warning("Failed connecting to Ray via '%s': %s", addr, e)
            logger.warning("Could not connect to Ray via any address.")
            return False
        return True


DEFAULT_NUM_CPUS = 1.0


def _cpus(value: Optional[float]) -> float:
    return DEFAULT_NUM_CPUS if value is None else float(value)


def _res(node: Dict[str, Any], key: str) -> float:
    return float(node.get("Resources", {}).get(key, 0.0))


def _pick_ray_node(target_ip: str, num_gpus: float, num_cpus: float = 0.0) -> Optional[Dict[str, Any]]:
    """Ray node for a Tailscale IP. Several Ray nodes can share one IP (the Master PC runs
    the head AND a local worker), so prefer the one that can hold the GPUs and CPUs asked for."""
    candidates = [n for n in ray.nodes()
                  if n.get("NodeManagerAddress") == target_ip and n.get("Alive", False)]
    candidates.sort(key=lambda n: (_res(n, "GPU"), _res(n, "CPU")), reverse=True)
    return next((n for n in candidates if _res(n, "GPU") >= num_gpus and _res(n, "CPU") >= num_cpus),
                candidates[0] if candidates else None)


def _cpu_capacity_problem(target_ip: Optional[str], num_gpus: float, num_cpus: float) -> Optional[str]:
    """Why this request can NEVER be placed (too many cores for any/that PC), else None."""
    if num_cpus <= 0:
        return None
    nodes = [n for n in ray.nodes() if n.get("Alive", False)]
    if target_ip:
        nodes = [n for n in nodes if n.get("NodeManagerAddress") == target_ip]
    nodes = [n for n in nodes if _res(n, "GPU") >= num_gpus]
    if not nodes:
        return None                                  # the GPU checks report this case
    most = max(_res(n, "CPU") for n in nodes)
    if most + 1e-9 < num_cpus:
        if target_ip:
            return f"{num_cpus:g} CPU cores requested, but PC {target_ip} offers only {most:g} to TensorSwarm."
        which = "no PC with a GPU" if num_gpus > 0 else "no PC"
        return f"{num_cpus:g} CPU cores requested, but {which} offers more than {most:g} to TensorSwarm."
    return None


def _soft_affinity(node_id: str):
    """Prefer this node, but run elsewhere if it is busy or gone (data locality, never a hard pin)."""
    try:
        return NodeAffinitySchedulingStrategy(node_id=node_id, soft=True, _spill_on_unavailable=True)
    except TypeError:                                   # older Ray without the private flag
        return NodeAffinitySchedulingStrategy(node_id=node_id, soft=True)


def _scheduling_kwargs(target_ip: Optional[str], num_gpus: float,
                       prefer_ips: Optional[List[str]] = None, num_cpus: float = DEFAULT_NUM_CPUS) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {"num_gpus": num_gpus, "num_cpus": num_cpus}
    problem = _cpu_capacity_problem(target_ip, num_gpus, num_cpus)
    if problem:
        raise RuntimeError(problem)
    # Never hard-code a Linux path such as "/app" here: on a Windows worker it is
    # meaningless and it *replaces* that worker's PYTHONPATH. Optional override, which
    # must be a path that exists on the node that runs the job:
    job_pythonpath = os.getenv("TENSORSWARM_JOB_PYTHONPATH", "").strip()
    if job_pythonpath:
        kwargs["runtime_env"] = {"env_vars": {"PYTHONPATH": job_pythonpath}}
    if target_ip:
        node = _pick_ray_node(target_ip, num_gpus, num_cpus)
        if node is None:
            raise RuntimeError(f"No live Ray node with IP {target_ip}. Is that worker connected?")
        if num_gpus > node.get("Resources", {}).get("GPU", 0.0):
            raise RuntimeError(f"Node {target_ip} offers {node.get('Resources', {}).get('GPU', 0.0):g} GPU(s) "
                               f"to Ray, but {num_gpus:g} were requested.")
        kwargs["scheduling_strategy"] = NodeAffinitySchedulingStrategy(node_id=node["NodeID"], soft=False)
    elif prefer_ips:
        for ip in prefer_ips:
            node = _pick_ray_node(ip, num_gpus, num_cpus)
            if node is not None and _res(node, "GPU") >= num_gpus and _res(node, "CPU") >= num_cpus:
                kwargs["scheduling_strategy"] = _soft_affinity(node["NodeID"])
                break
    return kwargs


def _resolve_dataset_ids(refs: List[str]) -> List[str]:
    """Dataset refs -> exact ids, failing fast (404) before anything is scheduled."""
    return [datasets_api.catalog.resolve(r)["id"] for r in refs]


async def _ips_holding(dataset_ids: List[str]) -> List[str]:
    if not dataset_ids:
        return []
    nodes = await registry.get_all_nodes()
    want = set(dataset_ids)
    return [n.tailscale_ip for n in nodes
            if n.status != "OFFLINE" and want <= {d.get("id") for d in n.datasets}]


# ==============================================================================
# Notebook kernel (runs inside a Ray actor on the chosen worker)
# ==============================================================================

def _usable_gpu_name(torch_mod) -> Optional[str]:
    """Name of the GPU this Ray task/actor may use, or None. A task that reserved 0 GPUs gets
    an empty CUDA_VISIBLE_DEVICES, yet torch.cuda.is_available() can still say True there, and
    get_device_name(0) then raises 'Invalid device id'."""
    try:
        if torch_mod.cuda.is_available() and torch_mod.cuda.device_count() > 0:
            return torch_mod.cuda.get_device_name(0)
    except Exception:
        pass
    return None


def _apply_cpu_threads(threads: Optional[float]) -> int:
    """Use the reserved cores: PyTorch (and BLAS via OMP) run this many threads."""
    # Ray hides the GPU from 0-GPU work with CUDA_VISIBLE_DEVICES="", but Windows cannot hold an
    # empty variable (it is deleted), so CUDA still sees the GPU while torch counts none:
    # torch.cuda.is_available() says True and every CUDA call fails with "Invalid device id".
    # "-1" means "no devices" to both, so CPU-only runtimes and jobs fall back to the CPU cleanly.
    if os.environ.get("CUDA_VISIBLE_DEVICES") == "":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    n = max(1, int(threads or 1))
    os.environ["OMP_NUM_THREADS"] = str(n)
    os.environ["MKL_NUM_THREADS"] = str(n)
    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        try:
            torch_mod.set_num_threads(n)
        except Exception:
            pass
    return n


def _kernel_rich_data(obj) -> Dict[str, Any]:
    """Jupyter-style MIME bundle for one object: text/plain always, plus PNG/HTML if possible."""
    import base64
    import io as _io

    data: Dict[str, Any] = {}
    try:
        text = repr(obj)
    except Exception as exc:  # pragma: no cover - broken __repr__
        text = f"<unrepresentable {type(obj).__name__}: {exc}>"
    data["text/plain"] = text if len(text) <= 20000 else text[:20000] + " ... (truncated)"
    try:
        module = type(obj).__module__ or ""
        if module.startswith("PIL.") and hasattr(obj, "save"):
            buf = _io.BytesIO()
            obj.save(buf, format="PNG")
            data["image/png"] = base64.b64encode(buf.getvalue()).decode("ascii")
        elif type(obj).__name__ == "Figure" and hasattr(obj, "savefig"):
            buf = _io.BytesIO()
            obj.savefig(buf, format="png", bbox_inches="tight", dpi=110)
            data["image/png"] = base64.b64encode(buf.getvalue()).decode("ascii")
        elif hasattr(obj, "_repr_png_"):
            png = obj._repr_png_()
            if isinstance(png, bytes):
                data["image/png"] = base64.b64encode(png).decode("ascii")
        if hasattr(obj, "_repr_html_") and not isinstance(obj, type):
            html = obj._repr_html_()
            if isinstance(html, str) and html:
                data["text/html"] = html
    except Exception:
        pass
    return data


def _kernel_transform_shell(code: str) -> str:
    """Colab-style shell lines: `!nvidia-smi`, `!pip install x` -> __ts_shell__("...")."""
    out = []
    for line in code.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("!") and not stripped.startswith("!="):
            indent = line[: len(line) - len(stripped)]
            out.append(f"{indent}__ts_shell__({stripped[1:].strip()!r})")
        else:
            out.append(line)
    return "\n".join(out) + ("\n" if code.endswith("\n") else "")


class _KernelStream:
    """File-like object that appends writes to the running execution's output list."""

    def __init__(self, kernel: "NotebookKernel", name: str):
        self._kernel = kernel
        self.name = name
        self.encoding = "utf-8"

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        if text:
            self._kernel._emit_stream(self.name, text)
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self) -> bool:
        return False

    def fileno(self):  # some libraries probe this; tell them there is no real fd
        raise OSError("TensorSwarm kernel stream has no file descriptor")


class NotebookKernel:
    """A persistent Python namespace on one worker, like a Colab/Jupyter kernel.

    All user code - and every CUDA call - runs on ONE dedicated cell thread for the
    runtime's whole life (like Jupyter's main thread). Ray runs actor methods on a thread
    pool, and touching CUDA from a different pool thread per cell can wedge the CUDA driver
    on Windows while holding the GIL, freezing the whole process. So:
      * execute() only queues the cell and returns immediately;
      * poll() / variables() / gpu_memory() / interrupt() never call into CUDA;
      * GPU memory figures are snapshots taken by the cell thread after each cell.
    """

    MAX_STREAM_CHARS = 2_000_000   # per cell, protects the browser from runaway prints
    KEEP_EXECUTIONS = 100

    def __init__(self, client_source: Optional[str] = None, master_api: Optional[str] = None,
                 cpu_threads: Optional[float] = None):
        import queue
        import threading as _threading

        self._cpu_threads = _apply_cpu_threads(cpu_threads)

        os.environ.setdefault("MPLBACKEND", "Agg")   # matplotlib renders to PNG, no GUI windows
        self._out_lock = _threading.Lock()
        self._execs: Dict[str, Dict[str, Any]] = {}
        self._order: List[str] = []
        self._count = 0
        self._current: Optional[Dict[str, Any]] = None
        self._queue: "queue.Queue" = queue.Queue()
        self._ns: Dict[str, Any] = {"__name__": "__main__"}
        self._ns["display"] = self._display
        self._ns["__ts_shell__"] = self._shell
        if client_source:
            # `ts` is pre-imported, like Colab's pre-imported helpers; `import tensorswarm` works too.
            try:
                self._ns["ts"] = _install_ts_client(client_source, master_api or "")
            except Exception as exc:  # noqa: BLE001 - a broken data client must not kill the runtime
                print(f"[tensorswarm] data client unavailable: {exc}", file=sys.stderr)
        self._info: Dict[str, Any] = {}
        self._info_ready = _threading.Event()
        self._gpu_mem: Dict[str, Any] = {}
        self._thread = _threading.Thread(target=self._cell_loop, name="tensorswarm-cell", daemon=True)
        self._thread.start()

    # ---- helpers available inside cells -------------------------------------------------
    def _display(self, *objs):
        for obj in objs:
            self._emit({"output_type": "display_data", "data": _kernel_rich_data(obj)})

    def _shell(self, command: str) -> None:
        import subprocess

        if command.startswith("pip ") or command == "pip":
            command = f'"{sys.executable}" -m {command}'
        proc = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, errors="replace", bufsize=1)
        assert proc.stdout is not None
        for line in proc.stdout:
            self._emit_stream("stdout", line)
        # Like Colab, a shell line shows only its output; the exit code is kept in `_exit_code`.
        self._ns["_exit_code"] = proc.wait()

    # ---- output plumbing ----------------------------------------------------------------
    def _emit(self, output: Dict[str, Any]):
        rec = self._current
        if rec is None:
            return
        with self._out_lock:
            rec["outputs"].append(output)

    def _emit_stream(self, name: str, text: str):
        rec = self._current
        if rec is None:
            return
        with self._out_lock:
            if rec["stream_chars"] >= self.MAX_STREAM_CHARS:
                return
            rec["stream_chars"] += len(text)
            if rec["stream_chars"] >= self.MAX_STREAM_CHARS:
                text += "\n... output truncated (more than 2 MB printed by this cell) ...\n"
            outs = rec["outputs"]
            if outs and outs[-1].get("output_type") == "stream" and outs[-1].get("name") == name:
                outs[-1]["text"] += text
            else:
                outs.append({"output_type": "stream", "name": name, "text": text})

    # ---- the cell thread ----------------------------------------------------------------
    def _collect_info(self):
        import platform
        import socket

        info: Dict[str, Any] = {
            "hostname": socket.gethostname(),
            "pid": os.getpid(),
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "torch_version": None,
            "cuda_available": False,
            "cuda_version": None,
            "gpu_name": None,
            "gpu_total_vram_mb": None,
            "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
            "node_ip": None,
            "cpu_count": os.cpu_count(),
            "cpu_threads": self._cpu_threads,
        }
        try:
            import ray as _ray
            info["node_ip"] = _ray.util.get_node_ip_address()
        except Exception:
            pass
        try:
            import torch
            info["torch_version"] = torch.__version__
            info["cuda_version"] = torch.version.cuda
            _apply_cpu_threads(self._cpu_threads)
            info["cpu_threads"] = torch.get_num_threads()
            if _usable_gpu_name(torch):
                props = torch.cuda.get_device_properties(0)
                torch.cuda.init()          # create the CUDA context on THIS thread, up front
                info.update(cuda_available=True, gpu_name=props.name,
                            gpu_total_vram_mb=round(props.total_memory / 1024 ** 2))
        except Exception as exc:
            info["torch_error"] = str(exc)
        self._info = info

    def _snapshot_gpu_memory(self):
        torch_mod = sys.modules.get("torch")
        try:
            if torch_mod is not None and torch_mod.cuda.is_available() and torch_mod.cuda.is_initialized():
                free, total = torch_mod.cuda.mem_get_info()
                self._gpu_mem = {
                    "allocated_mb": round(torch_mod.cuda.memory_allocated() / 1024 ** 2, 1),
                    "reserved_mb": round(torch_mod.cuda.memory_reserved() / 1024 ** 2, 1),
                    "device_free_mb": round(free / 1024 ** 2),
                    "device_total_mb": round(total / 1024 ** 2),
                    "measured_at": time.time(),
                }
        except Exception:
            pass

    def _cell_loop(self):
        try:
            self._collect_info()
        finally:
            self._info_ready.set()
        while True:
            rec, code = self._queue.get()
            if rec["status"] == "CANCELLED":
                continue
            try:
                self._run_cell(rec, code)
            except BaseException:   # noqa: BLE001 - never let the cell thread die
                rec["status"] = "ERROR"
                rec["finished"] = time.time()
                self._current = None

    def _run_cell(self, rec: Dict[str, Any], code: str):
        import ast
        import linecache
        import traceback

        self._count += 1
        rec.update(count=self._count, status="RUNNING", started=time.time())
        self._current = rec
        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _KernelStream(self, "stdout"), _KernelStream(self, "stderr")

        torch_mod = sys.modules.get("torch")
        track_vram = False
        try:
            if torch_mod is not None and torch_mod.cuda.is_available() and torch_mod.cuda.is_initialized():
                torch_mod.cuda.reset_peak_memory_stats()
                track_vram = True
        except Exception:
            pass

        filename = f"<cell [{self._count}]>"
        try:
            source = _kernel_transform_shell(code)
            ts_mod = self._ns.get("ts")
            if ts_mod is not None and hasattr(ts_mod, "ensure_packages"):
                ts_mod.ensure_packages(source)          # Colab-style: pip-install missing imports
            linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
            tree = ast.parse(source, filename, "exec")
            last_expr = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, filename, "exec"), self._ns)
            if last_expr is not None:
                value = eval(compile(ast.Expression(last_expr.value), filename, "eval"), self._ns)
                if value is not None:
                    self._ns["_"] = value
                    self._emit({"output_type": "execute_result", "execution_count": self._count,
                                "data": _kernel_rich_data(value)})
            self._flush_matplotlib()
            rec["status"] = "OK"
        except KeyboardInterrupt:
            self._emit({"output_type": "error", "ename": "KeyboardInterrupt", "evalue": "Execution interrupted",
                        "traceback": "KeyboardInterrupt: execution interrupted by user"})
            rec["status"] = "INTERRUPTED"
        except BaseException as exc:  # noqa: BLE001 - user code may raise anything, incl. SystemExit
            etype, evalue, tb = sys.exc_info()
            # Drop this method's own frame so the traceback starts in the user's cell.
            if tb is not None and tb.tb_next is not None:
                tb = tb.tb_next
            if isinstance(exc, SyntaxError):
                # Like Jupyter: just the offending line and a caret, no parser internals.
                text = "".join(traceback.format_exception_only(etype, evalue))
            else:
                text = "".join(traceback.format_exception(etype, evalue, tb))
            self._emit({"output_type": "error", "ename": etype.__name__ if etype else "Error",
                        "evalue": str(exc), "traceback": text})
            rec["status"] = "ERROR"
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            try:
                torch_mod = sys.modules.get("torch")
                if torch_mod is not None and torch_mod.cuda.is_available() and torch_mod.cuda.is_initialized():
                    if track_vram:
                        rec["vram_peak_mb"] = round(torch_mod.cuda.max_memory_allocated() / 1024 ** 2, 1)
                    rec["vram_allocated_mb"] = round(torch_mod.cuda.memory_allocated() / 1024 ** 2, 1)
            except Exception:
                pass
            self._snapshot_gpu_memory()
            rec["finished"] = time.time()
            self._current = None

    def _flush_matplotlib(self):
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        try:
            for num in plt.get_fignums():
                self._display(plt.figure(num))
            plt.close("all")
        except Exception:
            pass

    # ---- actor API (runs on Ray's pool threads; must never touch CUDA) -------------------
    def info(self) -> Dict[str, Any]:
        self._info_ready.wait(timeout=300)
        return dict(self._info)

    def execute(self, exec_id: str, code: str) -> str:
        rec = {"exec_id": exec_id, "status": "QUEUED", "outputs": [], "stream_chars": 0,
               "count": None, "submitted": time.time(), "started": None, "finished": None,
               "vram_peak_mb": None, "vram_allocated_mb": None}
        with self._out_lock:
            self._execs[exec_id] = rec
            self._order.append(exec_id)
            while len(self._order) > self.KEEP_EXECUTIONS:
                self._execs.pop(self._order.pop(0), None)
        self._queue.put((rec, code))
        return "QUEUED"

    def poll(self, exec_id: str, since: int = 0) -> Dict[str, Any]:
        with self._out_lock:
            rec = self._execs.get(exec_id)
            if rec is None:
                return {"exec_id": exec_id, "status": "UNKNOWN", "start": 0, "outputs": []}
            start = max(0, min(since, len(rec["outputs"])) - 1)   # the last item may still grow
            outputs = [dict(o) for o in rec["outputs"][start:]]
            return {
                "exec_id": exec_id, "status": rec["status"], "count": rec["count"],
                "start": start, "outputs": outputs, "total_outputs": len(rec["outputs"]),
                "started": rec["started"], "finished": rec["finished"],
                "duration_sec": round((rec["finished"] or time.time()) - rec["started"], 3) if rec["started"] else None,
                "vram_peak_mb": rec["vram_peak_mb"], "vram_allocated_mb": rec["vram_allocated_mb"],
            }

    def interrupt(self) -> bool:
        """Raise KeyboardInterrupt in the running cell (takes effect at the next Python bytecode;
        a long C call such as a single huge CUDA op finishes first). Also cancels queued cells."""
        import ctypes

        with self._out_lock:
            for rec in self._execs.values():
                if rec["status"] == "QUEUED":
                    rec["status"] = "CANCELLED"
        if self._current is None or self._thread.ident is None:
            return False
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(self._thread.ident), ctypes.py_object(KeyboardInterrupt))
        return True

    def variables(self) -> List[Dict[str, Any]]:
        """Colab-style variable inspector. Never calls repr() on arbitrary objects: a CUDA
        tensor's repr would run CUDA code on this (non-cell) thread."""
        import types

        simple = (int, float, bool, complex, str, bytes, type(None))
        rows = []
        for name, value in list(self._ns.items()):
            if name.startswith("_") or name in ("display", "In", "Out", "exit", "quit"):
                continue
            if isinstance(value, types.ModuleType):   # `import torch` is not a variable
                continue
            try:
                shape = getattr(value, "shape", None) if not isinstance(value, type) else None
                if shape is not None and hasattr(value, "dtype"):
                    summary = f"shape {tuple(shape)} | {value.dtype}"
                    device = getattr(value, "device", None)
                    if device is not None:
                        summary += f" on {device}"
                elif isinstance(value, simple):
                    summary = repr(value)
                elif isinstance(value, (list, tuple, dict, set, frozenset)):
                    summary = f"{len(value)} item{'s' if len(value) != 1 else ''}"
                elif isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
                    summary = "function"
                elif isinstance(value, type):
                    summary = "class"
                else:
                    summary = f"{type(value).__module__}.{type(value).__qualname__}"
            except Exception:
                summary = "<unavailable>"
            rows.append({"name": name, "type": type(value).__name__, "summary": summary[:200]})
        rows.sort(key=lambda r: r["name"].lower())
        return rows[:200]

    def gpu_memory(self) -> Dict[str, Any]:
        """PyTorch memory figures as of the end of the last cell (measured on the cell thread)."""
        return dict(self._gpu_mem)

    def terminate(self) -> bool:
        """Hard-exit this process so its GPU share is released even if a cell is wedged inside
        a CUDA call (ray.kill alone cannot stop a process whose threads hold the GIL)."""
        import threading as _threading

        def _die():
            time.sleep(0.2)   # let this method's reply go out first
            if sys.platform == "win32":
                import ctypes
                ctypes.windll.kernel32.TerminateProcess(ctypes.windll.kernel32.GetCurrentProcess(), 1)
            else:
                import signal
                os.kill(os.getpid(), signal.SIGKILL)

        _threading.Thread(target=_die, daemon=True).start()
        return True


class KernelManager:
    """Master-side registry of notebook runtimes (Ray actors)."""

    def __init__(self):
        self._records: Dict[str, KernelRecord] = {}
        self._actors: Dict[str, Any] = {}
        self._exec_refs: Dict[str, Any] = {}     # exec_id -> ObjectRef (keeps it alive)
        self._datasets: Dict[str, List[str]] = {}  # kernel_id -> dataset ids to schedule near
        self._lock = asyncio.Lock()

    async def list(self) -> List[KernelRecord]:
        async with self._lock:
            return sorted(self._records.values(), key=lambda k: k.created_at, reverse=True)

    async def get(self, kernel_id: str) -> KernelRecord:
        async with self._lock:
            rec = self._records.get(kernel_id)
        if rec is None:
            raise HTTPException(status_code=404, detail=f"Runtime '{kernel_id}' not found.")
        return rec

    async def active_count(self) -> int:
        async with self._lock:
            return sum(1 for k in self._records.values() if k.status in ("STARTING", "READY"))

    async def create(self, req: KernelCreateRequest) -> KernelRecord:
        if not HAS_RAY:
            raise HTTPException(status_code=503, detail="Ray is not installed on the Master.")
        # Fail fast (instead of waiting KERNEL_START_TIMEOUT) when no GPU share is free at all.
        if req.num_gpus > 0 and await asyncio.to_thread(ensure_ray_connected):
            try:
                free = (await asyncio.to_thread(ray.available_resources)).get("GPU", 0.0)
            except Exception:
                free = req.num_gpus
            if free + 1e-9 < req.num_gpus:
                async with self._lock:
                    holders = [f"'{k.name or k.kernel_id}' ({k.num_gpus:g} GPU)" for k in self._records.values()
                               if k.status in ("READY", "STARTING")]
                who = ("held by runtime " + ", ".join(holders)) if holders else "held by running jobs"
                raise HTTPException(status_code=409, detail=(
                    f"No free GPU share ({free:g} free, {req.num_gpus:g} requested): {who}. "
                    "Stop one (Runtime tab > Active runtimes), wait for jobs to finish, or connect with a smaller share."))
        num_cpus = _cpus(req.num_cpus)
        if num_cpus > 0 and await asyncio.to_thread(ensure_ray_connected):
            try:
                problem = await asyncio.to_thread(_cpu_capacity_problem, req.target_node_ip, req.num_gpus, num_cpus)
                free_cpu = (await asyncio.to_thread(ray.available_resources)).get("CPU", 0.0)
            except Exception:
                problem, free_cpu = None, num_cpus
            if problem:
                raise HTTPException(status_code=409, detail=problem + " Pick fewer cores or another PC.")
            if free_cpu + 1e-9 < num_cpus:
                raise HTTPException(status_code=409, detail=(
                    f"Only {free_cpu:g} CPU cores are free in the swarm ({num_cpus:g} requested). "
                    "Stop a runtime or wait for jobs to finish, or pick fewer cores."))
        now = datetime.now(timezone.utc)
        rec = KernelRecord(kernel_id=f"rt_{uuid.uuid4().hex[:8]}", name=req.name, status="STARTING",
                           target_node_ip=req.target_node_ip, num_gpus=req.num_gpus, num_cpus=num_cpus,
                           created_at=now, last_activity=now)
        self._datasets[rec.kernel_id] = _resolve_dataset_ids(req.datasets)
        async with self._lock:
            self._records[rec.kernel_id] = rec
        asyncio.create_task(self._start(rec.kernel_id))
        return rec

    async def _start(self, kernel_id: str):
        rec = self._records[kernel_id]
        actor = None
        try:
            if not await asyncio.to_thread(ensure_ray_connected):
                raise RuntimeError("Ray cluster is not connected on the Master.")

            prefer = await _ips_holding(self._datasets.pop(kernel_id, []))

            def _spawn():
                opts = _scheduling_kwargs(rec.target_node_ip, rec.num_gpus, prefer, _cpus(rec.num_cpus))
                return ray.remote(max_concurrency=8, **opts)(NotebookKernel).remote(
                    TS_CLIENT_SOURCE, master_api_url(), _cpus(rec.num_cpus))

            actor = await asyncio.to_thread(_spawn)
            self._actors[kernel_id] = actor
            try:
                info = await asyncio.to_thread(ray.get, actor.info.remote(), timeout=KERNEL_START_TIMEOUT)
            except Exception as exc:
                if type(exc).__name__ == "GetTimeoutError":
                    what = "GPU share" if rec.num_gpus > 0 else f"{_cpus(rec.num_cpus):g} free CPU cores"
                    raise RuntimeError(
                        f"No {what} after {KERNEL_START_TIMEOUT:.0f} s. Other runtimes or jobs are using "
                        f"{rec.target_node_ip or 'every PC'}: stop one, or connect with a smaller share / fewer cores."
                    ) from exc
                raise
            async with self._lock:
                rec.info = info
                rec.status = "READY"
                rec.target_node_ip = rec.target_node_ip or info.get("node_ip")
                rec.last_activity = datetime.now(timezone.utc)
            await registry.set_kernel_count(rec.target_node_ip, +1)
            logger.info("Runtime %s ready on %s (%s)", kernel_id, info.get("hostname"), info.get("gpu_name"))
        except Exception as exc:
            logger.warning("Runtime %s failed to start: %s", kernel_id, exc)
            if actor is not None:
                try:
                    ray.kill(actor)
                except Exception:
                    pass
            self._actors.pop(kernel_id, None)
            async with self._lock:
                rec.status = "ERROR"
                rec.error = str(exc)

    def _actor(self, kernel_id: str):
        actor = self._actors.get(kernel_id)
        rec = self._records.get(kernel_id)
        if actor is None or rec is None or rec.status != "READY":
            state = rec.status if rec else "missing"
            raise HTTPException(status_code=409, detail=f"Runtime is not ready (status: {state}).")
        return actor

    async def _mark_dead(self, kernel_id: str, reason: str):
        async with self._lock:
            rec = self._records.get(kernel_id)
            was_ready = rec is not None and rec.status == "READY"
            if rec is not None:
                rec.status = "DEAD"
                rec.error = reason
        self._actors.pop(kernel_id, None)
        if was_ready:
            await registry.set_kernel_count(rec.target_node_ip, -1)

    async def _call(self, kernel_id: str, method: str, *args, timeout: float = 20.0):
        actor = self._actor(kernel_id)
        try:
            return await asyncio.to_thread(ray.get, getattr(actor, method).remote(*args), timeout=timeout)
        except Exception as exc:
            name = type(exc).__name__
            if name in ("RayActorError", "ActorDiedError", "ActorUnavailableError"):
                await self._mark_dead(kernel_id, "The runtime process died (out of memory, crashed, or its worker left).")
                raise HTTPException(status_code=410, detail="The runtime died. Restart it to continue.") from exc
            raise HTTPException(status_code=502, detail=f"Runtime call failed: {exc}") from exc

    async def touch(self, kernel_id: str):
        async with self._lock:
            rec = self._records.get(kernel_id)
            if rec:
                rec.last_activity = datetime.now(timezone.utc)

    async def execute(self, kernel_id: str, code: str) -> Dict[str, Any]:
        actor = self._actor(kernel_id)
        exec_id = f"ex_{uuid.uuid4().hex[:10]}"
        ref = await asyncio.to_thread(lambda: actor.execute.remote(exec_id, code))
        self._exec_refs[exec_id] = ref
        if len(self._exec_refs) > 500:   # forget the oldest references
            for key in list(self._exec_refs)[:100]:
                self._exec_refs.pop(key, None)
        async with self._lock:
            rec = self._records[kernel_id]
            rec.execution_count += 1
            rec.last_activity = datetime.now(timezone.utc)
        return {"exec_id": exec_id, "kernel_id": kernel_id}

    async def stop(self, kernel_id: str) -> KernelRecord:
        rec = await self.get(kernel_id)
        actor = self._actors.pop(kernel_id, None)
        if actor is not None:
            # 1) Ask the runtime to hard-exit itself (frees its GPU share even if a cell is stuck),
            # 2) then ray.kill as the fallback.
            try:
                await asyncio.to_thread(ray.get, actor.terminate.remote(), timeout=3)
            except Exception:
                pass
            try:
                await asyncio.to_thread(ray.kill, actor)
            except Exception as exc:
                logger.warning("ray.kill(%s) failed: %s", kernel_id, exc)
        was_ready = rec.status == "READY"
        async with self._lock:
            rec.status = "DEAD"
            rec.error = rec.error or "Stopped by user."
        if was_ready:
            await registry.set_kernel_count(rec.target_node_ip, -1)
        return rec

    async def reap_idle(self):
        if KERNEL_IDLE_MINUTES <= 0:
            return
        limit = datetime.now(timezone.utc) - timedelta(minutes=KERNEL_IDLE_MINUTES)
        async with self._lock:
            idle = [k.kernel_id for k in self._records.values() if k.status == "READY" and k.last_activity < limit]
        for kernel_id in idle:
            logger.info("Stopping idle runtime %s (no activity for %.0f min)", kernel_id, KERNEL_IDLE_MINUTES)
            rec = await self.stop(kernel_id)
            rec.error = f"Stopped after {KERNEL_IDLE_MINUTES:.0f} min without activity (frees the GPU)."


kernels = KernelManager()


# ==============================================================================
# Sample scripts (master/samples/*.py)
# ==============================================================================

def load_samples() -> List[Dict[str, Any]]:
    """Each sample starts with '# key: value' header lines (title, description, category,
    runtime, gpu). Cells are separated with '# %%' markers (Jupytext / VS Code format), so a
    sample runs as one batch job or opens as a multi-cell notebook."""
    samples = []
    if not SAMPLES_DIR.is_dir():
        return samples
    for path in sorted(SAMPLES_DIR.glob("*.py")):
        try:
            code = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta = {"id": path.stem, "title": path.stem.replace("_", " ").title(), "description": "",
                "category": "General", "runtime": "", "gpu": "required",
                "mode": "any"}   # mode "notebook": uses !shell lines, so it cannot run as a batch job
        for line in code.splitlines():
            if not line.startswith("#"):
                break
            key, sep, value = line[1:].strip().partition(":")
            if sep and key.strip().lower() in meta:
                meta[key.strip().lower()] = value.strip()
        meta["code"] = code
        samples.append(meta)
    order = {"Notebook": 0, "Diagnostics": 1, "Benchmarks": 2, "Stress": 3, "Training": 4}
    samples.sort(key=lambda s: (order.get(s["category"], 9), s["id"]))
    return samples


# ==============================================================================
# Application Lifespan
# ==============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("TensorSwarm Master Backend Initialized.")

    async def connect_ray():
        try:
            if not await asyncio.to_thread(ensure_ray_connected):
                logger.warning(
                    "Ray is not connected; telemetry and health endpoints remain available, "
                    "but job execution will be unavailable."
                )
        except Exception:
            logger.exception("Unexpected error while connecting to Ray.")

    # Periodic background task: expire stale nodes, stop idle notebook runtimes.
    async def housekeeping():
        tick = 0
        while True:
            try:
                await asyncio.sleep(5)
                await registry.mark_stale_nodes()
                tick += 1
                if tick % 12 == 0:
                    await kernels.reap_idle()
                    await asyncio.to_thread(datasets_api.ops.cleanup)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in housekeeping: %s", e)

    try:
        n = await asyncio.to_thread(datasets_api.catalog.scan)
        logger.info("Datasets: %d in %s (workers reach them via %s)", n, tsc.store_dir(), master_api_url())
    except Exception:
        logger.exception("Could not scan the dataset store")
    checker_task = asyncio.create_task(housekeeping())
    ray_connection_task = asyncio.create_task(connect_ray())
    yield
    checker_task.cancel()
    ray_connection_task.cancel()
    logger.info("TensorSwarm Master Backend Shutting Down.")


app = FastAPI(
    title="TensorSwarm Cluster API",
    version="2.1.0",
    description="Distributed Peer-to-Peer GPU Cluster Telemetry & Execution Engine",
    lifespan=lifespan,
)

# CORS configuration for React/Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(datasets_api.router)


# ==============================================================================
# API Endpoints
# ==============================================================================

@app.get("/healthz", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ray_connected": ray.is_initialized() if HAS_RAY else False,
    }


@app.post("/api/v1/telemetry/heartbeat", tags=["Telemetry"])
async def receive_heartbeat(payload: HeartbeatPayload):
    """Worker agents report GPU status (GTX 1650, RTX 3050, etc.) every 5 seconds."""
    record = await registry.upsert_heartbeat(payload)
    return {
        "status": "acknowledged",
        "node_id": record.node_id,
        "recorded_status": record.status,
    }


@app.get("/api/v1/nodes", response_model=List[NodeRecord], tags=["Cluster Fleet"])
async def get_nodes():
    """Returns all registered nodes with their live GPU utilization and status."""
    return await registry.get_all_nodes()


@app.get("/api/v1/nodes/{node_id}/history", tags=["Cluster Fleet"])
async def get_node_history(node_id: str, minutes: float = Query(10.0, gt=0, le=60)):
    """Time series of one node's GPU/CPU telemetry (5 s resolution, up to 30 min kept)."""
    history = await registry.get_history(node_id, minutes)
    if history is None:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found.")
    return {"node_id": node_id, "interval_sec": 5, "samples": history}


@app.get("/api/v1/cluster/summary", response_model=ClusterSummary, tags=["Cluster Fleet"])
async def get_summary():
    """Aggregated cluster metrics for the dashboard header."""
    return await registry.get_cluster_summary(active_kernels=await kernels.active_count())


@app.get("/api/v1/ray/status", tags=["Cluster Fleet"])
async def ray_status():
    """Ray's own view: nodes and logical GPU/CPU resources (what the scheduler can still hand out)."""
    if not HAS_RAY or not ray.is_initialized():
        return {"connected": False, "nodes": [], "cluster_resources": {}, "available_resources": {}}

    def _collect():
        nodes = []
        for n in ray.nodes():
            res = n.get("Resources", {})
            nodes.append({
                "node_id": n.get("NodeID"),
                "ip": n.get("NodeManagerAddress"),
                "alive": n.get("Alive", False),
                "is_head": any(k.startswith("node:__internal_head__") for k in res),
                "gpus": res.get("GPU", 0.0),
                "cpus": res.get("CPU", 0.0),
                "memory_gb": round(res.get("memory", 0.0) / 1024 ** 3, 1),
            })
        return {"connected": True, "nodes": nodes,
                "cluster_resources": {k: v for k, v in ray.cluster_resources().items() if not k.startswith("node:")},
                "available_resources": {k: v for k, v in ray.available_resources().items() if not k.startswith("node:")}}

    try:
        return await asyncio.to_thread(_collect)
    except Exception as exc:
        return {"connected": False, "error": str(exc), "nodes": [], "cluster_resources": {}, "available_resources": {}}


@app.get("/api/v1/samples", tags=["Samples"])
async def list_samples():
    """Ready-made test scripts for worker nodes (diagnostics, benchmarks, stress, training)."""
    return await asyncio.to_thread(load_samples)


# ==============================================================================
# Deliverable 5: Target-Specific Ray Job Dispatch
# ==============================================================================

def execute_script_on_node(script_code: str, client_source: Optional[str] = None,
                           master_api: Optional[str] = None, datasets: Optional[List[str]] = None,
                           cpu_threads: Optional[float] = None):
    """Standard execution wrapper invoked inside a Ray remote worker process.
    `datasets` (exact ids) are synced to this worker before the script runs; the script gets
    `ts` (the tensorswarm data client) pre-imported."""
    import sys
    import io
    import socket
    import traceback

    threads = _apply_cpu_threads(cpu_threads)
    try:
        import torch
        _apply_cpu_threads(threads)
        gpu_name = _usable_gpu_name(torch) or f"CPU only ({threads} core{'s' if threads != 1 else ''})"
    except ImportError:
        torch = None
        gpu_name = "PyTorch not installed"

    node_hostname = socket.gethostname()
    try:
        import ray as _ray
        node_ip = _ray.util.get_node_ip_address()
    except Exception:
        node_ip = None
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = stdout_capture
    sys.stderr = stderr_capture

    result_val = None
    error_msg = None
    vram_peak = None
    try:
        if torch is not None and torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass

    try:
        # One namespace for globals and locals, exactly like running a .py file: top-level
        # helper functions can call each other, and a normal `if __name__ == "__main__":`
        # training script runs its main block.
        exec_namespace = {"__name__": "__main__"}
        if client_source:
            ts_mod = _install_ts_client(client_source, master_api or "")
            exec_namespace["ts"] = ts_mod
            ts_mod.ensure_packages(script_code)         # Colab-style: pip-install missing imports
            for ds in datasets or []:
                path = ts_mod.dataset(ds)
                print(f"[tensorswarm] dataset {ds} ready at {path}", flush=True)
        exec(compile(script_code, "<tensorswarm-job>", "exec"), exec_namespace)
        result_val = exec_namespace.get("result", "Execution completed without explicit 'result' variable.")
    except Exception:
        error_msg = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        try:
            if torch is not None and torch.cuda.is_available() and torch.cuda.is_initialized():
                vram_peak = round(torch.cuda.max_memory_allocated() / 1024 ** 2, 1)
        except Exception:
            pass

    return {
        "node_hostname": node_hostname,
        "node_ip": node_ip,
        "gpu_name": gpu_name,
        "stdout": stdout_capture.getvalue(),
        "stderr": stderr_capture.getvalue(),
        "result": result_val,
        "error": error_msg,
        "vram_peak_mb": vram_peak,
    }


async def run_ray_job_task(job_id: str, script_code: str, target_node_ip: Optional[str], num_gpus: float,
                           dataset_ids: Optional[List[str]] = None, num_cpus: Optional[float] = None):
    """Background async worker that dispatches the task to Ray targeting a specific node."""
    start_time = time.time()
    await registry.update_job(job_id, {"status": "RUNNING", "started_at": datetime.now(timezone.utc)})

    if not await asyncio.to_thread(ensure_ray_connected):
        await registry.update_job(job_id, {
            "status": "FAILED",
            "error": "Ray cluster is not connected on Master. Ensure Ray head is running.",
            "completed_at": datetime.now(timezone.utc),
        })
        return

    try:
        prefer = [] if target_node_ip else await _ips_holding(dataset_ids or [])
        task_kwargs = await asyncio.to_thread(_scheduling_kwargs, target_node_ip, num_gpus, prefer, _cpus(num_cpus))
        if target_node_ip:
            logger.info("Pinning job %s to %s (%g GPU)", job_id, target_node_ip, num_gpus)
        elif prefer:
            logger.info("Job %s prefers %s (already holds %s)", job_id, ", ".join(prefer), ", ".join(dataset_ids or []))

        # Define remote task dynamically with GPU requirement & node affinity
        remote_task = ray.remote(**task_kwargs)(execute_script_on_node)

        # Dispatch and await result asynchronously
        ray_future = remote_task.remote(script_code, TS_CLIENT_SOURCE, master_api_url(), dataset_ids or [],
                                        _cpus(num_cpus))
        output = await asyncio.to_thread(ray.get, ray_future)
        duration = round(time.time() - start_time, 2)

        common = {
            "completed_at": datetime.now(timezone.utc),
            "execution_time_sec": duration,
            "executed_on_node": output.get("node_hostname"),
            "executed_on_ip": output.get("node_ip"),
            "gpu_used": output.get("gpu_name"),
            "vram_peak_mb": output.get("vram_peak_mb"),
            "stdout": output.get("stdout"),
            "stderr": output.get("stderr"),
        }
        if output.get("error"):
            await registry.update_job(job_id, {"status": "FAILED", "error": output.get("error"), **common})
        else:
            await registry.update_job(job_id, {"status": "COMPLETED", "result": str(output.get("result")), **common})

    except Exception as e:
        duration = round(time.time() - start_time, 2)
        logger.error("Job %s execution failed: %s", job_id, e)
        await registry.update_job(job_id, {
            "status": "FAILED",
            "completed_at": datetime.now(timezone.utc),
            "execution_time_sec": duration,
            "error": str(e),
        })


@app.post("/api/v1/jobs/submit", response_model=JobResult, status_code=status.HTTP_202_ACCEPTED, tags=["Job Dispatch"])
async def submit_job(req: JobSubmitRequest, background_tasks: BackgroundTasks):
    """
    Submit a custom Python script for execution on the cluster.
    If target_node_ip is provided, Ray pins the job strictly to that machine's GPU.
    """
    dataset_ids = _resolve_dataset_ids(req.datasets)   # unknown dataset -> 404 now, not mid-run
    job_id = f"job_{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)

    job_record = JobResult(
        job_id=job_id,
        job_name=req.job_name or "custom_script",
        status="PENDING",
        submitted_at=now,
        target_node_ip=req.target_node_ip,
        num_gpus=req.num_gpus,
        num_cpus=_cpus(req.num_cpus),
    )
    await registry.record_job(job_record)

    # Dispatch to Ray in the background
    background_tasks.add_task(
        run_ray_job_task,
        job_id=job_id,
        script_code=req.script_code,
        target_node_ip=req.target_node_ip,
        num_gpus=req.num_gpus,
        dataset_ids=dataset_ids,
        num_cpus=req.num_cpus,
    )

    return job_record


@app.get("/api/v1/jobs/{job_id}", response_model=JobResult, tags=["Job Dispatch"])
async def get_job_status(job_id: str):
    """Retrieve output, logs, and status for a submitted job."""
    job = await registry.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return job


@app.get("/api/v1/jobs", response_model=List[JobResult], tags=["Job Dispatch"])
async def list_recent_jobs(limit: int = Query(20, le=100)):
    """List recent submitted jobs across the cluster."""
    return await registry.list_jobs(limit=limit)


# ==============================================================================
# Notebook runtimes (Colab-style)
# ==============================================================================

@app.get("/api/v1/kernels", response_model=List[KernelRecord], tags=["Notebook"])
async def list_kernels():
    return await kernels.list()


@app.post("/api/v1/kernels", response_model=KernelRecord, status_code=status.HTTP_202_ACCEPTED, tags=["Notebook"])
async def create_kernel(req: KernelCreateRequest):
    """Start a persistent Python runtime on a GPU node. Poll GET /kernels/{id} until READY."""
    return await kernels.create(req)


@app.get("/api/v1/kernels/{kernel_id}", response_model=KernelRecord, tags=["Notebook"])
async def get_kernel(kernel_id: str):
    return await kernels.get(kernel_id)


@app.delete("/api/v1/kernels/{kernel_id}", response_model=KernelRecord, tags=["Notebook"])
async def delete_kernel(kernel_id: str):
    """Stop the runtime and free its GPU share (all variables are lost)."""
    return await kernels.stop(kernel_id)


@app.post("/api/v1/kernels/{kernel_id}/execute", tags=["Notebook"])
async def execute_cell(kernel_id: str, req: ExecuteRequest):
    """Queue one cell. Returns an exec_id; poll /executions/{exec_id} for streamed output."""
    return await kernels.execute(kernel_id, req.code)


@app.get("/api/v1/kernels/{kernel_id}/executions/{exec_id}", tags=["Notebook"])
async def poll_execution(kernel_id: str, exec_id: str, since: int = Query(0, ge=0)):
    """Outputs from index `start` on (the client splices them in; the last one may have grown)."""
    await kernels.touch(kernel_id)
    return await kernels._call(kernel_id, "poll", exec_id, since)


@app.post("/api/v1/kernels/{kernel_id}/interrupt", tags=["Notebook"])
async def interrupt_kernel(kernel_id: str):
    return {"interrupted": await kernels._call(kernel_id, "interrupt")}


@app.get("/api/v1/kernels/{kernel_id}/variables", tags=["Notebook"])
async def kernel_variables(kernel_id: str):
    return await kernels._call(kernel_id, "variables")


@app.get("/api/v1/kernels/{kernel_id}/gpu", tags=["Notebook"])
async def kernel_gpu_memory(kernel_id: str):
    """PyTorch's view of this runtime's GPU memory (allocated / reserved / device free)."""
    return await kernels._call(kernel_id, "gpu_memory")


# ==============================================================================
# Datasets: cluster-wide operations (the store/upload/serve API is in datasets_api.py)
# ==============================================================================

def _dataset_presence(dataset_id: str) -> List[Dict[str, str]]:
    """Which online PCs already hold a dataset, from the agents' heartbeats (no Ray round-trip)."""
    out, seen = [], set()
    for n in list(registry._nodes.values()):
        if n.status == "OFFLINE" or n.tailscale_ip in seen:
            continue
        for d in n.datasets:
            if d.get("id") == dataset_id:
                seen.add(n.tailscale_ip)
                out.append({"ip": n.tailscale_ip, "hostname": n.hostname, "location": d.get("location", "cache")})
                break
    return out


datasets_api.hooks["node_presence"] = _dataset_presence
datasets_api.RESERVED_NAMES.add("tasks")


def _dataset_node_task(action: str, client_source: str, master_api: str, ref: str):
    """Runs ON a worker PC (0 CPU / 0 GPU, so it also runs while that GPU is busy training)."""
    import socket

    ts_mod = _install_ts_client(client_source, master_api)
    t0 = time.time()
    if action == "sync":
        path = ts_mod.dataset(ref, verbose=False)
        detail = str(path)
    else:
        detail = f"freed {ts_mod._human(ts_mod.evict(ref))}"
    return {"hostname": socket.gethostname(), "detail": detail, "seconds": round(time.time() - t0, 1)}


class DatasetNodesRequest(BaseModel):
    target_node_ips: Optional[List[str]] = Field(None, description="Only these PCs (Tailscale IPs). Omit for every online PC.")


_dataset_tasks: Dict[str, Dict[str, Any]] = {}


async def _start_dataset_task(action: str, ref: str, req: DatasetNodesRequest) -> Dict[str, Any]:
    m = datasets_api.catalog.resolve(ref)
    if not HAS_RAY or not await asyncio.to_thread(ensure_ray_connected):
        raise HTTPException(status_code=503, detail="Ray is not connected on the Master.")
    alive = [n for n in await asyncio.to_thread(ray.nodes) if n.get("Alive")]
    ips = sorted({n["NodeManagerAddress"] for n in alive})
    if req.target_node_ips:
        missing = set(req.target_node_ips) - set(ips)
        if missing:
            raise HTTPException(status_code=404, detail=f"Not connected to Ray: {', '.join(sorted(missing))}")
        ips = [ip for ip in ips if ip in req.target_node_ips]
    task_id = f"dt_{uuid.uuid4().hex[:10]}"
    rec = {"task_id": task_id, "action": action, "dataset_id": m["id"], "created_at": datetime.now(timezone.utc).isoformat(),
           "nodes": {ip: {"status": "RUNNING", "detail": None, "seconds": None, "hostname": None} for ip in ips}}
    _dataset_tasks[task_id] = rec
    if len(_dataset_tasks) > 100:
        for k in list(_dataset_tasks)[:20]:
            _dataset_tasks.pop(k, None)

    async def one(ip: str):
        node = _pick_ray_node(ip, 0)       # one task per PC: every Ray node on a PC shares its disk
        state = rec["nodes"][ip]
        try:
            fn = ray.remote(num_cpus=0, num_gpus=0, max_retries=2,
                            scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node["NodeID"], soft=False))(_dataset_node_task)
            ref_ = await asyncio.to_thread(lambda: fn.remote(action, TS_CLIENT_SOURCE, master_api_url(), m["id"]))
            out = await asyncio.to_thread(ray.get, ref_)
            state.update(status="COMPLETED", **out)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).strip().splitlines()
            state.update(status="FAILED", detail=(msg[-1] if msg else type(exc).__name__)[:500])

    for ip in ips:
        asyncio.create_task(one(ip))
    return rec


@app.post("/api/v1/datasets/{ref}/prefetch", status_code=202, tags=["Datasets"])
async def prefetch_dataset(ref: str, req: DatasetNodesRequest = DatasetNodesRequest()):
    """Copy a dataset to every worker (or the listed ones) NOW, so jobs start without waiting.
    Runs in parallel per PC; each PC resumes where it stopped if interrupted."""
    return await _start_dataset_task("sync", ref, req)


@app.post("/api/v1/datasets/{ref}/evict", status_code=202, tags=["Datasets"])
async def evict_dataset(ref: str, req: DatasetNodesRequest = DatasetNodesRequest()):
    """Delete cached copies on the workers (never the Master's store or USB-seeded copies)."""
    return await _start_dataset_task("evict", ref, req)


@app.get("/api/v1/datasets/tasks/{task_id}", tags=["Datasets"])
async def dataset_task_status(task_id: str):
    rec = _dataset_tasks.get(task_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Unknown dataset task.")
    return rec


# ==============================================================================
# Dashboard (static Next.js export) served on the API port
# ==============================================================================
# Built with `npm run build:static` in frontend/, which writes master/dashboard. Serving it here
# means every PC on the tailnet opens http://<MASTER_IP>:8000 in a browser: no Node.js needed
# anywhere, and the page calls /api/v1/* on this same origin. Mounted LAST so every API route
# above wins over the static files.

@app.get("/api/healthz", tags=["Health"], include_in_schema=False)
async def health_check_alias():
    return await health_check()


DASHBOARD_DIR = Path(os.getenv("TENSORSWARM_DASHBOARD_DIR", str(Path(__file__).resolve().parent / "dashboard")))

if (DASHBOARD_DIR / "index.html").is_file():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")
    logger.info("Dashboard: serving %s at /", DASHBOARD_DIR)
else:
    @app.get("/", include_in_schema=False)
    async def dashboard_missing():
        return {
            "detail": "TensorSwarm API is running, but the dashboard is not built.",
            "fix": "On a PC with Node.js: cd frontend && npm install && npm run build:static, "
                   "then refresh the USB (prepare_usb.cmd -CodeOnly) and reinstall.",
            "api_docs": "/docs",
        }


if __name__ == "__main__":
    # `python server.py` from any working directory, on Linux or Windows. Passing the app
    # object (not "server:app") avoids depending on the CWD being on sys.path.
    import uvicorn
    uvicorn.run(app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8000")), reload=False)
