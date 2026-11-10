# title: GPU Correctness Check
# description: Runs the same math on the GPU and the CPU and compares the answers. Catches broken drivers, bad VRAM or overclocks.
# category: Diagnostics
# runtime: ~10 s
# gpu: required

# %% [markdown]
# # Correctness check
# Fast is useless if the numbers are wrong. Each test computes a result on the GPU and on
# the CPU (float64 reference) and reports the largest relative error.

# %%
import torch

assert torch.cuda.is_available(), "This check needs a CUDA GPU."
dev = torch.device("cuda")
torch.manual_seed(0)


def rel_err(gpu_val: torch.Tensor, ref: torch.Tensor) -> float:
    gpu_val = gpu_val.double().cpu()
    return ((gpu_val - ref).abs().max() / ref.abs().max().clamp_min(1e-12)).item()


checks = []

# %%
a = torch.randn(1024, 1024, dtype=torch.float64)
b = torch.randn(1024, 1024, dtype=torch.float64)
ref = a @ b
checks.append(("matmul fp32", rel_err(a.float().to(dev) @ b.float().to(dev), ref), 1e-4))
checks.append(("matmul fp16", rel_err((a.half().to(dev) @ b.half().to(dev)).float(), ref), 2e-2))

x = torch.randn(4096, 1024, dtype=torch.float64)
checks.append(("softmax", rel_err(torch.softmax(x.float().to(dev), dim=1), torch.softmax(x, dim=1)), 1e-5))
checks.append(("sum reduction", rel_err(x.float().to(dev).sum(dim=0), x.sum(dim=0)), 1e-4))

img = torch.randn(8, 3, 64, 64, dtype=torch.float64)
w = torch.randn(16, 3, 3, 3, dtype=torch.float64)
conv_ref = torch.nn.functional.conv2d(img, w, padding=1)
checks.append(("conv2d", rel_err(torch.nn.functional.conv2d(img.float().to(dev), w.float().to(dev), padding=1), conv_ref), 1e-4))

# Data round trip through VRAM must be bit exact.
blob = torch.randint(0, 2 ** 31 - 1, (8 * 1024 * 1024,), dtype=torch.int64)
checks.append(("VRAM round trip (64 MB)", float((blob.to(dev).cpu() != blob).sum().item()), 0.0))

# %%
failed = 0
print(f"{'test':<26}{'rel. error':>12}  {'limit':>8}  result")
for name, err, limit in checks:
    ok = err <= limit
    failed += not ok
    print(f"{name:<26}{err:>12.2e}  {limit:>8.0e}  {'PASS' if ok else 'FAIL'}")

result = "All checks passed" if failed == 0 else f"{failed} check(s) FAILED"
print("\n" + result + f" on {torch.cuda.get_device_name(0)}")
result
