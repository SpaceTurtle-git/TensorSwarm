# title: GPU & Environment Info
# description: Which GPU, driver, CUDA and PyTorch this worker really has. Run this first on every new node.
# category: Diagnostics
# runtime: ~5 s
# gpu: optional

# %% [markdown]
# # GPU & environment info
# Prints what the worker that runs this code actually sees: hostname, Python, PyTorch,
# CUDA, and every GPU's name, VRAM, compute capability and multiprocessor count.

# %%
import os
import platform
import socket

import torch

print(f"Host        : {socket.gethostname()}  ({platform.system()} {platform.release()})")
print(f"Python      : {platform.python_version()}")
print(f"PyTorch     : {torch.__version__}  (built for CUDA {torch.version.cuda})")
print(f"cuDNN       : {torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else 'n/a'}")
print(f"CUDA ready  : {torch.cuda.is_available()}")
print(f"Visible GPUs: {os.environ.get('CUDA_VISIBLE_DEVICES', '(all)')}")

# %%
gpus = []
if torch.cuda.is_available():
    for i in range(torch.cuda.device_count()):
        p = torch.cuda.get_device_properties(i)
        free, total = torch.cuda.mem_get_info(i)
        gpus.append({
            "index": i,
            "name": p.name,
            "compute_capability": f"{p.major}.{p.minor}",
            "vram_total_gb": round(p.total_memory / 1024 ** 3, 2),
            "vram_free_gb": round(free / 1024 ** 3, 2),
            "multiprocessors": p.multi_processor_count,
        })
        print(f"GPU {i}: {p.name} | CC {p.major}.{p.minor} | {p.total_memory / 1024 ** 3:.2f} GB "
              f"({free / 1024 ** 3:.2f} GB free) | {p.multi_processor_count} SMs")
else:
    print("No CUDA GPU visible to PyTorch. Check the NVIDIA driver (nvidia-smi) and the CUDA build.")

result = gpus or "CPU only"
result
