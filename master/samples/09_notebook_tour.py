# title: Notebook Tour
# description: What the notebook can do: variables that persist between cells, shell commands, rich display, live output and interrupt.
# category: Notebook
# runtime: ~30 s
# gpu: optional
# mode: notebook

# %% [markdown]
# # Welcome to the TensorSwarm notebook
# Every cell runs in a **persistent Python process on the worker you connected to**, just
# like a Colab runtime. Run cells with **Shift+Enter**.

# %%
# Variables survive between cells. Define something here...
import torch

device = "cuda" if torch.cuda.is_available() else "cpu"
x = torch.randn(1000, 1000, device=device)
print("created x on", device)

# %%
# ...and use it in the next one. The value of the last line is displayed automatically.
x.mean().item(), x.std().item()

# %%
# Lines starting with ! run in the worker's shell, like in Colab.
!nvidia-smi --query-gpu=name,memory.used,memory.total,temperature.gpu --format=csv

# %%
# display() renders images. Here: a small picture computed on the GPU.
from PIL import Image

xs = torch.linspace(-2, 1, 480, device=device)
ys = torch.linspace(-1.2, 1.2, 360, device=device)
c = xs[None, :] + 1j * ys[:, None]
z = torch.zeros_like(c)
escape = torch.zeros(c.shape, device=device)
for i in range(60):
    z = z * z + c
    escape += (z.abs() < 2).float()
pixels = (255 * (escape / escape.max())).byte().cpu().numpy()
display(Image.fromarray(pixels).convert("L"))

# %%
# Output streams live while a cell runs. Press Interrupt (or Ctrl+M I) to stop this early.
import time

for step in range(1, 21):
    print(f"step {step}/20")
    time.sleep(1)
