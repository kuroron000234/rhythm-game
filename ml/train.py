"""Train FrameNet + LaneNet to imitate MuG teacher charts.

python ml/train.py --data ~/rg-data --out runs/x [--steps 8000 ...]
Selection metric: lane-agnostic onset F1 (±50 ms) averaged over difficulties; lane patterns are reported as
distribution distances against the teacher (exact lanes are not comparable: MuG itself varies them per sample).
"""
import argparse, json, math, os, time
import numpy as np
import torch
import torch.nn.functional as F

from dataset import Crops, DIFFS, parse_osu
from features import HOP, SR
from model import FEAT, HOLD_MID, LaneNet, FrameNet, hold_bucket

FRAME = HOP / SR
MIN_GAP = 0.09          # same-lane spacing (s); matches src/analysis/osu.ts MIN_LANE_GAP
BITS = np.array([[(m >> l) & 1 for l in range(4)] for m in range(16)], np.float32)   # bitmask → 4 lanes


def dt_feature(dt: float) -> float:
    """Shared with src/analysis/neural.ts."""
    return min(3.0, math.log1p(max(0.0, dt) / 0.1)) / 3.0


def lane_input(feat, size: int, dt: float, prev: int, held: int) -> np.ndarray:
    x = np.zeros(LaneNet.IN, np.float32)
    x[:FEAT] = feat
    x[FEAT + size - 1] = 1
    x[FEAT + 4] = dt_feature(dt)
    x[FEAT + 5:FEAT + 9] = BITS[prev]
    x[FEAT + 9:FEAT + 13] = BITS[held]
    return x


def peaks(p: np.ndarray, thr: float):
    out, f, T = [], 0, len(p)
    while f < T:
        if p[f] >= thr and p[f] == p[max(0, f - 3):f + 4].max():
            out.append(f); f += 4
        else:
            f += 1
    return out


def mulberry32(seed: int):
    """Same PRNG as src/analysis/neural.ts, so sampled charts are reproducible in both."""
    state = [seed & 0xFFFFFFFF]

    def nxt() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt


def pick(logits, allowed, temp, rnd):
    """Argmax (temp 0) or sample from softmax(logits/temp) over the allowed indices."""
    idx = [i for i in range(len(logits)) if allowed[i]]
    if not idx:
        return -1
    if temp <= 0:
        return max(idx, key=lambda i: logits[i])
    m = max(logits[i] for i in idx)
    w = [math.exp((logits[i] - m) / temp) for i in idx]
    r = rnd() * sum(w)
    for i, wi in zip(idx, w):
        r -= wi
        if r <= 0:
            return i
    return idx[-1]


@torch.no_grad()
def decode(onset_p, chord_logits, feat, lane: LaneNet, thr: float, temp: float = 1.0, seed: int = 1, chord_bias: float = 0.0):
    """Mirror of src/analysis/neural.ts decode(): returns [(t, lane, end|None)]."""
    rnd = mulberry32(seed)
    notes = []
    h = torch.zeros(1, lane.hidden)
    prev, last_t = 0, -10.0
    lane_end = [-10.0] * 4
    for f in peaks(onset_p, thr):
        t = f * FRAME
        cl = chord_logits[:, f].tolist()
        cl = [cl[0]] + [v - chord_bias for v in cl[1:]]      # calibration: fewer (bias > 0) or more chords
        size = pick(cl, [True] * 4, temp, rnd) + 1
        held = sum(1 << l for l in range(4) if lane_end[l] > t)
        x = torch.tensor(lane_input(feat[:, f], size, t - last_t, prev, held))[None]
        lg, hl, h = lane.step(x, h)
        lg, hl = lg[0].numpy(), hl[0].numpy()
        ok = [t - lane_end[l] >= MIN_GAP for l in range(4)]
        best = 0
        for want in range(size, 0, -1):                     # fall back to smaller chords if needed
            allowed = [bin(m).count("1") == want and all(ok[l] for l in range(4) if m >> l & 1) for m in range(1, 16)]
            k = pick(lg.tolist(), allowed, temp, rnd)
            if k >= 0:
                best = k + 1
                break
        if not best:
            continue
        for l in range(4):
            if best >> l & 1:
                dur = HOLD_MID[pick(hl[l].tolist(), [True] * len(HOLD_MID), temp, rnd)]
                notes.append((t, l, t + dur if dur else None))
                lane_end[l] = t + dur
        prev, last_t = best, t
    return sorted(notes, key=lambda n: (n[0], n[1]))


