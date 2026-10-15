"""Preprocess songs + teacher charts into training arrays, and the torch Dataset that crops them.

python ml/dataset.py [--data ~/rg-data]  →  <data>/feats/<id>.npz with
  mel   (64, T) float16    log-mel features (ml/features.py)
  onset (3, 4, T) float16  per difficulty/lane: 1 at note starts, 0.3 on the neighbouring frames
  hold  (3, 4, T) uint8    1 while a long note is held
"""
import argparse, json, os, subprocess
import numpy as np

from features import HOP, SR, log_mel

DIFFS = ["easy", "normal", "hard"]


def parse_osu(path: str):
    """→ list of (time_s, lane, end_s|None) for a 4K osu!mania file."""
    text = open(path, encoding="utf-8").read()
    body = text.split("[HitObjects]")[1]
    out = []
    for line in body.splitlines():
        f = line.strip().split(",")
        if len(f) < 5:
            continue
        lane = min(3, max(0, int(float(f[0]) * 4 // 512)))
        t = int(f[2]) / 1000
        end = int(f[5].split(":")[0]) / 1000 if int(f[3]) & 128 else None
        out.append((t, lane, end if end and end > t else None))
    return out


def frame_of(t: float) -> int:
    return int(round(t * SR / HOP))


def targets(notes, n_frames: int):
    onset = np.zeros((4, n_frames), np.float32)
    hold = np.zeros((4, n_frames), np.uint8)
    for t, lane, end in notes:
        f = frame_of(t)
        if not 0 <= f < n_frames:
            continue
        for d, v in ((-1, 0.3), (1, 0.3), (0, 1.0)):
            if 0 <= f + d < n_frames:
                onset[lane, f + d] = max(onset[lane, f + d], v)
        if end:
            hold[lane, f:min(n_frames, frame_of(end) + 1)] = 1
    return onset, hold


def decode_audio(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4")


def preprocess(data: str):
    songs = json.load(open(os.path.join(data, "manifest.json")))
    os.makedirs(os.path.join(data, "feats"), exist_ok=True)
    done = 0
    for s in songs:
        out = os.path.join(data, "feats", f"{s['id']}.npz")
        tdir = os.path.join(data, "teacher", s["id"])
        if os.path.exists(out) or not all(os.path.exists(os.path.join(tdir, f"{d}.osu")) for d in DIFFS):
            continue
        mel = log_mel(decode_audio(os.path.join(data, "audio", s["file"])))
        T = mel.shape[1]
        ons, hol = zip(*(targets(parse_osu(os.path.join(tdir, f"{d}.osu")), T) for d in DIFFS))
        np.savez_compressed(out, mel=mel.astype(np.float16), onset=np.stack(ons).astype(np.float16), hold=np.stack(hol))
        done += 1
    print(f"preprocessed {done} songs")


class Crops:
    """Random (song, difficulty, window) crops for training. Built lazily so this file imports without torch."""

    def __init__(self, files, length: int, seed: int = 0):
        self.items = [np.load(f) for f in files]
        self.items = [{k: it[k] for k in ("mel", "onset", "hold")} for it in self.items]
        self.length = length
        self.rng = np.random.default_rng(seed)

    def sample(self, batch: int):
        L = self.length
        mel = np.zeros((batch, 64, L), np.float32)
        onset = np.zeros((batch, 4, L), np.float32)
        hold = np.zeros((batch, 4, L), np.float32)
        diff = np.zeros(batch, np.int64)
        mask = np.zeros((batch, L), np.float32)
        for b in range(batch):
            it = self.items[self.rng.integers(len(self.items))]
            T = it["mel"].shape[1]
            s = int(self.rng.integers(0, max(1, T - L)))
            n = min(L, T - s)
            d = int(self.rng.integers(3))
            mel[b, :, :n] = it["mel"][:, s:s + n]
            onset[b, :, :n] = it["onset"][d, :, s:s + n]
            hold[b, :, :n] = it["hold"][d, :, s:s + n]
            diff[b] = d
            mask[b, :n] = 1
        return mel, diff, onset, hold, mask


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
    preprocess(ap.parse_args().data)
