"""Preprocess songs + teacher charts into training arrays, and the torch Dataset that crops them.

python ml/dataset.py [--data ~/rg-data]  →  <data>/feats/<id>.npz with
  mel   (64, T) float16    log-mel features (ml/features.py)
  onset (S, 3, 4, T) float16  per teacher sample/difficulty/lane: 1 at note starts, 0.3 on neighbouring frames
  hold  (S, 3, 4, T) uint8    1 while a long note is held
(S = number of teacher seeds available for the song; teacher/<id>/ is seed 0, teacher/<id>/s<k>/ seed k)
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


def events(notes):
    """Group notes into events by frame → (frames (E,), lane bitmasks (E,), hold seconds (E,4))."""
    by = {}
    for t, lane, end in notes:
        f = frame_of(t)
        mask, holds = by.get(f, (0, [0.0] * 4))
        holds[lane] = max(holds[lane], (end - t) if end else 0.0)
        by[f] = (mask | (1 << lane), holds)
    fr = sorted(by)
    return (np.array(fr, np.int32), np.array([by[f][0] for f in fr], np.uint8),
            np.array([by[f][1] for f in fr], np.float32).reshape(-1, 4))


def decode_audio(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4")


def teacher_dirs(data: str, sid: str):
    """Complete teacher sample directories for a song, seed 0 first."""
    base = os.path.join(data, "teacher", sid)
    dirs = [base] + sorted(os.path.join(base, n) for n in (os.listdir(base) if os.path.isdir(base) else []) if n.startswith("s"))
    return [d for d in dirs if all(os.path.exists(os.path.join(d, f"{x}.osu")) for x in DIFFS)]


def preprocess(data: str):
    songs = json.load(open(os.path.join(data, "manifest.json")))
    os.makedirs(os.path.join(data, "feats"), exist_ok=True)
    done = 0
    for s in songs:
        out = os.path.join(data, "feats", f"{s['id']}.npz")
        dirs = teacher_dirs(data, s["id"])
        if not dirs:
            continue
        if os.path.exists(out):
            with np.load(out) as z:
                if "seeds" in z and int(z["seeds"]) == len(dirs):
                    continue  # up to date
        mel = log_mel(decode_audio(os.path.join(data, "audio", s["file"])))
        arrays = {"mel": mel.astype(np.float16), "seeds": np.array(len(dirs))}
        for k, tdir in enumerate(dirs):
            for d, name in enumerate(DIFFS):
                fr, mask, hold = events(parse_osu(os.path.join(tdir, f"{name}.osu")))
                arrays[f"f{k}_{d}"], arrays[f"m{k}_{d}"], arrays[f"h{k}_{d}"] = fr, mask, hold.astype(np.float16)
        np.savez_compressed(out, **arrays)
        done += 1
    print(f"preprocessed {done} songs")


class Crops:
    """Random (song, teacher sample, difficulty, window) crops with frame targets and the note events inside."""

    def __init__(self, files, length: int, seed: int = 0):
        self.items = []
        for f in files:
            z = np.load(f)
            S = int(z["seeds"])
            self.items.append({"mel": z["mel"], "ev": [[(z[f"f{k}_{d}"], z[f"m{k}_{d}"], z[f"h{k}_{d}"].astype(np.float32))
                                                        for d in range(3)] for k in range(S)]})
        self.length = length
        self.rng = np.random.default_rng(seed)

    def sample(self, batch: int, max_events: int = 256):
        L = self.length
        mel = np.zeros((batch, 64, L), np.float32)
        onset = np.zeros((batch, L), np.float32)
        diff = np.zeros(batch, np.int64)
        mask = np.zeros((batch, L), np.float32)
        ev_frame = np.zeros((batch, max_events), np.int64)
        ev_lanes = np.zeros((batch, max_events), np.int64)       # bitmask 1..15 (0 = padding)
        ev_hold = np.zeros((batch, max_events, 4), np.float32)   # seconds
        for b in range(batch):
            it = self.items[self.rng.integers(len(self.items))]
            T = it["mel"].shape[1]
            s = int(self.rng.integers(0, max(1, T - L)))
            n = min(L, T - s)
            d = int(self.rng.integers(3))
            fr, ms, hd = it["ev"][int(self.rng.integers(len(it["ev"])))][d]
            mel[b, :, :n] = it["mel"][:, s:s + n]
            mask[b, :n] = 1
            diff[b] = d
            sel = np.nonzero((fr >= s) & (fr < s + n))[0][:max_events]
            rel = fr[sel] - s
            for off, v in ((-1, 0.3), (1, 0.3), (0, 1.0)):
                ok = (rel + off >= 0) & (rel + off < n)
                onset[b, rel[ok] + off] = np.maximum(onset[b, rel[ok] + off], v)
            ev_frame[b, :len(sel)] = rel
            ev_lanes[b, :len(sel)] = ms[sel]
            ev_hold[b, :len(sel)] = hd[sel]
        return mel, diff, onset, mask, ev_frame, ev_lanes, ev_hold


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
    preprocess(ap.parse_args().data)
