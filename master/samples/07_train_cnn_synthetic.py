# title: Train a CNN (Synthetic Data)
# description: Trains a small ResNet-style CNN for a few epochs on generated 32x32 images with mixed precision. No dataset download needed.
# category: Training
# runtime: ~40 s
# gpu: optional

# %% [markdown]
# # Training run
# A realistic end-to-end check: model, optimizer, mixed precision (AMP), a training loop, loss
# going down and images per second. The data is synthetic (class = a learnable pattern), so
# nothing is downloaded and the loss genuinely drops.

# %%
import time
import torch
import torch.nn as nn

dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.manual_seed(0)
N, CLASSES, BATCH, EPOCHS = 8192, 10, 128, 4

# Each class gets a fixed random "template"; samples are noisy copies of their template.
templates = torch.randn(CLASSES, 3, 32, 32)
labels = torch.randint(0, CLASSES, (N,))
images = templates[labels] + 1.5 * torch.randn(N, 3, 32, 32)
print(f"Training on {dev} ({torch.cuda.get_device_name(0) if dev.type == 'cuda' else 'CPU'}), {N} images")

# %%
def block(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


model = nn.Sequential(
    block(3, 32), block(32, 32), nn.MaxPool2d(2),
    block(32, 64), block(64, 64), nn.MaxPool2d(2),
    block(64, 128), nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(128, CLASSES),
).to(dev)
params = sum(p.numel() for p in model.parameters())
print(f"Model: {params / 1e3:.0f}k parameters")

opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
scaler = torch.cuda.amp.GradScaler(enabled=dev.type == "cuda")
loss_fn = nn.CrossEntropyLoss()

# %%
images_dev, labels_dev = images.to(dev), labels.to(dev)
history = []
for epoch in range(1, EPOCHS + 1):
    model.train()
    perm = torch.randperm(N, device=dev)
    t0, total_loss, correct = time.time(), 0.0, 0
    for i in range(0, N, BATCH):
        idx = perm[i:i + BATCH]
        x, y = images_dev[idx], labels_dev[idx]
        with torch.autocast(device_type=dev.type, dtype=torch.float16, enabled=dev.type == "cuda"):
            out = model(x)
            loss = loss_fn(out, y)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        total_loss += loss.item() * len(idx)
        correct += (out.argmax(1) == y).sum().item()
    if dev.type == "cuda":
        torch.cuda.synchronize()
    secs = time.time() - t0
    history.append(total_loss / N)
    print(f"epoch {epoch}: loss {total_loss / N:.3f}  acc {correct / N:6.1%}  {N / secs:7.0f} img/s")

result = f"final loss {history[-1]:.3f} (from {history[0]:.3f}), {N / secs:.0f} img/s on {dev}"
result
