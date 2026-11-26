from __future__ import annotations

import hashlib
import importlib.util
import io
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def load_tts_kokoro():
    spec = importlib.util.spec_from_file_location("tts_kokoro", ROOT / "tools" / "demo-video" / "tts_kokoro.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def build_tar_bz2(out_path: Path, entries: list[tuple[str, str, bytes | str]]) -> str:
    """entries: list of (name, kind, payload) where kind in {'dir','file','symlink','hardlink','fifo'}."""
    with tarfile.open(out_path, "w:bz2") as tf:
        for name, kind, payload in entries:
            ti = tarfile.TarInfo(name=name)
            if kind == "dir":
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                tf.addfile(ti)
            elif kind == "file":
                data = payload if isinstance(payload, bytes) else payload.encode("utf-8")
                ti.type = tarfile.REGTYPE
                ti.size = len(data)
                ti.mode = 0o4755  # deliberately setuid+exec to verify chmod sanitization
                tf.addfile(ti, io.BytesIO(data))
            elif kind == "symlink":
                ti.type = tarfile.SYMTYPE
                ti.linkname = str(payload)
                tf.addfile(ti)
            elif kind == "hardlink":
                ti.type = tarfile.LNKTYPE
                ti.linkname = str(payload)
                tf.addfile(ti)
            elif kind == "fifo":
                ti.type = tarfile.FIFOTYPE
                tf.addfile(ti)
            else:
                raise ValueError(f"Unknown kind: {kind}")
    return hashlib.sha256(out_path.read_bytes()).hexdigest()


class DemoVideoPackagingAndKokoroTests(unittest.TestCase):
    def test_dockerignore_and_release_bundle_exclude_demo_video(self):
        rules = [
            line.strip()
            for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertTrue(
            any(r in ("tools/demo-video", "tools/demo-video/", "tools") for r in rules),
            ".dockerignore must exclude tools/demo-video",
        )
        self.assertFalse(
            any(r.startswith("!tools") for r in rules),
            ".dockerignore must not re-include tools/demo-video",
        )
        release_src = (ROOT / "ops" / "package-release.py").read_text(encoding="utf-8")
        self.assertNotIn("demo-video", release_src)
        self.assertNotIn('"tools"', release_src)
        self.assertNotIn("'tools'", release_src)

    def test_kokoro_models_pin_sha256_and_required_files(self):
        mod = load_tts_kokoro()
        for key in ("kokoro-multi-lang-v1_0", "kokoro-multi-lang-v1_1"):
            spec = mod.MODELS[key]
            digest = spec["sha256"]
            self.assertEqual(len(digest), 64)
            self.assertTrue(all(c in "0123456789abcdef" for c in digest))
            self.assertIn("model.onnx", spec["required_files"])
            self.assertIn("voices.bin", spec["required_files"])

    def test_ensure_model_rejects_sha256_mismatch_before_opening_archive(self):
        mod = load_tts_kokoro()
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp) / "cache"
            tampered_bytes = b"not even a valid bzip2 tar archive"

            def fake_dl(_url: str, dst: Path):
                dst.write_bytes(tampered_bytes)

            with mock.patch.dict(os.environ, {"DEMO_VIDEO_TTS_CACHE": str(cache_dir)}):
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    mod.ensure_model("kokoro-multi-lang-v1_0", downloader=fake_dl)

            self.assertFalse((cache_dir / "kokoro-multi-lang-v1_0").exists())

    def test_safe_extract_tar_rejects_symlinks_hardlinks_fifos_and_traversal(self):
        mod = load_tts_kokoro()
        bad_cases = [
            ("symlink", [("kokoro-multi-lang-v1_0/evil", "symlink", "/etc/passwd")]),
            (
                "hardlink",
                [
                    ("kokoro-multi-lang-v1_0/model.onnx", "file", b"ok"),
                    ("kokoro-multi-lang-v1_0/link", "hardlink", "kokoro-multi-lang-v1_0/model.onnx"),
                ],
            ),
            ("fifo", [("kokoro-multi-lang-v1_0/pipe", "fifo", "")]),
            ("traversal", [("kokoro-multi-lang-v1_0/../../escape.txt", "file", b"bad")]),
            ("dot_slash_traversal", [("./../escape.txt", "file", b"bad")]),
            ("wrong_top_dir", [("other-dir/model.onnx", "file", b"bad")]),
            ("absolute", [("/tmp/evil.txt", "file", b"bad")]),
        ]
        for label, entries in bad_cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                archive = tmp_path / "bad.tar.bz2"
                build_tar_bz2(archive, entries)
                with self.assertRaises(ValueError):
                    mod.safe_extract_tar(archive, tmp_path / "out", "kokoro-multi-lang-v1_0")

    def test_ensure_model_rejects_missing_voices_bin_without_promoting_cache(self):
        mod = load_tts_kokoro()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cache_dir = tmp_path / "cache"
            archive = tmp_path / "incomplete.tar.bz2"
            digest = build_tar_bz2(
                archive,
                [
                    ("kokoro-multi-lang-v1_0", "dir", ""),
                    ("kokoro-multi-lang-v1_0/model.onnx", "file", b"onnx-bytes"),
                    ("kokoro-multi-lang-v1_0/tokens.txt", "file", b"tok"),
                ],
            )
            fake_models = {
                "kokoro-multi-lang-v1_0": {
                    **mod.MODELS["kokoro-multi-lang-v1_0"],
                    "sha256": digest,
                }
            }

            def fake_dl(_url: str, dst: Path):
                dst.write_bytes(archive.read_bytes())

            with mock.patch.dict(os.environ, {"DEMO_VIDEO_TTS_CACHE": str(cache_dir)}), mock.patch.object(
                mod, "MODELS", fake_models
            ):
                with self.assertRaisesRegex(RuntimeError, "voices.bin"):
                    mod.ensure_model("kokoro-multi-lang-v1_0", downloader=fake_dl)

            self.assertFalse((cache_dir / "kokoro-multi-lang-v1_0").exists())

    def test_ensure_model_verifies_extracts_sanitizes_modes_and_caches(self):
        mod = load_tts_kokoro()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cache_dir = tmp_path / "cache"
            archive = tmp_path / "good.tar.bz2"
            digest = build_tar_bz2(
                archive,
                [
                    ("kokoro-multi-lang-v1_0", "dir", ""),
                    ("kokoro-multi-lang-v1_0/model.onnx", "file", b"onnx-payload"),
                    ("kokoro-multi-lang-v1_0/voices.bin", "file", b"voices-payload"),
                    ("kokoro-multi-lang-v1_0/tokens.txt", "file", b"tokens-payload"),
                ],
            )
            fake_models = {
                "kokoro-multi-lang-v1_0": {
                    **mod.MODELS["kokoro-multi-lang-v1_0"],
                    "sha256": digest,
                }
            }
            downloads = 0

            def fake_dl(_url: str, dst: Path):
                nonlocal downloads
                downloads += 1
                dst.write_bytes(archive.read_bytes())

            with mock.patch.dict(os.environ, {"DEMO_VIDEO_TTS_CACHE": str(cache_dir)}), mock.patch.object(
                mod, "MODELS", fake_models
            ):
                model_dir = mod.ensure_model("kokoro-multi-lang-v1_0", downloader=fake_dl)
                self.assertEqual(downloads, 1)
                self.assertEqual((model_dir / "model.onnx").read_bytes(), b"onnx-payload")
                self.assertEqual((model_dir / "voices.bin").read_bytes(), b"voices-payload")
                # Mode must be sanitized to 0o644 (no setuid or exec bits)
                mode = stat.S_IMODE((model_dir / "model.onnx").stat().st_mode)
                self.assertEqual(mode, 0o644)

                # Second call must hit cache without downloading again
                model_dir_2 = mod.ensure_model("kokoro-multi-lang-v1_0", downloader=fake_dl)
                self.assertEqual(model_dir_2, model_dir)
                self.assertEqual(downloads, 1)


if __name__ == "__main__":
    unittest.main()
