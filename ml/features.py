"""Log-mel features. MUST match src/analysis/mel.ts exactly (see test/analysis/mel.test.ts).

22050Hz mono, n_fft 1024, hop 256, periodic Hann, centred frames (zero padding), power spectrum,
64 HTK-mel triangular bands 30Hz–11025Hz (no area normalisation), log(mel + 1e-6),
then per-song standardisation (one scalar mean/std over the whole matrix).
"""
import sys
import numpy as np

SR, N_FFT, HOP, N_MELS, FMIN, FMAX = 22050, 1024, 256, 64, 30.0, 11025.0


def hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def mel_to_hz(m):
    return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def mel_filters() -> np.ndarray:
    pts = mel_to_hz(np.linspace(hz_to_mel(FMIN), hz_to_mel(FMAX), N_MELS + 2))
    freqs = np.arange(N_FFT // 2 + 1) * SR / N_FFT
    fb = np.zeros((N_MELS, len(freqs)))
    for m in range(N_MELS):
        lo, c, hi = pts[m], pts[m + 1], pts[m + 2]
        fb[m] = np.maximum(0.0, np.minimum((freqs - lo) / (c - lo), (hi - freqs) / (hi - c)))
    return fb


def log_mel(pcm: np.ndarray) -> np.ndarray:
    """pcm: float mono at 22050Hz → (N_MELS, frames) float32."""
    x = np.pad(pcm.astype(np.float64), (N_FFT // 2, N_FFT // 2))
    n_frames = 1 + len(pcm) // HOP
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = x[idx] * window
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    mel = np.log(power @ mel_filters().T + 1e-6).T
    return ((mel - mel.mean()) / (mel.std() + 1e-5)).astype(np.float32)


if __name__ == "__main__":
    # parity helper: features.py IN.f32 OUT.f32  (raw little-endian float32)
    pcm = np.fromfile(sys.argv[1], dtype="<f4")
    log_mel(pcm).astype("<f4").tofile(sys.argv[2])
