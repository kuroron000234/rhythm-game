#!/usr/bin/env bash
# Sets up MuG Diffusion (https://github.com/Keytoyze/Mug-Diffusion, MIT; weights non-commercial)
# in .mug/ for AI charts learned from human-made 4K charts.
# Reuses an existing system PyTorch when there is one; otherwise installs the CPU build (slow but works).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_COMMIT=c2903d4e3d7216d94ef512a9872bc77423c6e0ac
# Official weights are only shipped inside the app ZIP on Google Drive; this is a re-upload of that file.
WEIGHTS_URL=https://huggingface.co/ayousanz/Mug-Diffusion-model/resolve/main
WEIGHTS_SHA256=af6ab91337d0ef6b518367082ac3f849448c6daaa01fd987678fb25ea44ca184
PY="${PYTHON:-python3}"

if [ ! -d .mug/.git ]; then
  git clone https://github.com/Keytoyze/Mug-Diffusion .mug
fi
git -C .mug fetch --depth 1 origin "$REPO_COMMIT" 2>/dev/null || true
git -C .mug checkout -q "$REPO_COMMIT"

if command -v uv >/dev/null; then
  uv venv --allow-existing --system-site-packages -p "$PY" .mug/.venv
  PIP=(uv pip install --python .mug/.venv/bin/python)
else
  "$PY" -m venv --system-site-packages .mug/.venv
  PIP=(.mug/.venv/bin/python -m pip install)
fi
if ! .mug/.venv/bin/python -c "import torch" 2>/dev/null; then
  echo "PyTorch が見つからないので CPU 版を入れます(GPU 版が欲しい場合は先に PyTorch を入れてから再実行)"
  "${PIP[@]}" torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi
"${PIP[@]}" numpy pillow pyyaml omegaconf tqdm einops scipy librosa audioread soundfile packaging eyed3 requests pytorch_lightning reamber opt-einsum

mkdir -p .mug/models/ckpt
if [ ! -f .mug/models/ckpt/model.ckpt ] || ! echo "$WEIGHTS_SHA256  .mug/models/ckpt/model.ckpt" | sha256sum -c --status; then
  echo "モデルをダウンロード中 (約 1.8GB)…"
  curl -L --fail -o .mug/models/ckpt/model.ckpt.part "$WEIGHTS_URL/model.ckpt"
  echo "$WEIGHTS_SHA256  .mug/models/ckpt/model.ckpt.part" | sha256sum -c
  mv .mug/models/ckpt/model.ckpt.part .mug/models/ckpt/model.ckpt
fi
curl -sL --fail -o .mug/models/ckpt/model.yaml "$WEIGHTS_URL/model.yaml"
cp scripts/mug_cli.py .mug/mug_cli.py
.mug/.venv/bin/python -c "import torch; print('MuG OK, device:', 'GPU (CUDA)' if torch.cuda.is_available() else 'CPU')"
