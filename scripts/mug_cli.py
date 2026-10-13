"""Headless MuG Diffusion: audio → 4K osu!mania charts, one per requested star rating.

Adapted from webui.py (MIT) without the Gradio UI.
Usage: python mug_cli.py --out DIR --sr 1.5 2.2 3.2 --names easy normal hard [--ln 0.15] [--steps 50] -- AUDIO
"""
import argparse, json, os, random, subprocess, sys, tempfile, time

import numpy as np
import torch
import yaml
from omegaconf import OmegaConf

from mug.data.convertor import save_osu_file, parse_osu_file
from mug.data.utils import gridify, remove_intractable_mania_mini_jacks
from mug.diffusion.ddim import DDIMSampler
from mug.util import feature_dict_to_embedding_ids, load_audio_without_cache, instantiate_from_config

HERE = os.environ.get("MUG_DIR") or os.path.dirname(os.path.abspath(__file__))


def log(**kw):
    print(json.dumps(kw), flush=True)


def load_model(device):
    config = OmegaConf.load(os.path.join(HERE, "models/ckpt/model.yaml"))
    # the checkpoint only holds tensors + a few numpy scalars (scanned); allow exactly those
    from numpy._core.multiarray import scalar
    torch.serialization.add_safe_globals([(scalar, "numpy.core.multiarray.scalar"), np.dtype, type(np.dtype("float64"))])
    sd = torch.load(os.path.join(HERE, "models/ckpt/model.ckpt"), map_location="cpu", weights_only=True)["state_dict"]
    model = instantiate_from_config(config.model)
    model.load_state_dict(sd, strict=False)
    model.eval().to(device)
    return config, model


def condition(model, feature_yaml, feature_dict):
    ids = np.asarray([feature_dict_to_embedding_ids(feature_dict, feature_yaml)])
    return model.model.cond_stage_model(torch.tensor(ids, dtype=torch.float32, device=model.device))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", required=True)
    ap.add_argument("--names", nargs="+")
    ap.add_argument("--sr", type=float, nargs="+", default=[2.5, 4.0, 5.5])
    ap.add_argument("--ln", type=float, default=0.15)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--scale", type=float, default=5.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--jack-ms", type=float, default=90)
    ap.add_argument("--cpu", action="store_true")
    a = ap.parse_args()
    a.audio = os.path.abspath(a.audio)
    a.out = os.path.abspath(a.out)

    device = torch.device("cpu" if a.cpu or not torch.cuda.is_available() else "cuda")
    t0 = time.time()
    os.chdir(HERE)  # the code base uses relative paths for configs/templates
    config, model = load_model(device)
    log(stage="loaded", device=str(device), seconds=round(time.time() - t0, 1))

    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed); torch.cuda.manual_seed_all(a.seed)
    feature_yaml = yaml.safe_load(open("configs/mug/mania_beatmap_features.yaml"))
    ds = config.data.params.common_params
    frame_s = (ds.n_fft // 4) / ds.sr

    with torch.no_grad():
        # audioread cannot open every container (e.g. webm/opus); hand it a plain wav
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, "in.wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.audio, "-ac", "1", "-ar", str(ds.sr), wav], check=True)
            audio = load_audio_without_cache(wav, ds.n_mels, ds.n_fft // 4, ds.n_fft, ds.sr, None)
        t = audio.shape[1]
        ratio = ds.max_audio_frame // model.z_length
        map_len = (int(t / ratio / 32) + 1) * 32
        ds.max_audio_frame = map_len * ratio
        model.z_length = map_len
        audio = np.concatenate([audio, np.zeros((ds.n_mels, ds.max_audio_frame - t), dtype=np.float32)], axis=1) \
            if t < ds.max_audio_frame else audio[:, :ds.max_audio_frame]
        w = model.model.wave_model(torch.tensor(audio[None], dtype=torch.float32, device=model.device))
        sampler = DDIMSampler(model, device)
        uc = condition(model, feature_yaml, {}) if a.scale != 1.0 else None

        conv = {"frame_ms": frame_s * ds.audio_note_window_ratio * 1000,
                "max_frame": ds.max_audio_frame // ds.audio_note_window_ratio, "from_logits": True}
        _, meta = parse_osu_file("asset/template.osu", conv)

        def snap(hit_objects):
            # MuG's own tempo guess can be off by 4:3 etc.; leave timing unsnapped, the game snaps to its beat grid
            _, bpm, offset = gridify(hit_objects, verbose=False)
            return bpm, offset, remove_intractable_mania_mini_jacks(hit_objects, verbose=False, jack_interval=a.jack_ms)

        os.makedirs(a.out, exist_ok=True)
        for i, sr in enumerate(a.sr):
            feats = {"rank_status": "ranked", "sr": sr, "ln_ratio": a.ln}
            c = condition(model, feature_yaml, feats)
            t1 = time.time()
            z, _ = sampler.sample(S=a.steps, c=c, w=w, batch_size=1, shape=None, verbose=False,
                                  unconditional_guidance_scale=a.scale, unconditional_conditioning=uc, eta=0.0)
            x = model.model.decode(z).cpu().numpy()[0]
            path = os.path.join(a.out, f"{a.names[i] if a.names else i}.osu")
            save_osu_file(meta, x, path=path, override={
                "Creator": "MuG Diffusion", "Version": f"sr{sr}", "AudioFilename": "audio",
                "Title": "t", "TitleUnicode": "t", "Artist": "a", "ArtistUnicode": "a",
                "AIMode": "MuG Diffusion v1.0.0", "AIPrompt": json.dumps(feats)}, gridify=snap)
            log(stage="chart", index=i, total=len(a.sr), sr=sr, path=path, seconds=round(time.time() - t1, 1))
    log(stage="done", seconds=round(time.time() - t0, 1))


if __name__ == "__main__":
    main()
