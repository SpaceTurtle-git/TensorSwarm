# title: 60-Second Stress Test
# description: Keeps the GPU at full load for 60 s and logs TFLOPS, temperature, power and clocks every 5 s. Reveals thermal throttling.
# category: Stress
# runtime: ~65 s
# gpu: required

# %% [markdown]
# # Sustained load
# Laptop GPUs often boost for a few seconds and then slow down as they heat up. This keeps
# the GPU busy for `DURATION` seconds and prints a reading every 5 s. Open the Cluster page
# alongside to watch the live temperature, power and clock charts climb.

# %%
import time
import torch

assert torch.cuda.is_available(), "This test needs a CUDA GPU."
DURATION = 60
dev = torch.device("cuda")
n = 4096
# FP32: the dtype every NVIDIA GPU runs at full rate (FP16 is slow on GTX 16xx cards).
a = torch.randn(n, n, device=dev, dtype=torch.float32)
b = torch.randn(n, n, device=dev, dtype=torch.float32)

try:
    import pynvml
    pynvml.nvmlInit()
    nv = pynvml.nvmlDeviceGetHandleByIndex(torch.cuda.current_device())
except Exception:
    nv = None


def sensors() -> str:
    if nv is None:
        return "(NVML unavailable)"
    t = pynvml.nvmlDeviceGetTemperature(nv, pynvml.NVML_TEMPERATURE_GPU)
    try:
        p = pynvml.nvmlDeviceGetPowerUsage(nv) / 1000
    except Exception:
        p = float("nan")
    c = pynvml.nvmlDeviceGetClockInfo(nv, pynvml.NVML_CLOCK_SM)
    return f"{t:>3} °C  {p:>6.1f} W  {c:>5} MHz"


# %%
print(f"{'time':>5}  {'TFLOPS':>7}   sensors")
start = time.time()
readings = []
while time.time() - start < DURATION:
    t0, ops = time.time(), 0
    while time.time() - t0 < 5:
        for _ in range(10):
            a @ b
        torch.cuda.synchronize()
        ops += 10 * 2 * n ** 3
    tflops = ops / (time.time() - t0) / 1e12
    readings.append(tflops)
    print(f"{time.time() - start:>4.0f}s  {tflops:>7.2f}   {sensors()}")

del a, b
torch.cuda.empty_cache()
drop = (1 - readings[-1] / max(readings)) * 100 if readings else 0.0
result = f"start {readings[0]:.2f} -> end {readings[-1]:.2f} TFLOPS ({drop:.0f}% drop from peak)"
print("\n" + result)
result
