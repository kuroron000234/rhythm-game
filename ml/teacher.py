"""Generate MuG teacher charts for every collected song that does not have them yet.

Usage: python ml/teacher.py [--data ~/rg-data]   (runs the .mug venv; GPU strongly recommended)
Writes <data>/teacher/<id>/{easy,normal,hard}.osu
"""
import argparse, json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIFFS = ["easy", "normal", "hard"]
STARS = ["1.3", "2.2", "3.2"]  # same as server/mug.ts

ap = argparse.ArgumentParser()
ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
ap.add_argument("--seeds", type=int, default=1, help="teacher samples per song (seed 0 → teacher/<id>/, k → teacher/<id>/s<k>/)")
ap.add_argument("--shard", default="0/1", help="i/n or a-b/n: only take pending jobs whose index mod n is in the set (split work across GPUs/machines)")
ap.add_argument("--mug", default=os.path.join(ROOT, ".mug"), help="MuG checkout with .venv and weights")
a = ap.parse_args()
songs = json.load(open(os.path.join(a.data, "manifest.json")))
code = 0
for k in range(a.seeds):
    todo = []
    for s in songs:
        out = os.path.join(a.data, "teacher", s["id"], *([f"s{k}"] if k else []))
        if all(os.path.exists(os.path.join(out, f"{d}.osu")) for d in DIFFS):
            continue
        todo.append(f"{os.path.join(a.data, 'audio', s['file'])}\t{out}")
    part, sn = a.shard.split("/")
    lo, hi = (map(int, part.split("-")) if "-" in part else (int(part), int(part)))
    todo = [j for i, j in enumerate(todo) if lo <= i % int(sn) <= hi]
    print(f"seed {k}: {len(todo)} songs to chart (shard {a.shard})", flush=True)
    if not todo:
        continue
    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as f:
        f.write("\n".join(todo) + "\n")
    cmd = [os.path.join(a.mug, ".venv/bin/python"), os.path.join(a.mug, "mug_cli.py"),
           "--batch", f.name, "--sr", *STARS, "--names", *DIFFS, "--seed", str(1 + k * 1000)]
    code |= subprocess.run(cmd).returncode
sys.exit(code)