def f1(pred, ref, tol=0.05, lanes=True):
    used, tp, j0 = [False] * len(ref), 0, 0
    for t, lane, _ in pred:
        while j0 < len(ref) and ref[j0][0] < t - tol:
            j0 += 1
        j = j0
        while j < len(ref) and ref[j][0] <= t + tol:
            if not used[j] and (not lanes or ref[j][1] == lane):
                used[j] = True; tp += 1; break
            j += 1
    p, r = tp / max(1, len(pred)), tp / max(1, len(ref))
    return 0.0 if tp == 0 else 2 * p * r / (p + r)


def pattern_stats(charts):
    """Lane-movement histogram between consecutive single notes, chord share, hold share.
    `charts` is a list of per-song note lists (songs must not be merged: their times would collide)."""
    moves, events, chords, notes_n, holds = np.zeros(4), 0, 0, 0, 0
    for notes in charts:
        by = {}
        for t, l, e in notes:
            by.setdefault(round(t, 3), []).append((l, e))
        ev = [by[k] for k in sorted(by)]
        for a, b in zip(ev, ev[1:]):
            if len(a) == 1 and len(b) == 1:
                moves[abs(a[0][0] - b[0][0])] += 1
        events += len(ev)
        chords += sum(len(e) > 1 for e in ev)
        notes_n += len(notes)
        holds += sum(e is not None for _, _, e in notes)
    return {"moves": (moves / max(1, moves.sum())).round(3).tolist(),
            "chord": round(chords / max(1, events), 3), "hold": round(holds / max(1, notes_n), 3)}


@torch.no_grad()
def predict(frame, mel, d, device):
    o, c, f = frame(torch.tensor(mel.astype(np.float32)[None], device=device), torch.tensor([d], device=device))
    return torch.sigmoid(o)[0].cpu().numpy(), c[0].cpu().numpy(), f[0].cpu().numpy()


def evaluate(frame, lane, val_items, device):
    frame.eval(); lane.eval()
    lane_cpu = LaneNet(lane.hidden); lane_cpu.load_state_dict({k: v.cpu() for k, v in lane.state_dict().items()}); lane_cpu.eval()
    res = {}
    for d, name in enumerate(DIFFS):
        outs = [predict(frame, it["mel"], d, device) for it in val_items]
        refs = [it["notes"][d] for it in val_items]
        target_events = sum(len({round(t, 3) for t, _, _ in r}) for r in refs)
        lo, hi = 0.02, 0.98
        for _ in range(18):                                  # threshold matching the teacher's event count
            mid = (lo + hi) / 2
            if sum(len(peaks(o, mid)) for o, _, _ in outs) > target_events: lo = mid
            else: hi = mid
        thr = (lo + hi) / 2
        preds = [decode(o, c, f, lane_cpu, thr) for o, c, f in outs]
        ps, rs = pattern_stats(preds), pattern_stats(refs)
        res[name] = {"thr": round(thr, 4),
                     "f1_time": round(float(np.mean([f1(p, r, lanes=False) for p, r in zip(preds, refs)])), 4),
                     "f1_lane": round(float(np.mean([f1(p, r) for p, r in zip(preds, refs)])), 4),
                     "moves_l1": round(float(np.abs(np.array(ps["moves"]) - rs["moves"]).sum()), 3),
                     "pred": ps, "ref": rs}
    frame.train(); lane.train()
    return res


