"""Export a trained checkpoint to ONNX + thresholds JSON for the browser.

python ml/export.py runs/a/best.pt public/model   →  chartnet.onnx, chartnet.json
"""
import json, os, sys
import numpy as np
import torch

from model import ChartNet

ckpt_path, out_dir = sys.argv[1], sys.argv[2]
ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
args = ck["args"]
model = ChartNet(ch=args["ch"], gru=args["gru"])
model.load_state_dict(ck["model"])
model.eval()

os.makedirs(out_dir, exist_ok=True)
onnx_path = os.path.join(out_dir, "chartnet.onnx")
mel = torch.randn(1, 64, 1500)
diff = torch.tensor([1], dtype=torch.int64)
torch.onnx.export(model, (mel, diff), onnx_path, input_names=["mel", "diff"], output_names=["logits"],
                  dynamic_axes={"mel": {2: "T"}, "logits": {2: "T"}}, opset_version=17, dynamo=False)

version = f"{os.path.basename(os.path.dirname(os.path.abspath(ckpt_path)))}-s{ck['step']}"
meta = {"version": version, "thresholds": {d: ck["eval"][d]["thr"] for d in ("easy", "normal", "hard")},
        "eval": ck["eval"]}
json.dump(meta, open(os.path.join(out_dir, "chartnet.json"), "w"), indent=1)

try:  # sanity: onnxruntime output must match torch
    import onnxruntime as ort
    s = ort.InferenceSession(onnx_path)
    x = np.random.default_rng(0).standard_normal((1, 64, 3000)).astype(np.float32)
    for d in range(3):
        ref = model(torch.tensor(x), torch.tensor([d])).detach().numpy()
        got = s.run(None, {"mel": x, "diff": np.array([d], dtype=np.int64)})[0]
        print(f"diff {d}: max |onnx - torch| = {np.abs(ref - got).max():.2e}")
except ImportError:
    print("onnxruntime not installed; skipped the ONNX/torch comparison")
print(f"wrote {onnx_path} ({os.path.getsize(onnx_path) / 1e6:.1f} MB) and chartnet.json, version {version}")
