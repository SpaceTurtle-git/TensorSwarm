# title: CPU vs GPU Speed-up
# description: Times the same workloads on this node's CPU and GPU and reports the speed-up for each.
# category: Benchmarks
# runtime: ~20 s
# gpu: required

# %% [markdown]
# # CPU vs GPU
# The same operations, timed on both devices. Small problems can be *faster* on the CPU
# (launch and transfer overhead); large ones are where the GPU wins.

# %%
import time
import torch

assert torch.cuda.is_available(), "This comparison needs a CUDA GPU."
gpu = torch.device("cuda")


def timeit(fn, device, repeat=5) -> float:
    fn()
    if device.type == "cuda":
        torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(repeat):
        fn()
    if device.type == "cuda":
        torch.cuda.synchronize()
    return (time.perf_counter() - t) / repeat


def workloads(device):
    m = torch.randn(2048, 2048, device=device)
    small = torch.randn(64, 64, device=device)
    img = torch.randn(16, 3, 128, 128, device=device)
    conv = torch.nn.Conv2d(3, 32, 3, padding=1).to(device)
    v = torch.randn(10_000_000, device=device)
    return {
        "matmul 2048x2048": lambda: m @ m,
        "matmul 64x64 (tiny)": lambda: small @ small,
        "conv2d 16x3x128x128": lambda: conv(img),
        "elementwise 10M": lambda: (v * 2 + 1).sin(),
        "sort 10M": lambda: v.sort(),
    }


# %%
cpu_t = {k: timeit(f, torch.device("cpu")) for k, f in workloads(torch.device("cpu")).items()}
gpu_t = {k: timeit(f, gpu) for k, f in workloads(gpu).items()}
print(f"{'workload':<24}{'CPU ms':>10}{'GPU ms':>10}{'speed-up':>10}")
for k in cpu_t:
    print(f"{k:<24}{cpu_t[k] * 1000:>10.2f}{gpu_t[k] * 1000:>10.2f}{cpu_t[k] / gpu_t[k]:>9.1f}x")

result = {k: f"{cpu_t[k] / gpu_t[k]:.1f}x" for k in cpu_t}
result
