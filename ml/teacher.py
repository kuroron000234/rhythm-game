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
a = ap.parse_args()
songs = json.load(open(os.path.join(a.data, "manifest.json")))
todo = []
for s in songs:
    out = os.path.join(a.data, "teacher", s["id"])
    if all(os.path.exists(os.path.join(out, f"{d}.osu")) for d in DIFFS):
        continue
    todo.append(f"{os.path.join(a.data, 'audio', s['file'])}\t{out}")
print(f"{len(todo)} songs to chart", flush=True)
if todo:
    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as f:
        f.write("\n".join(todo) + "\n")
    cmd = [os.path.join(ROOT, ".mug/.venv/bin/python"), os.path.join(ROOT, ".mug/mug_cli.py"),
           "--batch", f.name, "--sr", *STARS, "--names", *DIFFS]
    sys.exit(subprocess.run(cmd).returncode)
