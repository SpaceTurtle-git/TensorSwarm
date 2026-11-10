# title: Memory Bandwidth
# description: VRAM bandwidth (GPU to GPU copy) and PCIe bandwidth (CPU to GPU, pageable vs pinned). Shows slow PCIe links on laptops.
# category: Benchmarks
# runtime: ~15 s
# gpu: required

# %% [markdown]
# # Memory bandwidth
# * **Device to device**: how fast the GPU reads and writes its own VRAM (GB/s).
# * **Host to device / device to host**: the PCIe link. Pinned (page-locked) host memory is
#   usually much faster than normal pageable memory, which is why `DataLoader(pin_memory=True)` helps.

# %%
import time
import torch

assert torch.cuda.is_available(), "This benchmark needs a CUDA GPU."
dev = torch.device("cuda")
MB = 256
n = MB * 1024 * 1024 // 4   # float32 elements


def timed(fn, iters=10) -> float:
    fn()
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(iters):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - t) / iters


src = torch.empty(n, device=dev)
dst = torch.empty(n, device=dev)
pageable = torch.empty(n)
pinned = torch.empty(n).pin_memory()

# %%
gb = MB / 1024
rows = {
    "device -> device": 2 * gb / timed(lambda: dst.copy_(src)),   # read + write
    "host -> device (pageable)": gb / timed(lambda: src.copy_(pageable)),
    "host -> device (pinned)": gb / timed(lambda: src.copy_(pinned, non_blocking=True)),
    "device -> host (pinned)": gb / timed(lambda: pinned.copy_(src, non_blocking=True)),
}
print(f"{torch.cuda.get_device_name(0)}  ({MB} MB transfers)\n")
for k, v in rows.items():
    print(f"{k:<28}{v:>8.1f} GB/s")

del src, dst, pageable, pinned
torch.cuda.empty_cache()
result = {k: round(v, 1) for k, v in rows.items()}
result
