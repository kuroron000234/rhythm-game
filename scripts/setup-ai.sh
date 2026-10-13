#!/usr/bin/env bash
# Creates .venv-ai with Demucs for AI (vocal-separated) charts.
# Reuses an existing system PyTorch when there is one; otherwise installs the CPU build.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
if command -v uv >/dev/null; then
  uv venv --system-site-packages -p "$PY" .venv-ai
  PIP=(uv pip install --python .venv-ai/bin/python)
else
  "$PY" -m venv --system-site-packages .venv-ai
  PIP=(.venv-ai/bin/python -m pip install)
fi
if ! .venv-ai/bin/python -c "import torch" 2>/dev/null; then
  echo "PyTorch が見つからないので CPU 版を入れます(GPU 版が欲しい場合は先に PyTorch を入れてから再実行)"
  "${PIP[@]}" torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi
"${PIP[@]}" demucs
.venv-ai/bin/python -c "import torch, demucs; print('Demucs OK, device:', 'GPU (CUDA)' if torch.cuda.is_available() else 'CPU')"
