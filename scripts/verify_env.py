"""
TensorSwarm portable-environment check.

Run with the USB interpreter, on any PC:
    E:\\TensorSwarm\\python_env\\python.exe E:\\TensorSwarm\\scripts\\verify_env.py

build_usb_env.ps1 calls it with --manifest to record the exact versions baked into the USB.
Every node in one Ray cluster must report the SAME Python (down to the patch release) and Ray version.
"""

import argparse
import importlib
import json
import platform
import sys

REQUIRED = ["ray", "fastapi", "uvicorn", "pydantic", "requests", "psutil", "pynvml"]


def _version_of(module_name: str) -> str:
    module = importlib.import_module(module_name)
    version = getattr(module, "__version__", None)
    if version:
        return str(version)
    try:
        from importlib.metadata import version as dist_version
        dist = {"pynvml": "nvidia-ml-py"}.get(module_name, module_name)
        return dist_version(dist)
    except Exception:
        return "installed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", help="Write a JSON manifest of the environment to this path.")
    args = parser.parse_args()

    info = {
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    ok = True

    for name in REQUIRED:
        try:
            info[name] = _version_of(name)
        except Exception as exc:  # noqa: BLE001 - report every failure, keep going
            info[name] = f"MISSING ({exc.__class__.__name__}: {exc})"
            ok = False

    try:
        import torch

        info["torch"] = torch.__version__
        info["torch_cuda"] = torch.version.cuda or "cpu"
        info["cuda_available_here"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            info["gpu_here"] = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001
        info["torch"] = f"MISSING ({exc.__class__.__name__}: {exc})"

    print("TensorSwarm portable environment")
    print("-" * 60)
    for key, value in info.items():
        print(f"  {key:<22} {value}")
    print("-" * 60)
    print("  RESULT:", "OK" if ok else "BROKEN - re-run build_usb_env.cmd")

    if args.manifest:
        # Only facts about the USB build, not about the PC it happens to be plugged into.
        manifest = {k: v for k, v in info.items() if not k.endswith("_here") and k != "platform"}
        with open(args.manifest, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
        print(f"  manifest written to {args.manifest}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
