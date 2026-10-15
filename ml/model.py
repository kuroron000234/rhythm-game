"""Small chart model: log-mel (+ difficulty) → per-frame note-start and hold logits for 4 lanes."""
import torch
from torch import nn


class Res(nn.Module):
    def __init__(self, ch: int, dilation: int):
        super().__init__()
        self.conv = nn.Conv1d(ch, ch, 3, padding=dilation, dilation=dilation)
        self.norm = nn.BatchNorm1d(ch)
        self.proj = nn.Conv1d(ch, ch, 1)

    def forward(self, x):
        return x + self.proj(torch.nn.functional.gelu(self.norm(self.conv(x))))


class ChartNet(nn.Module):
    def __init__(self, n_mels=64, ch=128, gru=96, dilations=(1, 2, 4, 8, 16, 32), repeats=2):
        super().__init__()
        self.inp = nn.Sequential(nn.Conv1d(n_mels, ch, 5, padding=2), nn.GELU())
        self.diff = nn.Embedding(3, ch)
        self.blocks = nn.Sequential(*[Res(ch, d) for _ in range(repeats) for d in dilations])
        self.gru = nn.GRU(ch, gru, batch_first=True, bidirectional=True)
        self.out = nn.Conv1d(2 * gru, 8, 1)

    def forward(self, mel, diff):
        """mel (B, 64, T), diff (B,) int64 → logits (B, 8, T): [0:4] note start, [4:8] hold."""
        x = self.inp(mel) + self.diff(diff)[:, :, None]
        x = self.blocks(x)
        y, _ = self.gru(x.transpose(1, 2))
        return self.out(y.transpose(1, 2))
