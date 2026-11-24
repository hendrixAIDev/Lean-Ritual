#!/usr/bin/env python3
"""Local open-source neural TTS synthesis using Kokoro-82M via sherpa-onnx (Apache-2.0).

Run via:
  uv run --python 3.11 --with "sherpa-onnx<2" --with soundfile python tools/demo-video/tts_kokoro.py <job.json>

Downloads and caches official Sherpa-ONNX Kokoro model tarballs into
~/.cache/lean-ritual-demo-video/tts (override with DEMO_VIDEO_TTS_CACHE).
"""

import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

TARGET_SR = 48000

MODELS = {
    "kokoro-multi-lang-v1_0": {
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        "dir_name": "kokoro-multi-lang-v1_0",
        "license": "Apache-2.0",
    },
    "kokoro-multi-lang-v1_1": {
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
        "dir_name": "kokoro-multi-lang-v1_1",
        "license": "Apache-2.0",
    },
}


def get_cache_dir() -> Path:
    override = os.environ.get("DEMO_VIDEO_TTS_CACHE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "lean-ritual-demo-video" / "tts"


def ensure_model(model_key: str) -> Path:
    if model_key not in MODELS:
        raise ValueError(f"Unknown Kokoro model key: {model_key}")
    spec = MODELS[model_key]
    cache_dir = get_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_dir = cache_dir / spec["dir_name"]
    if (model_dir / "model.onnx").is_file() and (model_dir / "voices.bin").is_file():
        return model_dir

    print(f"[tts_kokoro] Downloading {model_key} from {spec['url']} ...", file=sys.stderr, flush=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="kokoro-dl-", dir=str(cache_dir)))
    archive_path = tmp_dir / f"{model_key}.tar.bz2"
    try:
        urllib.request.urlretrieve(spec["url"], str(archive_path))
        with tarfile.open(str(archive_path), "r:bz2") as tf:
            # Guard against path traversal and unsafe links in archive members
            tmp_root = tmp_dir.resolve()
            for member in tf.getmembers():
                if member.issym() or member.islnk():
                    raise ValueError(f"Unsafe link in archive: {member.name}")
                resolved = (tmp_dir / member.name).resolve()
                if not resolved.is_relative_to(tmp_root):
                    raise ValueError(f"Unsafe archive path: {member.name}")
            tf.extractall(path=str(tmp_dir))
        extracted = tmp_dir / spec["dir_name"]
        if not (extracted / "model.onnx").is_file():
            raise RuntimeError(f"Extracted archive missing {spec['dir_name']}/model.onnx")
        if model_dir.exists():
            shutil.rmtree(model_dir)
        shutil.move(str(extracted), str(model_dir))
        return model_dir
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def trim_silence(samples: np.ndarray, sr: int, thresh_db: float = -45.0, pad_ms: float = 45.0) -> np.ndarray:
    if len(samples) == 0:
        return samples
    thresh = 10.0 ** (thresh_db / 20.0)
    idx = np.where(np.abs(samples) > thresh)[0]
    if len(idx) == 0:
        return samples
    pad = int(sr * pad_ms / 1000.0)
    start = max(0, int(idx[0]) - pad)
    end = min(len(samples), int(idx[-1]) + pad)
    return samples[start:end]


def resample_exact(samples: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr or len(samples) == 0:
        return samples.astype(np.float64)
    n_src = len(samples)
    n_dst = int(round(n_src * (dst_sr / float(src_sr))))
    spec = np.fft.rfft(samples.astype(np.float64))
    out_spec = np.zeros(n_dst // 2 + 1, dtype=np.complex128)
    copy_len = min(len(spec), len(out_spec))
    out_spec[:copy_len] = spec[:copy_len]
    out = np.fft.irfft(out_spec, n=n_dst) * (n_dst / float(n_src))
    return out


def build_tts(model_dir: Path, lang: str) -> sherpa_onnx.OfflineTts:
    lexicons = []
    us_lex = model_dir / "lexicon-us-en.txt"
    zh_lex = model_dir / "lexicon-zh.txt"
    if us_lex.is_file():
        lexicons.append(str(us_lex))
    if zh_lex.is_file():
        lexicons.append(str(zh_lex))

    rule_fsts = ""
    if lang == "zh":
        fsts = [model_dir / f for f in ("date-zh.fst", "number-zh.fst", "phone-zh.fst") if (model_dir / f).is_file()]
        rule_fsts = ",".join(str(p) for p in fsts)

    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(model_dir / "model.onnx"),
                voices=str(model_dir / "voices.bin"),
                tokens=str(model_dir / "tokens.txt"),
                data_dir=str(model_dir / "espeak-ng-data"),
                dict_dir=str(model_dir / "dict"),
                lexicon=",".join(lexicons),
            ),
            num_threads=min(4, os.cpu_count() or 2),
            provider="cpu",
        ),
        rule_fsts=rule_fsts,
        max_num_sentences=1,
    )
    return sherpa_onnx.OfflineTts(cfg)


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: tts_kokoro.py <job.json>", file=sys.stderr)
        sys.exit(2)

    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    lang = job["lang"]
    model_key = job["model"]
    sid = int(job["sid"])
    speed = float(job.get("speed", 1.0))
    items = job["items"]

    model_dir = ensure_model(model_key)
    tts = build_tts(model_dir, lang)

    results = {}
    for item in items:
        cid = item["id"]
        text = item["text"]
        out_wav = item["outWav"]
        item_speed = float(item.get("speed", speed))
        audio = tts.generate(text, sid=sid, speed=item_speed)
        raw = np.asarray(audio.samples, dtype=np.float64)
        trimmed = trim_silence(raw, audio.sample_rate)
        # Gentle 12ms micro-fade at edges to guarantee zero clicks
        fade_n = min(int(audio.sample_rate * 0.012), len(trimmed) // 4)
        if fade_n > 1:
            trimmed[:fade_n] *= np.linspace(0.0, 1.0, fade_n)
            trimmed[-fade_n:] *= np.linspace(1.0, 0.0, fade_n)
        resampled = resample_exact(trimmed, audio.sample_rate, TARGET_SR)
        peak = float(np.max(np.abs(resampled))) if len(resampled) else 1.0
        if peak > 1e-6:
            # Normalize to -1.5 dBFS peak (~0.84) for consistent loudness across lines
            resampled = resampled * (0.84 / peak)
        stereo = np.stack([resampled, resampled], axis=1).astype(np.float32)
        Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
        sf.write(out_wav, stereo, TARGET_SR, subtype="PCM_16")
        results[cid] = {
            "wav": out_wav,
            "duration": round(len(resampled) / float(TARGET_SR), 4),
            "sampleRate": TARGET_SR,
        }

    print(json.dumps({"model": model_key, "sid": sid, "items": results}))


if __name__ == "__main__":
    main()
