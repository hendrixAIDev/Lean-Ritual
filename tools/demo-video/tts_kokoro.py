#!/usr/bin/env python3
"""Local open-source neural TTS synthesis using Kokoro-82M via sherpa-onnx (Apache-2.0).

Run via:
  uv run --python 3.11 --with "sherpa-onnx<2" --with soundfile python tools/demo-video/tts_kokoro.py <job.json>

Downloads, SHA-256 verifies, and caches official Sherpa-ONNX Kokoro model tarballs into
~/.cache/lean-ritual-demo-video/tts (override with DEMO_VIDEO_TTS_CACHE).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

TARGET_SR = 48000
REQUIRED_MODEL_FILES = ("model.onnx", "voices.bin", "tokens.txt")

MODELS = {
    "kokoro-multi-lang-v1_0": {
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        "sha256": "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
        "dir_name": "kokoro-multi-lang-v1_0",
        "required_files": REQUIRED_MODEL_FILES,
        "license": "Apache-2.0",
    },
    "kokoro-multi-lang-v1_1": {
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
        "sha256": "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed",
        "dir_name": "kokoro-multi-lang-v1_1",
        "required_files": REQUIRED_MODEL_FILES,
        "license": "Apache-2.0",
    },
}


def get_cache_dir() -> Path:
    override = os.environ.get("DEMO_VIDEO_TTS_CACHE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "lean-ritual-demo-video" / "tts"


def sha256_file(file_path: Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def verify_archive_sha256(archive_path: Path, expected_sha256: str) -> None:
    expected = (expected_sha256 or "").strip().lower()
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise ValueError("Pinned SHA-256 digest must be a 64-character hex string")
    actual = sha256_file(archive_path).lower()
    if not hmac.compare_digest(actual, expected):
        raise ValueError(
            f"Kokoro archive SHA-256 mismatch for {archive_path.name}: expected {expected}, got {actual}"
        )


def _validated_member_relpath(raw_name: str, expected_top_dir: str) -> PurePosixPath:
    if not raw_name or "\x00" in raw_name:
        raise ValueError(f"Unsafe archive member name: {raw_name!r}")
    if "\\" in raw_name:
        raise ValueError(f"Unsafe archive path separator: {raw_name!r}")
    norm = raw_name.removeprefix("./")
    if not norm or norm.startswith("/") or norm.startswith("./"):
        raise ValueError(f"Unsafe archive path: {raw_name!r}")
    rel = PurePosixPath(norm)
    parts = rel.parts
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise ValueError(f"Unsafe archive path component: {raw_name!r}")
    if parts[0] != expected_top_dir:
        raise ValueError(
            f"Archive member escapes expected directory {expected_top_dir!r}: {raw_name!r}"
        )
    return rel


def safe_extract_tar(archive_path: Path, dest_dir: Path, expected_top_dir: str, mode: str = "r:bz2") -> Path:
    dest_root = dest_dir.resolve()
    expected_root = (dest_root / expected_top_dir).resolve()
    if not expected_root.is_relative_to(dest_root):
        raise ValueError(f"Invalid target directory: {expected_top_dir!r}")

    with tarfile.open(str(archive_path), mode) as tf:
        members = tf.getmembers()
        validated = []
        for member in members:
            # Accept ONLY regular files and directories (blocks symlinks, hardlinks, FIFOs, devices).
            if not (member.isreg() or member.isdir()):
                raise ValueError(f"Unsupported archive member type ({member.type!r}): {member.name}")
            rel = _validated_member_relpath(member.name, expected_top_dir)
            target = (dest_root / Path(*rel.parts)).resolve()
            if target != expected_root and not target.is_relative_to(expected_root):
                raise ValueError(f"Unsafe archive path: {member.name}")
            validated.append((member, target))

        # Extract explicitly without tarfile.extractall() so member types, permissions, and links are strictly controlled.
        for member, target in validated:
            if member.isdir():
                if target.is_symlink():
                    raise ValueError(f"Refusing to traverse symlink directory: {target}")
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and target.is_symlink():
                    raise ValueError(f"Refusing to overwrite symlink: {target}")
                src = tf.extractfile(member)
                if src is None:
                    raise ValueError(f"Unable to read regular archive member: {member.name}")
                with src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(target, 0o644)

    return expected_root


def has_valid_model_dir(model_dir: Path, required_files: tuple[str, ...] = REQUIRED_MODEL_FILES) -> bool:
    if not model_dir.is_dir() or model_dir.is_symlink():
        return False
    for name in required_files:
        p = model_dir / name
        if p.is_symlink() or not p.is_file() or p.stat().st_size <= 0:
            return False
    return True


def validate_model_dir(model_dir: Path, required_files: tuple[str, ...] = REQUIRED_MODEL_FILES) -> None:
    missing = []
    for name in required_files:
        p = model_dir / name
        if p.is_symlink() or not p.is_file() or p.stat().st_size <= 0:
            missing.append(name)
    if missing:
        raise RuntimeError(
            f"Extracted Kokoro archive missing required model files in {model_dir.name}: {', '.join(missing)}"
        )


def ensure_model(model_key: str, *, downloader=None) -> Path:
    if model_key not in MODELS:
        raise ValueError(f"Unknown Kokoro model key: {model_key}")
    spec = MODELS[model_key]
    required_files = tuple(spec.get("required_files", REQUIRED_MODEL_FILES))
    cache_dir = get_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_dir = cache_dir / spec["dir_name"]
    if has_valid_model_dir(model_dir, required_files):
        return model_dir

    print(f"[tts_kokoro] Downloading {model_key} from {spec['url']} ...", file=sys.stderr, flush=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="kokoro-dl-", dir=str(cache_dir)))
    archive_path = tmp_dir / f"{model_key}.tar.bz2"
    try:
        if downloader is not None:
            downloader(spec["url"], archive_path)
        else:
            urllib.request.urlretrieve(spec["url"], str(archive_path))
        verify_archive_sha256(archive_path, spec["sha256"])
        extracted = safe_extract_tar(archive_path, tmp_dir, spec["dir_name"])
        validate_model_dir(extracted, required_files)
        if model_dir.exists():
            shutil.rmtree(model_dir)
        shutil.move(str(extracted), str(model_dir))
        return model_dir
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def trim_silence(samples, sr: int, thresh_db: float = -45.0, pad_ms: float = 45.0):
    import numpy as np

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


def resample_exact(samples, src_sr: int, dst_sr: int):
    import numpy as np

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


def build_tts(model_dir: Path, lang: str):
    import sherpa_onnx

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
    import numpy as np
    import soundfile as sf

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
