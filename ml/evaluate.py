"""Test-split comparison: student vs MuG, MuG vs MuG (another sample), heuristic charts vs MuG.

python ml/evaluate.py runs/x/best.pt [--data ~/rg-data] [--split test]
"""
import argparse, json, os, subprocess, tempfile
import numpy as np
import torch

from dataset import DIFFS, parse_osu
from model import FrameNet, LaneNet
from train import decode, f1, pattern_stats, predict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("ckpt")
ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
ap.add_argument("--split", default="test")
ap.add_argument("--meta", help="chartnet.json from export.py (uses its calibrated chord bias)")
a = ap.parse_args()

ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
frame = FrameNet(ch=ck["args"]["ch"], gru=ck["args"]["gru"]); frame.load_state_dict(ck["frame"]); frame.eval()
lane = LaneNet(ck["args"]["lane_hidden"]); lane.load_state_dict(ck["lane"]); lane.eval()
thr = {d: ck["eval"][d]["thr"] for d in DIFFS}
bias = json.load(open(a.meta))["chordBias"] if a.meta else {d: 0.0 for d in DIFFS}

songs = [s for s in json.load(open(os.path.join(a.data, "manifest.json"))) if s.get("split") == a.split]
audio = [os.path.join(a.data, "audio", s["file"]) for s in songs]
with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
    subprocess.run(["npx", "tsx", os.path.join(ROOT, "ml/dsp_charts.ts"), tf.name, *audio], cwd=ROOT, check=True)
    dsp = json.load(open(tf.name))

rows = {k: {d: [] for d in DIFFS} for k in ("student", "mug2", "dsp")}
pats = {k: {d: [] for d in DIFFS} for k in ("student", "mug", "dsp")}
for s, path in zip(songs, audio):
    z = np.load(os.path.join(a.data, "feats", f"{s['id']}.npz"))
    base = os.path.join(a.data, "teacher", s["id"])
    for i, d in enumerate(DIFFS):
        ref = parse_osu(os.path.join(base, f"{d}.osu"))
        other = parse_osu(os.path.join(base, "s1", f"{d}.osu"))
        o, c, f = predict(frame, z["mel"], i, "cpu")
        stu = decode(o, c, f, lane, thr[d], temp=1.0, seed=1 + i, chord_bias=bias[d])
        heur = [tuple(n) for n in dsp[path][d]]
        for k, notes in (("student", stu), ("mug2", other), ("dsp", heur)):
            rows[k][d].append((f1(notes, ref, lanes=False), f1(notes, ref), len(notes) / max(1, len(ref))))
        pats["student"][d].append(stu); pats["mug"][d].append(ref); pats["dsp"][d].append(heur)

print(f"{len(songs)} {a.split} songs; F1 vs MuG (±50ms): time-only / with lanes / note-count ratio")
for k, label in (("mug2", "MuG (another sample)"), ("student", "student (browser model)"), ("dsp", "heuristic (old normal charts)")):
    cells = []
    for d in DIFFS:
        v = np.array(rows[k][d])
        cells.append(f"{d}: {v[:,0].mean():.2f} / {v[:,1].mean():.2f} / {v[:,2].mean():.2f}")
    print(f"  {label:32s} " + " | ".join(cells))
print("pattern stats (lane moves 0/1/2/3, chord share, hold share):")
for k in ("mug", "student", "dsp"):
    print(f"  {k:8s} " + " | ".join(f"{d}: {pattern_stats(pats[k][d])}" for d in DIFFS))
