# title: Matrix Multiply TFLOPS
# description: Measures raw compute (TFLOPS) in FP32 and FP16 at several matrix sizes. Use it to compare workers.
# category: Benchmarks
# runtime: ~20 s
# gpu: required

# %% [markdown]
# # Matmul throughput
# A square matmul of size n does 2·n³ floating-point operations. Timing it with CUDA events
# gives the GPU's sustained TFLOPS. FP16 uses Tensor Cores on RTX cards and is several times
# faster there; GTX 16xx cards have no Tensor Cores, and cuBLAS FP16 can even be slower than FP32
# on them (a GTX 1650 measured 2.6 TFLOPS FP32 vs 0.4 TFLOPS FP16).

# %%
import torch

assert torch.cuda.is_available(), "This benchmark needs a CUDA GPU."
dev = torch.device("cuda")
name = torch.cuda.get_device_name(0)
free_gb = torch.cuda.mem_get_info()[0] / 1024 ** 3


def bench(n: int, dtype: torch.dtype, iters: int = 20) -> float:
    a = torch.randn(n, n, device=dev, dtype=dtype)
    b = torch.randn(n, n, device=dev, dtype=dtype)
    for _ in range(3):              # warm-up: cuBLAS picks its kernels here
        a @ b
    torch.cuda.synchronize()
    start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    start.record()
    for _ in range(iters):
        a @ b
    end.record()
    torch.cuda.synchronize()
    seconds = start.elapsed_time(end) / 1000 / iters
    del a, b
    return 2 * n ** 3 / seconds / 1e12


# %%
sizes = [1024, 2048, 4096] + ([8192] if free_gb > 3.5 else [])
results = {}
print(f"{name} ({free_gb:.1f} GB free)\n")
print(f"{'size':>6} {'FP32 TFLOPS':>12} {'FP16 TFLOPS':>12}")
for n in sizes:
    fp32 = bench(n, torch.float32)
    fp16 = bench(n, torch.float16)
    results[n] = {"fp32": round(fp32, 2), "fp16": round(fp16, 2)}
    print(f"{n:>6} {fp32:>12.2f} {fp16:>12.2f}")
torch.cuda.empty_cache()

best32 = max(r["fp32"] for r in results.values())
best16 = max(r["fp16"] for r in results.values())
result = f"{name}: peak {best32:.2f} TFLOPS FP32, {best16:.2f} TFLOPS FP16"
print("\n" + result)
result
