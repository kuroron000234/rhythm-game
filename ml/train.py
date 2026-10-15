"""Train ChartNet to imitate MuG teacher charts.

python ml/train.py --data ~/rg-data --out runs/a [--steps 6000 --ch 128 --gru 96 --lr 2e-3]
Logs JSON lines; keeps the checkpoint with the best validation F1 (± 50 ms, lane-aware, mean over difficulties).
"""
import argparse, glob, json, math, os, time
import numpy as np
import torch
import torch.nn.functional as F

from dataset import Crops, DIFFS, parse_osu
from features import HOP, SR
from model import ChartNet

FRAME = HOP / SR


def decode(onset: np.ndarray, hold: np.ndarray, thr: float):
    """Mirror of src/analysis/neural.ts decode(): (4,T) probabilities → [(t, lane, end|None)]."""
    notes = []
    T = onset.shape[1]
    for lane in range(4):
        p = onset[lane]
        f = 0
        while f < T:
            if p[f] >= thr and p[f] == p[max(0, f - 3):f + 4].max():
                g = f + 1
                while g < T and hold[lane, g] >= 0.5:
                    g += 1
                end = (g - 1) * FRAME if (g - 1 - f) * FRAME >= 0.15 else None
                notes.append((f * FRAME, lane, end))
                f += 4
            else:
                f += 1
    return sorted(notes)


def f1(pred, ref, tol=0.05, lanes=True):
    used = [False] * len(ref)
    tp = 0
    j0 = 0
    for t, lane, _ in pred:
        while j0 < len(ref) and ref[j0][0] < t - tol:
            j0 += 1
        j = j0
        while j < len(ref) and ref[j][0] <= t + tol:
            if not used[j] and (not lanes or ref[j][1] == lane):
                used[j] = True
                tp += 1
                break
            j += 1
    p = tp / max(1, len(pred)); r = tp / max(1, len(ref))
    return 0.0 if tp == 0 else 2 * p * r / (p + r)


@torch.no_grad()
def predict(model, mel: np.ndarray, diff: int, device):
    x = torch.tensor(mel.astype(np.float32)[None], device=device)
    y = torch.sigmoid(model(x, torch.tensor([diff], device=device))).cpu().numpy()[0]
    return y[:4], y[4:]


def calibrate(probs, counts):
    """Threshold so the total predicted note count matches the teacher's."""
    lo, hi = 0.05, 0.95
    for _ in range(20):
        mid = (lo + hi) / 2
        n = sum(len(decode(o, h, mid)) for o, h in probs)
        if n > counts: lo = mid
        else: hi = mid
    return (lo + hi) / 2


def evaluate(model, val_items, device):
    model.eval()
    res = {}
    for d, name in enumerate(DIFFS):
        probs = [predict(model, it["mel"], d, device) for it in val_items]
        refs = [it["notes"][d] for it in val_items]
        thr = calibrate(probs, sum(len(r) for r in refs))
        preds = [decode(o, h, thr) for o, h in probs]
        res[name] = {
            "thr": round(thr, 4),
            "f1_lane": round(float(np.mean([f1(p, r) for p, r in zip(preds, refs)])), 4),
            "f1_time": round(float(np.mean([f1(p, r, lanes=False) for p, r in zip(preds, refs)])), 4),
            "hold_ratio_pred": round(sum(n[2] is not None for p in preds for n in p) / max(1, sum(len(p) for p in preds)), 3),
            "hold_ratio_ref": round(sum(n[2] is not None for r in refs for n in r) / max(1, sum(len(r) for r in refs)), 3),
        }
    model.train()
    return res


def load_split(data, split):
    songs = json.load(open(os.path.join(data, "manifest.json")))
    ids = [s["id"] for s in songs if s.get("split") == split and os.path.exists(os.path.join(data, "feats", f"{s['id']}.npz"))]
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/rg-data"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--length", type=int, default=1024)
    ap.add_argument("--ch", type=int, default=128)
    ap.add_argument("--gru", type=int, default=96)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--onset-weight", type=float, default=10.0)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "log.jsonl"), "a")
    emit = lambda **kw: (print(json.dumps(kw), flush=True), log.write(json.dumps(kw) + "\n"), log.flush())

    train_ids, val_ids = load_split(a.data, "train"), load_split(a.data, "val")
    feats = lambda i: os.path.join(a.data, "feats", f"{i}.npz")
    crops = Crops([feats(i) for i in train_ids], a.length)
    val_items = []
    for i in val_ids:
        z = np.load(feats(i))
        val_items.append({"mel": z["mel"], "notes": [parse_osu(os.path.join(a.data, "teacher", i, f"{d}.osu")) for d in DIFFS]})
    emit(stage="data", train=len(train_ids), val=len(val_ids), args=vars(a))

    device = torch.device(a.device)
    model = ChartNet(ch=a.ch, gru=a.gru).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, s / 300) * 0.5 * (1 + math.cos(math.pi * min(1, s / a.steps))))
    best, t0 = -1.0, time.time()
    for step in range(1, a.steps + 1):
        mel, diff, onset, hold, mask = (torch.tensor(v, device=device) for v in crops.sample(a.batch))
        y = model(mel, diff)
        m = mask[:, None, :]
        lo = F.binary_cross_entropy_with_logits(y[:, :4], onset, reduction="none",
                                                pos_weight=torch.tensor(a.onset_weight, device=device))
        lh = F.binary_cross_entropy_with_logits(y[:, 4:], hold, reduction="none",
                                                pos_weight=torch.tensor(2.0, device=device))
        loss = ((lo + lh) * m).sum() / (m.sum() * 4)
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step()
        if step % 100 == 0:
            emit(stage="train", step=step, loss=round(loss.item(), 4), s=round(time.time() - t0))
        if step % a.eval_every == 0 or step == a.steps:
            res = evaluate(model, val_items, device)
            score = float(np.mean([r["f1_lane"] for r in res.values()]))
            emit(stage="eval", step=step, score=round(score, 4), **res)
            if score > best:
                best = score
                torch.save({"model": model.state_dict(), "args": vars(a), "eval": res, "step": step}, os.path.join(a.out, "best.pt"))
    emit(stage="done", best=round(best, 4), s=round(time.time() - t0))


if __name__ == "__main__":
    main()
