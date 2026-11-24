#!/usr/bin/env python3
"""Procedural studio background music bed and subtle UI sound effects (CC0 / original).

Run via:
  uv run --python 3.11 --with numpy --with soundfile python tools/demo-video/sound_design.py <duration_sec> <out_dir>

Generates 48kHz stereo 16-bit PCM WAV files:
  - bgm.wav        (warm Rhodes + ambient pad + kalimba + soft groove, tailored to duration)
  - sfx_tap.wav    (clean subtle tactile UI tap)
  - sfx_swoosh.wav (silky stereo transition whoosh)
  - sfx_chime.wav  (warm two-note marimba/glass confirmation chime)
  - sfx_pop.wav    (soft subtle callout pop)
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000


def midi_to_hz(m: float) -> float:
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def fft_lp(x: np.ndarray, cutoff_hz: float) -> np.ndarray:
    n = len(x)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    h = 1.0 / np.sqrt(1.0 + (freqs / max(cutoff_hz, 1.0)) ** 4)
    return np.fft.irfft(np.fft.rfft(x) * h, n=n)


def fft_hp(x: np.ndarray, cutoff_hz: float) -> np.ndarray:
    n = len(x)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    h = 1.0 / np.sqrt(1.0 + (max(cutoff_hz, 1.0) / np.maximum(freqs, 1e-6)) ** 4)
    h[0] = 0.0
    return np.fft.irfft(np.fft.rfft(x) * h, n=n)


def vocal_pocket_eq(stereo: np.ndarray) -> np.ndarray:
    # Carve a gentle -3.5 dB pocket around 2.4 kHz and soften highs >7.5 kHz so narration sits cleanly in front.
    n = stereo.shape[0]
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    bell = np.exp(-0.5 * ((np.log2(np.maximum(freqs, 20.0) / 2400.0)) / 0.78) ** 2)
    gain = 10.0 ** (-3.5 * bell / 20.0)
    hi = 1.0 / np.sqrt(1.0 + (freqs / 7400.0) ** 2)
    curve = gain * hi
    out = np.zeros_like(stereo)
    for ch in range(2):
        out[:, ch] = np.fft.irfft(np.fft.rfft(stereo[:, ch]) * curve, n=n)
    return out


def stereo_reverb(stereo: np.ndarray, wet: float = 0.25, decay: float = 1.4, seed: int = 42) -> np.ndarray:
    rng = np.random.default_rng(seed)
    ir_len = int(SR * decay)
    t = np.arange(ir_len) / SR
    env = np.exp(-t * (5.5 / decay))
    pre = int(SR * 0.018)
    out = np.zeros_like(stereo)
    n_conv = stereo.shape[0] + ir_len - 1
    n_fft = 1 << (n_conv - 1).bit_length()
    for ch in range(2):
        ir = np.zeros(ir_len)
        ir[pre:] = rng.standard_normal(ir_len - pre) * env[: ir_len - pre]
        ir = fft_lp(fft_hp(ir, 180.0), 3400.0)
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        wet_sig = np.fft.irfft(
            np.fft.rfft(stereo[:, ch], n_fft) * np.fft.rfft(ir, n_fft), n_fft
        )[: stereo.shape[0]]
        out[:, ch] = stereo[:, ch] * (1.0 - wet * 0.38) + wet_sig * wet
    return out


def rhodes_note(midi: float, dur_s: float, vel: float = 0.7) -> np.ndarray:
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    f = midi_to_hz(midi)
    atk = np.minimum(1.0, t / 0.012)
    rel_len = min(int(SR * 0.14), n // 3)
    rel = np.ones(n)
    if rel_len > 0:
        rel[-rel_len:] = np.linspace(1.0, 0.0, rel_len) ** 1.5
    body_env = np.exp(-t * 1.45) * atk * rel
    tine_env = np.exp(-t * 9.5) * atk * rel
    mod = 0.20 * np.exp(-t * 7.0) * np.sin(2.0 * np.pi * f * t)
    sig = (
        0.78 * np.sin(2.0 * np.pi * f * t + mod) * body_env
        + 0.22 * np.sin(2.0 * np.pi * 2.0 * f * t) * np.exp(-t * 2.8) * atk * rel
        + 0.085 * np.sin(2.0 * np.pi * 3.0 * f * t) * tine_env
        + 0.035 * np.sin(2.0 * np.pi * 7.0 * f * t) * np.exp(-t * 18.0) * atk * rel
    )
    return sig * vel


def kalimba_note(midi: float, dur_s: float, vel: float = 0.5) -> np.ndarray:
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    f = midi_to_hz(midi)
    atk = np.minimum(1.0, t / 0.004)
    sig = (
        0.82 * np.sin(2.0 * np.pi * f * t) * np.exp(-t * 5.2)
        + 0.15 * np.sin(2.0 * np.pi * 2.98 * f * t) * np.exp(-t * 16.0)
        + 0.05 * np.sin(2.0 * np.pi * 2.0 * f * t) * np.exp(-t * 9.0)
    ) * atk
    return sig * vel


def synth_pad_chord(midis, dur_s: float, vel: float = 0.20) -> np.ndarray:
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    fade_in = min(int(SR * 0.45), n // 3)
    fade_out = min(int(SR * 0.55), n // 3)
    env = np.ones(n)
    env[:fade_in] = 0.5 - 0.5 * np.cos(np.pi * np.arange(fade_in) / fade_in)
    env[-fade_out:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(fade_out) / fade_out)
    left = np.zeros(n)
    right = np.zeros(n)
    for idx, m in enumerate(midis):
        f = midi_to_hz(m)
        s1 = np.sin(2.0 * np.pi * (f * 0.9985) * t) + 0.16 * np.sin(2.0 * np.pi * (f * 1.997) * t)
        s2 = np.sin(2.0 * np.pi * (f * 1.0015) * t) + 0.16 * np.sin(2.0 * np.pi * (f * 2.003) * t)
        pan = 0.3 + 0.4 * (idx / max(1, len(midis) - 1))
        left += s1 * (1.0 - pan) + s2 * pan * 0.5
        right += s2 * pan + s1 * (1.0 - pan) * 0.5
    left = fft_lp(left, 1050.0) * env * (vel / len(midis))
    right = fft_lp(right, 1050.0) * env * (vel / len(midis))
    return np.stack([left, right], axis=1)


def soft_kick() -> np.ndarray:
    n = int(SR * 0.18)
    t = np.arange(n) / SR
    freq = 44.0 + 76.0 * np.exp(-t * 36.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    env = np.exp(-t * 17.5) * np.minimum(1.0, t / 0.003)
    return np.sin(phase) * env * 0.40


def soft_hat(rng: np.random.Generator, accent: float = 1.0) -> np.ndarray:
    n = int(SR * 0.048)
    t = np.arange(n) / SR
    noise = fft_hp(fft_lp(rng.standard_normal(n), 10200.0), 5600.0)
    env = np.exp(-t * 72.0) * np.minimum(1.0, t / 0.002)
    return noise * env * 0.052 * accent


def soft_rim(rng: np.random.Generator) -> np.ndarray:
    n = int(SR * 0.065)
    t = np.arange(n) / SR
    tone = np.sin(2.0 * np.pi * 640.0 * t) * np.exp(-t * 68.0)
    click = fft_lp(fft_hp(rng.standard_normal(n), 1400.0), 4200.0) * np.exp(-t * 95.0)
    return (tone * 0.5 + click * 0.65) * 0.15


def add_mono(buf: np.ndarray, start_s: float, sig: np.ndarray, pan: float = 0.5) -> None:
    i0 = int(start_s * SR)
    if i0 < 0 or i0 >= buf.shape[0]:
        return
    i1 = min(buf.shape[0], i0 + len(sig))
    s = sig[: i1 - i0]
    buf[i0:i1, 0] += s * math.cos(pan * math.pi / 2.0)
    buf[i0:i1, 1] += s * math.sin(pan * math.pi / 2.0)


def add_stereo(buf: np.ndarray, start_s: float, sig: np.ndarray) -> None:
    i0 = int(start_s * SR)
    if i0 < 0 or i0 >= buf.shape[0]:
        return
    i1 = min(buf.shape[0], i0 + sig.shape[0])
    buf[i0:i1] += sig[: i1 - i0]


def generate_bgm(duration_s: float, out_wav: Path) -> None:
    rng = np.random.default_rng(20261120)
    bpm = 102.0
    beat = 60.0 / bpm
    bar = beat * 4.0
    total_n = int(SR * (duration_s + 0.6))
    buf = np.zeros((total_n, 2), dtype=np.float64)

    # Section A: Fmaj9 -> G6/9 -> Em7 -> Am9
    prog_a = [
        {"bass": 41, "chord": [53, 57, 60, 64, 67], "arp": [72, 76, 79, 76]},
        {"bass": 43, "chord": [55, 59, 62, 64, 69], "arp": [74, 76, 79, 81]},
        {"bass": 40, "chord": [52, 55, 59, 62, 67], "arp": [71, 74, 79, 76]},
        {"bass": 45, "chord": [57, 60, 64, 67, 71], "arp": [72, 76, 79, 83]},
    ]
    # Section B (mid-video harmonic lift): Dm9 -> G13 -> Cmaj9 -> Am9
    prog_b = [
        {"bass": 38, "chord": [50, 57, 60, 64, 69], "arp": [74, 76, 79, 81]},
        {"bass": 43, "chord": [55, 59, 64, 65, 69], "arp": [74, 79, 81, 79]},
        {"bass": 48, "chord": [52, 55, 59, 62, 67], "arp": [76, 79, 83, 79]},
        {"bass": 45, "chord": [57, 60, 64, 67, 71], "arp": [72, 76, 81, 79]},
    ]

    kick = soft_kick()
    rim = soft_rim(rng)

    num_bars = int(math.ceil(duration_s / bar))
    for b in range(num_bars):
        t0 = b * bar
        if t0 >= duration_s - 2.6:
            break
        is_intro = b < 2
        is_outro = t0 > duration_s - 6.0
        # Alternate between A (8 bars) and B (8 bars) after 2-bar intro for natural arc
        cycle_idx = max(0, b - 2) % 16
        use_b = (not is_intro) and (cycle_idx >= 8)
        spec = (prog_b if use_b else prog_a)[b % 4]

        # Ambient warm pad
        add_stereo(buf, t0, synth_pad_chord(spec["chord"][:4], bar + 0.35, vel=0.17 if is_intro else 0.21))

        # Rhodes rolled chord on beat 1 + gentle syncopation on beat 2.5
        for j, m in enumerate(spec["chord"]):
            pan = 0.25 + 0.5 * (j / max(1, len(spec["chord"]) - 1))
            add_mono(buf, t0 + j * 0.024, rhodes_note(m, beat * 2.6, vel=0.13), pan=pan)
        if not is_intro:
            for j, m in enumerate(spec["chord"][1:]):
                pan = 0.30 + 0.45 * (j / 3.0)
                add_mono(buf, t0 + beat * 2.5 + j * 0.018, rhodes_note(m, beat * 1.4, vel=0.085), pan=pan)

        # Warm sub-bass
        if not is_intro:
            f_bass = midi_to_hz(spec["bass"])
            for bt, d_b, v_b in [(0.0, beat * 2.2, 0.21), (2.5, beat * 1.2, 0.13)]:
                n_b = int(SR * d_b)
                tb = np.arange(n_b) / SR
                env_b = np.minimum(1.0, tb / 0.02) * np.exp(-tb * 1.4)
                bass_sig = (
                    np.sin(2.0 * np.pi * f_bass * tb) + 0.16 * np.sin(2.0 * np.pi * 2.0 * f_bass * tb)
                ) * env_b * v_b
                add_mono(buf, t0 + bt * beat, bass_sig, pan=0.5)

        # Delicate kalimba motif (slight octave sparkle in Section B)
        if not is_outro:
            arp_offsets = [0.5, 1.5, 2.75, 3.5]
            for k, off in enumerate(arp_offsets):
                if is_intro and k % 2 == 1:
                    continue
                m = spec["arp"][k % len(spec["arp"])]
                pan = 0.30 if k % 2 == 0 else 0.70
                vel = 0.09 if use_b else 0.075
                add_mono(buf, t0 + off * beat, kalimba_note(m, 0.65, vel=vel), pan=pan)

        # Soft modern lo-fi groove
        if not is_intro and not is_outro:
            add_mono(buf, t0 + 0.0 * beat, kick, pan=0.5)
            add_mono(buf, t0 + 2.5 * beat, kick * 0.76, pan=0.5)
            add_mono(buf, t0 + 1.0 * beat, rim, pan=0.56)
            add_mono(buf, t0 + 3.0 * beat, rim * 0.85, pan=0.44)
            for s in range(8):
                swing = 0.015 if (s % 2 == 1) else 0.0
                acc = 1.0 if (s % 2 == 0) else 0.55
                add_mono(
                    buf,
                    t0 + s * (beat * 0.5) + swing,
                    soft_hat(rng, acc),
                    pan=0.62 if (s % 2) else 0.42,
                )

    # Final warm resolve chord (Cmaj9) landing softly on the outro card
    end_t = max(0.0, duration_s - 3.6)
    add_stereo(buf, end_t, synth_pad_chord([48, 55, 60, 64, 67], 3.5, vel=0.19))
    for j, m in enumerate([48, 55, 60, 64, 67, 71, 74]):
        pan = 0.22 + 0.56 * (j / 6.0)
        add_mono(buf, end_t + j * 0.032, rhodes_note(m, 3.5, vel=0.115), pan=pan)

    buf = buf[: int(SR * duration_s)]
    buf = stereo_reverb(buf, wet=0.26, decay=1.45, seed=42)
    buf = vocal_pocket_eq(buf)

    # Smooth fade-in and fade-out
    fi = min(int(SR * 0.85), buf.shape[0] // 4)
    fo = min(int(SR * 2.4), buf.shape[0] // 3)
    buf[:fi] *= np.linspace(0.0, 1.0, fi)[:, None] ** 1.2
    buf[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None] ** 1.65

    peak = float(np.max(np.abs(buf))) + 1e-9
    buf = buf * (0.72 / peak)
    sf.write(str(out_wav), buf.astype(np.float32), SR, subtype="PCM_16")


def generate_sfx(out_dir: Path) -> dict:
    rng = np.random.default_rng(77)
    paths = {}

    # 1. Tactile soft UI tap
    n = int(SR * 0.045)
    t = np.arange(n) / SR
    f = 420.0 + 580.0 * np.exp(-t * 140.0)
    ph = 2.0 * np.pi * np.cumsum(f) / SR
    tap = np.sin(ph) * np.exp(-t * 115.0) * np.minimum(1.0, t / 0.0015)
    click = fft_lp(fft_hp(rng.standard_normal(n), 1800.0), 5500.0) * np.exp(-t * 280.0) * 0.28
    tap_sig = (tap * 0.85 + click) * 0.45
    tap_path = out_dir / "sfx_tap.wav"
    sf.write(str(tap_path), np.stack([tap_sig, tap_sig], axis=1).astype(np.float32), SR, subtype="PCM_16")
    paths["tap"] = str(tap_path)

    # 2. Silky transition swoosh (0.42s)
    dur = 0.42
    n = int(SR * dur)
    t = np.arange(n) / SR
    white = rng.standard_normal(n)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    pink = np.fft.irfft(np.fft.rfft(white) / np.maximum(np.sqrt(freqs), 1.0), n=n)
    low_band = fft_lp(fft_hp(pink, 220.0), 750.0)
    mid_band = fft_lp(fft_hp(pink, 650.0), 2200.0)
    env = np.sin(np.pi * t / dur) ** 1.8
    mid_mix = np.sin(np.pi * t / dur) ** 2.6
    sw = (low_band * (1.0 - 0.5 * mid_mix) + mid_band * 1.4 * mid_mix) * env
    sw /= float(np.max(np.abs(sw))) + 1e-9
    pan_l = np.cos((0.25 + 0.5 * t / dur) * math.pi / 2.0)
    pan_r = np.sin((0.25 + 0.5 * t / dur) * math.pi / 2.0)
    swoosh_path = out_dir / "sfx_swoosh.wav"
    sf.write(
        str(swoosh_path),
        np.stack([sw * pan_l * 0.30, sw * pan_r * 0.30], axis=1).astype(np.float32),
        SR,
        subtype="PCM_16",
    )
    paths["swoosh"] = str(swoosh_path)

    # 3. Warm two-note confirmation chime (G5 -> C6)
    dur = 0.72
    n = int(SR * dur)
    buf = np.zeros((n, 2), dtype=np.float64)
    add_mono(buf, 0.00, kalimba_note(79, 0.45, vel=0.36), pan=0.42)
    add_mono(buf, 0.075, kalimba_note(84, 0.58, vel=0.42), pan=0.58)
    buf = stereo_reverb(buf, wet=0.25, decay=0.5, seed=99)
    buf /= float(np.max(np.abs(buf))) + 1e-9
    chime_path = out_dir / "sfx_chime.wav"
    sf.write(str(chime_path), (buf * 0.42).astype(np.float32), SR, subtype="PCM_16")
    paths["chime"] = str(chime_path)

    # 4. Subtle callout pop
    n = int(SR * 0.06)
    t = np.arange(n) / SR
    f = 360.0 + 380.0 * (1.0 - np.exp(-t * 65.0))
    ph = 2.0 * np.pi * np.cumsum(f) / SR
    pop = np.sin(ph) * (np.sin(np.pi * t / 0.06) ** 1.3) * 0.32
    pop_path = out_dir / "sfx_pop.wav"
    sf.write(str(pop_path), np.stack([pop, pop], axis=1).astype(np.float32), SR, subtype="PCM_16")
    paths["pop"] = str(pop_path)

    return paths


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: sound_design.py <duration_sec> <out_dir>", file=sys.stderr)
        sys.exit(2)
    duration_s = float(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    bgm_path = out_dir / "bgm.wav"
    generate_bgm(duration_s, bgm_path)
    sfx = generate_sfx(out_dir)
    print(json.dumps({"bgm": str(bgm_path), "sfx": sfx, "duration": duration_s, "sampleRate": SR}))


if __name__ == "__main__":
    main()
