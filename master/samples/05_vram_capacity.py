# title: Usable VRAM Check
# description: Allocates VRAM in 256 MB blocks until it runs out (stops at 95%), writes and verifies every block, then frees it all.
# category: Diagnostics
# runtime: ~10 s
# gpu: required

# %% [markdown]
# # Usable VRAM
# The number on the box is not what your model gets: the display, other apps and the CUDA
# context all take a share. This fills the free VRAM block by block, verifies each block, and
# tells you how much a training job can really use. Watch the VRAM chart on the Cluster page.

# %%
import torch

assert torch.cuda.is_available(), "This check needs a CUDA GPU."
dev = torch.device("cuda")
BLOCK_MB = 256
free, total = torch.cuda.mem_get_info()
limit = int(free * 0.95)
print(f"{torch.cuda.get_device_name(0)}: {total / 1024 ** 3:.2f} GB total, {free / 1024 ** 3:.2f} GB free before the test")

blocks, allocated, bad = [], 0, 0
try:
    while allocated + BLOCK_MB * 1024 ** 2 <= limit:
        block = torch.full((BLOCK_MB * 1024 ** 2 // 4,), float(len(blocks)), device=dev)
        blocks.append(block)
        allocated += BLOCK_MB * 1024 ** 2
        if len(blocks) % 4 == 0:
            print(f"  allocated {allocated / 1024 ** 3:.2f} GB")
except torch.cuda.OutOfMemoryError:
    print("  out of memory (expected near the limit)")

# %%
for i, block in enumerate(blocks):
    if not bool((block == float(i)).all()):
        bad += 1
del blocks
torch.cuda.empty_cache()

usable_gb = allocated / 1024 ** 3
result = f"{usable_gb:.2f} GB usable, {bad} corrupted block(s)"
print(result)
result