def lane_batch_inputs(feat, ev_frame, ev_lanes, ev_hold, e, prev, held_until):
    """Teacher-forced LaneNet inputs for event index e across the batch (torch, on device)."""
    B = feat.shape[0]
    idx = ev_frame[:, e]
    x = torch.zeros(B, LaneNet.IN, device=feat.device)
    x[:, :FEAT] = feat[torch.arange(B), :, idx]
    size = torch.tensor([bin(int(m)).count("1") for m in ev_lanes[:, e].tolist()], device=feat.device).clamp(min=1)
    x[torch.arange(B), FEAT + size - 1] = 1
    t = idx.float() * FRAME
    dt = torch.full_like(t, 10.0) if e == 0 else t - ev_frame[:, e - 1].float() * FRAME
    x[:, FEAT + 4] = torch.clamp(torch.log1p(dt.clamp(min=0) / 0.1), max=3.0) / 3.0
    bits = torch.tensor(BITS, device=feat.device)
    x[:, FEAT + 5:FEAT + 9] = bits[prev]
    x[:, FEAT + 9:FEAT + 13] = (held_until > t[:, None]).float()
    return x, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=8000)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--length", type=int, default=1024)
    ap.add_argument("--ch", type=int, default=128)
    ap.add_argument("--gru", type=int, default=96)
    ap.add_argument("--lane-hidden", type=int, default=96)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--onset-weight", type=float, default=10.0)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "log.jsonl"), "a")
    emit = lambda **kw: (print(json.dumps(kw), flush=True), log.write(json.dumps(kw) + "\n"), log.flush())

    songs = json.load(open(os.path.join(a.data, "manifest.json")))
    feats = lambda i: os.path.join(a.data, "feats", f"{i}.npz")
    ids = lambda split: [s["id"] for s in songs if s.get("split") == split and os.path.exists(feats(s["id"]))]
    crops = Crops([feats(i) for i in ids("train")], a.length)
    val_items = [{"mel": np.load(feats(i))["mel"],
                  "notes": [parse_osu(os.path.join(a.data, "teacher", i, f"{d}.osu")) for d in DIFFS]} for i in ids("val")]
    emit(stage="data", train=len(crops.items), val=len(val_items), args=vars(a))

    device = torch.device(a.device)
    frame, lane = FrameNet(ch=a.ch, gru=a.gru).to(device), LaneNet(a.lane_hidden).to(device)
    params = list(frame.parameters()) + list(lane.parameters())
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, s / 300) * 0.5 * (1 + math.cos(math.pi * min(1, s / a.steps))))
    subset_size = torch.tensor([bin(m).count("1") for m in range(1, 16)], device=device)
    hold_edges = torch.tensor([0.15, 0.3, 0.6, 1.2, 2.4], device=device)
    best, t0 = -1.0, time.time()
    for step in range(1, a.steps + 1):
        mel, diff, onset, mask, ev_frame, ev_lanes, ev_hold = (torch.tensor(v, device=device) for v in crops.sample(a.batch))
        o, c, f = frame(mel, diff)
        l_on = (F.binary_cross_entropy_with_logits(o, onset, reduction="none",
                                                   pos_weight=torch.tensor(a.onset_weight, device=device)) * mask).sum() / mask.sum()
        B, E = ev_lanes.shape
        valid = ev_lanes > 0
        n_ev = int(valid.sum(1).max())
        h = torch.zeros(B, lane.hidden, device=device)
        prev = torch.zeros(B, dtype=torch.long, device=device)
        held_until = torch.full((B, 4), -10.0, device=device)
        l_chord = l_lane = l_hold = torch.zeros((), device=device)
        cnt = 0
        for e in range(n_ev):
            v = valid[:, e]
            if not v.any():
                break
            x, size = lane_batch_inputs(f, ev_frame, ev_lanes, ev_hold, e, prev, held_until)
            lg, hl, h_new = lane.step(x, h)
            h = torch.where(v[:, None], h_new, h)
            tgt = ev_lanes[:, e].clamp(min=1) - 1
            lg = lg.masked_fill(subset_size[None, :] != size[:, None], -1e4)
            l_lane = l_lane + (F.cross_entropy(lg, tgt, reduction="none") * v).sum()
            lanes_on = torch.tensor(BITS, device=device)[ev_lanes[:, e]]                   # (B,4)
            bucket = torch.bucketize(ev_hold[:, e], hold_edges, right=True)               # 0..5
            hl_loss = F.cross_entropy(hl.reshape(-1, hl.shape[-1]), bucket.reshape(-1), reduction="none").view(B, 4)
            l_hold = l_hold + (hl_loss * lanes_on * v[:, None]).sum()
            cl = c[torch.arange(B), :, ev_frame[:, e]]
            l_chord = l_chord + (F.cross_entropy(cl, size - 1, reduction="none") * v).sum()
            t = ev_frame[:, e].float() * FRAME
            held_until = torch.where(lanes_on.bool() & v[:, None], t[:, None] + ev_hold[:, e], held_until)
            prev = torch.where(v, ev_lanes[:, e], prev)
            cnt += int(v.sum())
        loss = l_on + (l_lane + 0.5 * l_hold + 0.5 * l_chord) / max(1, cnt)
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step(); sched.step()
        if step % 100 == 0:
            emit(stage="train", step=step, loss=round(loss.item(), 4), onset=round(l_on.item(), 4),
                 lane=round(l_lane.item() / max(1, cnt), 4), s=round(time.time() - t0))
        if step % a.eval_every == 0 or step == a.steps:
            res = evaluate(frame, lane, val_items, device)
            score = float(np.mean([r["f1_time"] for r in res.values()]))
            emit(stage="eval", step=step, score=round(score, 4), **res)
            if score > best:
                best = score
                torch.save({"frame": frame.state_dict(), "lane": lane.state_dict(), "args": vars(a), "eval": res, "step": step},
                           os.path.join(a.out, "best.pt"))
    emit(stage="done", best=round(best, 4), s=round(time.time() - t0))


if __name__ == "__main__":
    main()
