"""Export a trained checkpoint for the browser.

python ml/export.py runs/x/best.pt public/model
  chartnet.onnx   FrameNet: mel (1,64,T) + diff (1,) → onset (1,T), chord (1,4,T), feat (1,64,T)
  chartnet.json   version, per-difficulty note-start thresholds, sampling temperature, LaneNet weights
"""
import json, os, sys
import numpy as np
import torch

from model import FrameNet, LaneNet

ckpt_path, out_dir = sys.argv[1], sys.argv[2]
ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
args = ck["args"]
frame = FrameNet(ch=args["ch"], gru=args["gru"]); frame.load_state_dict(ck["frame"]); frame.eval()
lane = LaneNet(args["lane_hidden"]); lane.load_state_dict(ck["lane"]); lane.eval()


class Export(torch.nn.Module):
    def __init__(self, f):
        super().__init__()
        self.f = f

    def forward(self, mel, diff):
        o, c, x = self.f(mel, diff)
        return torch.sigmoid(o), c, x


os.makedirs(out_dir, exist_ok=True)
onnx_path = os.path.join(out_dir, "chartnet.onnx")
wrapped = Export(frame).eval()  # a fresh wrapper is in train mode, which export would push down to BatchNorm
torch.onnx.export(wrapped, (torch.randn(1, 64, 1500), torch.tensor([1])), onnx_path,
                  input_names=["mel", "diff"], output_names=["onset", "chord", "feat"],
                  dynamic_axes={"mel": {2: "T"}, "onset": {1: "T"}, "chord": {2: "T"}, "feat": {2: "T"}},
                  opset_version=17, dynamo=False)

# chord calibration on validation songs: bias on multi-note sizes so the chord share matches the teacher
import json as _json
from dataset import DIFFS, parse_osu
from train import decode, pattern_stats, predict
data = os.path.expanduser(os.environ.get("RG_DATA", "~/rg-data"))
songs = [s for s in _json.load(open(os.path.join(data, "manifest.json"))) if s.get("split") == "val"][:12]
chord_bias = {}
for i, d in enumerate(DIFFS):
    outs = [predict(frame, np.load(os.path.join(data, "feats", f"{s['id']}.npz"))["mel"], i, "cpu") for s in songs]
    target = pattern_stats([parse_osu(os.path.join(data, "teacher", s["id"], f"{d}.osu")) for s in songs])["chord"]
    share = lambda b: pattern_stats([decode(o, c, f, lane, ck["eval"][d]["thr"], 1.0, 1 + k, b) for k, (o, c, f) in enumerate(outs)])["chord"]
    lo, hi = -3.0, 6.0
    for _ in range(9):
        mid = (lo + hi) / 2
        if share(mid) > target: lo = mid
        else: hi = mid
    chord_bias[d] = round((lo + hi) / 2, 3)
    print(f"{d}: chord bias {chord_bias[d]} (teacher chord share {target})", flush=True)

sd = {k: v.detach().numpy().astype(np.float64) for k, v in lane.state_dict().items()}
r = lambda a: [round(float(v), 7) for v in a.ravel()]
meta = {
    "version": f"{os.path.basename(os.path.dirname(os.path.abspath(ckpt_path)))}-s{ck['step']}",
    "thresholds": {d: ck["eval"][d]["thr"] for d in ("easy", "normal", "hard")},
    "temperature": 1.0,
    "chordBias": chord_bias,
    "lane": {"hidden": lane.hidden, "input": LaneNet.IN, "w_ih": r(sd["cell.weight_ih"]), "w_hh": r(sd["cell.weight_hh"]),
             "b_ih": r(sd["cell.bias_ih"]), "b_hh": r(sd["cell.bias_hh"]), "lanes_w": r(sd["lanes.weight"]),
             "lanes_b": r(sd["lanes.bias"]), "holds_w": r(sd["holds.weight"]), "holds_b": r(sd["holds.bias"])},
    "eval": {d: {k: v for k, v in ck["eval"][d].items() if k in ("f1_time", "f1_lane", "moves_l1", "pred", "ref")} for d in ck["eval"]},
}
json.dump(meta, open(os.path.join(out_dir, "chartnet.json"), "w"), separators=(",", ":"))

try:  # sanity: onnxruntime output must match torch
    import onnxruntime as ort
    s = ort.InferenceSession(onnx_path)
    x = np.random.default_rng(0).standard_normal((1, 64, 3000)).astype(np.float32)
    for d in range(3):
        with torch.no_grad():
            ref = [t.numpy() for t in wrapped.eval()(torch.tensor(x), torch.tensor([d]))]
        got = s.run(None, {"mel": x, "diff": np.array([d], dtype=np.int64)})
        print(f"diff {d}: max |onnx - torch| = {max(np.abs(a - b).max() for a, b in zip(ref, got)):.2e}")
except ImportError:
    print("onnxruntime not installed; skipped the ONNX/torch comparison")
print(f"wrote {onnx_path} ({os.path.getsize(onnx_path) / 1e6:.1f} MB) + chartnet.json "
      f"({os.path.getsize(os.path.join(out_dir, 'chartnet.json')) / 1e3:.0f} kB), version {meta['version']}")
