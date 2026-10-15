"""Chart model, two parts:

FrameNet  log-mel (+ difficulty) → per frame: note-start logit, chord-size logits (1–4), and a 64-d
          feature vector for the lane model. Runs once over the whole song (ONNX in the browser).
LaneNet   a small autoregressive GRU over note events: given the frame feature at the event, the time since
          the previous event, the previous lanes and the lanes still held, it picks which lanes to hit
          (one of the 15 non-empty lane subsets) and a hold-length bucket per lane. Running it note by note
          keeps lane patterns (stairs, trills, jumps) coherent the way MuG's are. Runs in TypeScript.
"""
import torch
from torch import nn

SUBSETS = [m for m in range(1, 16)]                       # lane bitmasks 1..15
SUBSET_SIZE = torch.tensor([bin(m).count("1") for m in SUBSETS])
HOLD_EDGES = [0.15, 0.3, 0.6, 1.2, 2.4]                    # seconds; bucket 0 = tap, k = [edge[k-1], edge[k])
HOLD_MID = [0.0, 0.22, 0.45, 0.9, 1.8, 3.0]                # representative length per bucket
FEAT = 64


def hold_bucket(seconds: float | None) -> int:
    if not seconds or seconds < HOLD_EDGES[0]:
        return 0
    return 1 + sum(seconds >= e for e in HOLD_EDGES[1:])


class Res(nn.Module):
    def __init__(self, ch: int, dilation: int):
        super().__init__()
        self.conv = nn.Conv1d(ch, ch, 3, padding=dilation, dilation=dilation)
        self.norm = nn.BatchNorm1d(ch)
        self.proj = nn.Conv1d(ch, ch, 1)

    def forward(self, x):
        return x + self.proj(torch.nn.functional.gelu(self.norm(self.conv(x))))


class FrameNet(nn.Module):
    def __init__(self, n_mels=64, ch=128, gru=96, dilations=(1, 2, 4, 8, 16, 32), repeats=2):
        super().__init__()
        self.inp = nn.Sequential(nn.Conv1d(n_mels, ch, 5, padding=2), nn.GELU())
        self.diff = nn.Embedding(3, ch)
        self.blocks = nn.Sequential(*[Res(ch, d) for _ in range(repeats) for d in dilations])
        self.gru = nn.GRU(ch, gru, batch_first=True, bidirectional=True)
        self.head = nn.Conv1d(2 * gru, 1 + 4 + FEAT, 1)

    def forward(self, mel, diff):
        """mel (B,64,T), diff (B,) → onset (B,T), chord (B,4,T), feat (B,FEAT,T)."""
        x = self.inp(mel) + self.diff(diff)[:, :, None]
        y, _ = self.gru(self.blocks(x).transpose(1, 2))
        o = self.head(y.transpose(1, 2))
        return o[:, 0], o[:, 1:5], torch.tanh(o[:, 5:])


class LaneNet(nn.Module):
    """Input per event: feat(64) + chord one-hot(4) + log dt(1) + prev lanes(4) + held lanes(4) = 77."""
    IN = FEAT + 4 + 1 + 4 + 4

    def __init__(self, hidden=96):
        super().__init__()
        self.hidden = hidden
        self.cell = nn.GRUCell(self.IN, hidden)
        self.lanes = nn.Linear(hidden, 15)
        self.holds = nn.Linear(hidden, 4 * len(HOLD_MID))

    def step(self, x, h):
        h = self.cell(x, h)
        return self.lanes(h), self.holds(h).view(-1, 4, len(HOLD_MID)), h
