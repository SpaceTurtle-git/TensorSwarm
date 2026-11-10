// Types matching the FastAPI Pydantic models in master/server.py.
// Extended telemetry fields are optional: Linux/Docker agents older than 2.1 omit them.

export interface GPUProcess {
  pid: number;
  name: string;
  type: string;
  used_vram_mb?: number | null;
}

export interface GPUStats {
  index: number;
  name: string;
  uuid: string;
  total_vram_mb: number;
  free_vram_mb: number;
  used_vram_mb: number;
  gpu_utilization_pct: number;
  memory_utilization_pct: number;
  temperature_c?: number | null;
  power_watts?: number | null;
  power_limit_watts?: number | null;
  fan_speed_pct?: number | null;
  clock_graphics_mhz?: number | null;
  clock_sm_mhz?: number | null;
  clock_memory_mhz?: number | null;
  clock_graphics_max_mhz?: number | null;
  clock_sm_max_mhz?: number | null;
  clock_memory_max_mhz?: number | null;
  pcie_gen?: number | null;
  pcie_gen_max?: number | null;
  pcie_width?: number | null;
  pcie_width_max?: number | null;
  performance_state?: string | null;
  compute_capability?: string | null;
  architecture?: string | null;
  encoder_utilization_pct?: number | null;
  decoder_utilization_pct?: number | null;
  memory_bus_width_bits?: number | null;
  cuda_cores?: number | null;
  throttle_reasons?: string[];
  processes?: GPUProcess[];
}

export interface HostStats {
  cpu_utilization_pct: number;
  ram_total_mb: number;
  ram_used_mb: number;
  ram_free_mb: number;
  cpu_freq_mhz?: number | null;
  swap_used_pct?: number | null;
}

export interface SystemInfo {
  os?: string | null;
  cpu_model?: string | null;
  cpu_cores_physical?: number | null;
  cpu_cores_logical?: number | null;
  python_version?: string | null;
  agent_version?: string | null;
  boot_time?: string | null;
  driver_version?: string | null;
  cuda_driver_version?: string | null;
  nvml_version?: string | null;
}

export type NodeStatus = "AVAILABLE" | "COMPUTING" | "OFFLINE";

export interface NodeRecord {
  node_id: string;
  hostname: string;
  tailscale_ip: string;
  status: NodeStatus;
  last_heartbeat: string;
  gpu_count: number;
  gpus: GPUStats[];
  host: HostStats;
  system?: SystemInfo | null;
  /** Datasets this PC holds locally (agent >= 2.2). */
  datasets?: { id: string; location: "cache" | "store" }[];
  active_jobs: number;
  active_kernels?: number;
}

export interface ClusterSummary {
  total_nodes: number;
  active_nodes: number;
  offline_nodes: number;
  total_gpus: number;
  available_gpus: number;
  total_vram_gb: number;
  used_vram_gb: number;
  avg_gpu_utilization_pct: number;
  total_power_watts?: number;
  max_temperature_c?: number | null;
  running_jobs?: number;
  active_kernels?: number;
}

export interface RayNode {
  node_id: string;
  ip: string;
  alive: boolean;
  is_head: boolean;
  gpus: number;
  cpus: number;
  memory_gb: number;
}

export interface RayStatus {
  connected: boolean;
  error?: string;
  nodes: RayNode[];
  cluster_resources: Record<string, number>;
  available_resources: Record<string, number>;
}

export interface HistorySample {
  t: number;
  cpu: number;
  ram_used_mb: number;
  gpus: {
    index: number;
    util: number;
    mem_util: number;
    vram_used_mb: number;
    vram_total_mb: number;
    temp?: number | null;
    power?: number | null;
    clock_sm?: number | null;
  }[];
}

export interface JobResult {
  job_id: string;
  job_name: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | string;
  submitted_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  execution_time_sec?: number | null;
  target_node_ip?: string | null;
  num_gpus?: number;
  num_cpus?: number | null;
  executed_on_node?: string | null;
  executed_on_ip?: string | null;
  gpu_used?: string | null;
  vram_peak_mb?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  result?: string | null;
  error?: string | null;
}

export interface Sample {
  id: string;
  title: string;
  description: string;
  category: string;
  runtime: string;
  gpu: string;
  mode: string;
  code: string;
}

export interface KernelInfo {
  hostname?: string;
  pid?: number;
  python_version?: string;
  platform?: string;
  torch_version?: string | null;
  cuda_available?: boolean;
  cuda_version?: string | null;
  gpu_name?: string | null;
  gpu_total_vram_mb?: number | null;
  node_ip?: string | null;
  cpu_count?: number | null;
  cpu_threads?: number | null;
}

export interface KernelRecord {
  kernel_id: string;
  name?: string | null;
  status: "STARTING" | "READY" | "DEAD" | "ERROR";
  target_node_ip?: string | null;
  num_gpus: number;
  num_cpus?: number | null;
  created_at: string;
  last_activity: string;
  info?: KernelInfo | null;
  error?: string | null;
  execution_count: number;
}

// Jupyter-style output records produced by the notebook kernel.
export type CellOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "display_data"; data: Record<string, string> }
  | { output_type: "execute_result"; execution_count?: number; data: Record<string, string> }
  | { output_type: "error"; ename: string; evalue: string; traceback: string };

export interface ExecutionPoll {
  exec_id: string;
  status: "QUEUED" | "RUNNING" | "OK" | "ERROR" | "INTERRUPTED" | "CANCELLED" | "UNKNOWN";
  count?: number | null;
  start: number;
  outputs: CellOutput[];
  total_outputs?: number;
  duration_sec?: number | null;
  vram_peak_mb?: number | null;
  vram_allocated_mb?: number | null;
}

export interface KernelVariable {
  name: string;
  type: string;
  summary: string;
}

// ---- Datasets ------------------------------------------------------------------------------

export interface DatasetFileEntry { path: string; size: number }

export interface Dataset {
  id: string;                 // name@version
  name: string;
  version: string;
  description: string;
  created_at: string;
  source: { type: "upload" | "url" | "local"; url?: string; path?: string };
  archive: boolean;           // single .zip/.tar(.gz), extracted on each worker
  extracted_bytes?: number | null;
  file_count: number;
  total_bytes: number;
  latest: boolean;
  preview: DatasetFileEntry[];
  nodes: { ip: string; hostname: string; location: "cache" | "store" }[];
}

export interface DatasetOp {
  op_id: string;
  kind: "upload" | "import";
  status: "uploading" | "downloading" | "finalizing" | "done" | "error" | "cancelled" | "interrupted";
  name: string;
  url?: string;
  files: { path: string; size: number | null }[];
  received?: number[];
  bytes_total: number;
  bytes_done: number;
  hashed?: number;
  dataset_id?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  chunk_size: number;
}

export interface DatasetTask {
  task_id: string;
  action: "sync" | "evict";
  dataset_id: string;
  nodes: Record<string, { status: "RUNNING" | "COMPLETED" | "FAILED"; detail?: string | null; seconds?: number | null; hostname?: string | null }>;
}

export interface DatasetStorage { data_root: string; free_bytes: number; total_bytes: number; datasets_bytes: number; chunk_size: number }
