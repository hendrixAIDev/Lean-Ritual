#!/usr/bin/env python3
"""Procedural upbeat studio background music bed and synced UI sound effects (CC0 / original).

Run via:
  uv run --python 3.11 --with numpy --with soundfile python tools/demo-video/sound_design.py <duration_sec> <out_dir>

Generates 48kHz stereo 16-bit PCM WAV files:
  - bgm.wav        (upbeat 116 BPM modern synth-pop / Rhodes + airy pad + pluck + crisp groove)
  - sfx_tap.wav    (clean subtle tactile UI tap)
  - sfx_swoosh.wav (silky stereo transition whoosh)
  - sfx_impact.wav (punchy beat-synced section transition thump + shimmer)
  - sfx_chime.wav  (warm two-note marimba/glass confirmation chime)
  - sfx_pop.wav    (crisp rising pop for kinetic callouts & stat count-ups)
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
    # Carve a clean -4.0 dB pocket around 2.4 kHz and gentle sheen rolloff >8.5 kHz so narration cuts through cleanly.
    n = stereo.shape[0]
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    bell = np.exp(-0.5 * ((np.log2(np.maximum(freqs, 20.0) / 2400.0)) / 0.75) ** 2)
    gain = 10.0 ** (-4.0 * bell / 20.0)
    hi = 1.0 / np.sqrt(1.0 + (freqs / 8600.0) ** 2)
    curve = gain * hi
    out = np.zeros_like(stereo)
    for ch in range(2):
        out[:, ch] = np.fft.irfft(np.fft.rfft(stereo[:, ch]) * curve, n=n)
    return out


def stereo_reverb(stereo: np.ndarray, wet: float = 0.22, decay: float = 1.25, seed: int = 42) -> np.ndarray:
    rng = np.random.default_rng(seed)
    ir_len = int(SR * decay)
    t = np.arange(ir_len) / SR
    env = np.exp(-t * (5.8 / decay))
    pre = int(SR * 0.015)
    out = np.zeros_like(stereo)
    n_conv = stereo.shape[0] + ir_len - 1
    n_fft = 1 << (n_conv - 1).bit_length()
    for ch in range(2):
        ir = np.zeros(ir_len)
        ir[pre:] = rng.standard_normal(ir_len - pre) * env[: ir_len - pre]
        ir = fft_lp(fft_hp(ir, 200.0), 3800.0)
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        wet_sig = np.fft.irfft(
            np.fft.rfft(stereo[:, ch], n_fft) * np.fft.rfft(ir, n_fft), n_fft
        )[: stereo.shape[0]]
        out[:, ch] = stereo[:, ch] * (1.0 - wet * 0.35) + wet_sig * wet
    return out


def rhodes_note(midi: float, dur_s: float, vel: float = 0.7) -> np.ndarray:
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    f = midi_to_hz(midi)
    atk = np.minimum(1.0, t / 0.008)
    rel_len = min(int(SR * 0.12), n // 3)
    rel = np.ones(n)
    if rel_len > 0:
        rel[-rel_len:] = np.linspace(1.0, 0.0, rel_len) ** 1.5
    body_env = np.exp(-t * 1.8) * atk * rel
    tine_env = np.exp(-t * 11.0) * atk * rel
    mod = 0.24 * np.exp(-t * 8.0) * np.sin(2.0 * np.pi * f * t)
    sig = (
        0.74 * np.sin(2.0 * np.pi * f * t + mod) * body_env
        + 0.25 * np.sin(2.0 * np.pi * 2.0 * f * t) * np.exp(-t * 3.0) * atk * rel
        + 0.11 * np.sin(2.0 * np.pi * 3.0 * f * t) * tine_env
        + 0.045 * np.sin(2.0 * np.pi * 7.0 * f * t) * np.exp(-t * 19.0) * atk * rel
    )
    return sig * vel


def bright_pluck(midi: float, dur_s: float, vel: float = 0.5) -> np.ndarray:
    # Snappy modern future-pop marimba/synth pluck
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    f = midi_to_hz(midi)
    atk = np.minimum(1.0, t / 0.003)
    sig = (
        0.72 * np.sin(2.0 * np.pi * f * t) * np.exp(-t * 6.4)
        + 0.24 * np.sin(2.0 * np.pi * 2.0 * f * t) * np.exp(-t * 12.0)
        + 0.14 * np.sin(2.0 * np.pi * 3.0 * f * t) * np.exp(-t * 20.0)
        + 0.05 * np.sin(2.0 * np.pi * 4.0 * f * t) * np.exp(-t * 28.0)
    ) * atk
    return sig * vel


def synth_pad_chord(midis, dur_s: float, vel: float = 0.19) -> np.ndarray:
    n = int(SR * dur_s)
    t = np.arange(n) / SR
    fade_in = min(int(SR * 0.28), n // 3)
    fade_out = min(int(SR * 0.38), n // 3)
    env = np.ones(n)
    env[:fade_in] = 0.5 - 0.5 * np.cos(np.pi * np.arange(fade_in) / fade_in)
    env[-fade_out:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(fade_out) / fade_out)
    left = np.zeros(n)
    right = np.zeros(n)
    for idx, m in enumerate(midis):
        f = midi_to_hz(m)
        s1 = np.sin(2.0 * np.pi * (f * 0.9982) * t) + 0.20 * np.sin(2.0 * np.pi * (f * 1.9964) * t)
        s2 = np.sin(2.0 * np.pi * (f * 1.0018) * t) + 0.20 * np.sin(2.0 * np.pi * (f * 2.0036) * t)
        pan = 0.25 + 0.5 * (idx / max(1, len(midis) - 1))
        left += s1 * (1.0 - pan) + s2 * pan * 0.5
        right += s2 * pan + s1 * (1.0 - pan) * 0.5
    left = fft_lp(left, 1350.0) * env * (vel / len(midis))
    right = fft_lp(right, 1350.0) * env * (vel / len(midis))
    return np.stack([left, right], axis=1)


def punchy_kick() -> np.ndarray:
    n = int(SR * 0.17)
    t = np.arange(n) / SR
    freq = 46.0 + 108.0 * np.exp(-t * 48.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    env = np.exp(-t * 19.0) * np.minimum(1.0, t / 0.002)
    click = np.sin(2.0 * np.pi * 1650.0 * t) * np.exp(-t * 190.0) * 0.14
    return (np.sin(phase) * env + click) * 0.46


def crisp_clap(rng: np.random.Generator) -> np.ndarray:
    n = int(SR * 0.11)
    t = np.arange(n) / SR
    noise = fft_lp(fft_hp(rng.standard_normal(n), 1150.0), 6400.0)
    # Multi-tap clap transient for snappy modern pop groove
    env = (
        0.55 * np.exp(-np.maximum(0.0, t) * 95.0)
        + 0.70 * np.where(t >= 0.009, np.exp(-np.maximum(0.0, t - 0.009) * 85.0), 0.0)
        + 0.90 * np.where(t >= 0.018, np.exp(-np.maximum(0.0, t - 0.018) * 34.0), 0.0)
    )
    tone = np.sin(2.0 * np.pi * 520.0 * t) * np.exp(-t * 70.0) * 0.16
    return (noise * env * 0.19 + tone)


def crisp_hat(rng: np.random.Generator, accent: float = 1.0, open_hat: bool = False) -> np.ndarray:
    dur = 0.12 if open_hat else 0.042
    n = int(SR * dur)
    t = np.arange(n) / SR
    noise = fft_hp(fft_lp(rng.standard_normal(n), 11500.0), 6200.0)
    decay = 24.0 if open_hat else 85.0
    env = np.exp(-t * decay) * np.minimum(1.0, t / 0.0015)
    return noise * env * 0.068 * accent


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
    rng = np.random.default_rng(20261124)
    bpm = 116.0
    beat = 60.0 / bpm
    bar = beat * 4.0
    total_n = int(SR * (duration_s + 0.6))
    buf = np.zeros((total_n, 2), dtype=np.float64)

    # Uplifting, forward-moving progression in C major / A minor
    # Section A: Fmaj9 -> G6/9 -> Am9 -> Em7
    prog_a = [
        {"bass": 41, "chord": [53, 57, 60, 64, 67], "arp": [72, 76, 79, 81, 79, 76]},
        {"bass": 43, "chord": [55, 59, 62, 64, 69], "arp": [74, 76, 79, 83, 81, 79]},
        {"bass": 45, "chord": [57, 60, 64, 67, 71], "arp": [76, 79, 83, 84, 83, 79]},
        {"bass": 40, "chord": [52, 55, 59, 62, 67], "arp": [71, 74, 79, 83, 79, 76]},
    ]
    # Section B (energetic chorus lift): Fmaj9 -> G13 -> Cmaj9 -> Am9
    prog_b = [
        {"bass": 41, "chord": [53, 57, 60, 64, 69], "arp": [76, 79, 81, 84, 81, 79]},
        {"bass": 43, "chord": [55, 59, 64, 65, 69], "arp": [79, 81, 83, 86, 83, 79]},
        {"bass": 48, "chord": [52, 55, 59, 62, 67], "arp": [76, 79, 83, 88, 84, 79]},
        {"bass": 45, "chord": [57, 60, 64, 67, 71], "arp": [76, 79, 84, 83, 79, 76]},
    ]

    kick = punchy_kick()
    clap = crisp_clap(rng)

    num_bars = int(math.ceil(duration_s / bar))
    for b in range(num_bars):
        t0 = b * bar
        if t0 >= duration_s - 2.2:
            break
        is_intro = b < 1
        is_outro = t0 > duration_s - 4.8
        cycle_idx = max(0, b - 1) % 16
        use_b = (not is_intro) and (cycle_idx >= 8)
        spec = (prog_b if use_b else prog_a)[b % 4]

        # Warm wide ambient pad
        add_stereo(buf, t0, synth_pad_chord(spec["chord"][:4], bar + 0.25, vel=0.17 if is_intro else 0.20))

        # Energetic syncopated Rhodes stabs (beat 1, beat 2.5, beat 3.5 in section B)
        for j, m in enumerate(spec["chord"]):
            pan = 0.24 + 0.52 * (j / max(1, len(spec["chord"]) - 1))
            add_mono(buf, t0 + j * 0.014, rhodes_note(m, beat * 1.9, vel=0.125), pan=pan)
        if not is_intro:
            for j, m in enumerate(spec["chord"][1:]):
                pan = 0.28 + 0.48 * (j / 3.0)
                add_mono(buf, t0 + beat * 1.75 + j * 0.012, rhodes_note(m, beat * 0.9, vel=0.08), pan=pan)
                add_mono(buf, t0 + beat * 3.0 + j * 0.012, rhodes_note(m, beat * 1.1, vel=0.09), pan=pan)

        # Bouncy octave-pop bassline
        if not is_intro:
            f_bass = midi_to_hz(spec["bass"])
            f_oct = midi_to_hz(spec["bass"] + 12)
            bass_pat = [
                (0.0, beat * 1.1, 0.24, f_bass),
                (1.5, beat * 0.75, 0.18, f_bass),
                (2.25, beat * 0.6, 0.12, f_oct),
                (3.0, beat * 0.85, 0.20, f_bass),
            ]
            for bt, d_b, v_b, fb in bass_pat:
                n_b = int(SR * d_b)
                tb = np.arange(n_b) / SR
                env_b = np.minimum(1.0, tb / 0.01) * np.exp(-tb * 2.6)
                bass_sig = (
                    np.sin(2.0 * np.pi * fb * tb) + 0.24 * np.sin(2.0 * np.pi * 2.0 * fb * tb)
                ) * env_b * v_b
                add_mono(buf, t0 + bt * beat, bass_sig, pan=0.5)

        # Bright forward-moving synth pluck arpeggio
        if not is_outro:
            arp_offsets = [0.0, 0.5, 1.25, 2.0, 2.75, 3.5]
            for k, off in enumerate(arp_offsets):
                if is_intro and k % 2 == 1:
                    continue
                m = spec["arp"][k % len(spec["arp"])]
                pan = 0.26 if k % 2 == 0 else 0.74
                vel = 0.095 if use_b else 0.08
                add_mono(buf, t0 + off * beat, bright_pluck(m, 0.42, vel=vel), pan=pan)

        # Crisp four-on-the-floor / syncopated modern upbeat groove
        if not is_intro and not is_outro:
            add_mono(buf, t0 + 0.0 * beat, kick, pan=0.5)
            add_mono(buf, t0 + 1.5 * beat, kick * 0.62, pan=0.5)
            add_mono(buf, t0 + 2.0 * beat, kick * 0.92, pan=0.5)
            if use_b:
                add_mono(buf, t0 + 3.5 * beat, kick * 0.65, pan=0.5)
            add_mono(buf, t0 + 1.0 * beat, clap, pan=0.54)
            add_mono(buf, t0 + 3.0 * beat, clap * 0.92, pan=0.46)
            for s in range(16):
                if s % 2 == 1 and not use_b:
                    continue
                is_open = (s == 14)
                acc = 1.0 if (s % 4 == 2) else (0.72 if (s % 2 == 0) else 0.36)
                add_mono(
                    buf,
                    t0 + s * (beat * 0.25),
                    crisp_hat(rng, acc, open_hat=is_open),
                    pan=0.64 if (s % 2) else 0.38,
                )

    # Bright final resolve chord (Cmaj9) landing cleanly on the outro card
    end_t = max(0.0, duration_s - 3.2)
    add_stereo(buf, end_t, synth_pad_chord([48, 55, 60, 64, 67, 74], 3.1, vel=0.20))
    for j, m in enumerate([48, 55, 60, 64, 67, 71, 74, 76]):
        pan = 0.20 + 0.60 * (j / 7.0)
        add_mono(buf, end_t + j * 0.026, rhodes_note(m, 3.1, vel=0.12), pan=pan)

    buf = buf[: int(SR * duration_s)]
    buf = stereo_reverb(buf, wet=0.22, decay=1.25, seed=42)
    buf = vocal_pocket_eq(buf)

    # Crisp intro swell and smooth outro fade
    fi = min(int(SR * 0.45), buf.shape[0] // 4)
    fo = min(int(SR * 2.1), buf.shape[0] // 3)
    buf[:fi] *= np.linspace(0.0, 1.0, fi)[:, None] ** 1.1
    buf[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None] ** 1.6

    peak = float(np.max(np.abs(buf))) + 1e-9
    buf = buf * (0.74 / peak)
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
    mid_band = fft_lp(fft_hp(pink, 650.0), 2600.0)
    env = np.sin(np.pi * t / dur) ** 1.6
    mid_mix = np.sin(np.pi * t / dur) ** 2.4
    sw = (low_band * (1.0 - 0.5 * mid_mix) + mid_band * 1.5 * mid_mix) * env
    sw /= float(np.max(np.abs(sw))) + 1e-9
    pan_l = np.cos((0.20 + 0.6 * t / dur) * math.pi / 2.0)
    pan_r = np.sin((0.20 + 0.6 * t / dur) * math.pi / 2.0)
    swoosh_path = out_dir / "sfx_swoosh.wav"
    sf.write(
        str(swoosh_path),
        np.stack([sw * pan_l * 0.34, sw * pan_r * 0.34], axis=1).astype(np.float32),
        SR,
        subtype="PCM_16",
    )
    paths["swoosh"] = str(swoosh_path)

    # 3. Punchy beat-synced section impact (sub-thump + crisp shimmer whoosh, 0.52s)
    dur = 0.52
    n = int(SR * dur)
    t = np.arange(n) / SR
    buf = np.zeros((n, 2), dtype=np.float64)
    # Rising pre-whoosh (0.00 -> 0.16s) into sub punch at 0.16s
    hit_t = 0.16
    w = rng.standard_normal(n)
    f_w = np.fft.rfftfreq(n, 1.0 / SR)
    p_noise = np.fft.irfft(np.fft.rfft(w) / np.maximum(np.sqrt(f_w), 1.0), n=n)
    air = fft_lp(fft_hp(p_noise, 700.0), 4200.0)
    air_env = np.where(t < hit_t, (t / hit_t) ** 2.2, np.exp(-(t - hit_t) * 9.5))
    air_sig = air * air_env
    air_sig /= float(np.max(np.abs(air_sig))) + 1e-9
    buf[:, 0] += air_sig * 0.24 * np.cos((0.3 + 0.4 * t / dur) * math.pi / 2.0)
    buf[:, 1] += air_sig * 0.24 * np.sin((0.3 + 0.4 * t / dur) * math.pi / 2.0)
    # Warm sub thump at hit_t
    sub_n = int(SR * 0.26)
    ts = np.arange(sub_n) / SR
    sfreq = 42.0 + 96.0 * np.exp(-ts * 32.0)
    sphase = 2.0 * np.pi * np.cumsum(sfreq) / SR
    sub = np.sin(sphase) * np.exp(-ts * 12.0) * np.minimum(1.0, ts / 0.003) * 0.44
    add_mono(buf, hit_t, sub, pan=0.5)
    # Subtle glass shimmer fifth at hit_t
    add_mono(buf, hit_t, bright_pluck(76, 0.28, vel=0.14), pan=0.38)
    add_mono(buf, hit_t + 0.02, bright_pluck(83, 0.30, vel=0.12), pan=0.62)
    buf /= float(np.max(np.abs(buf))) + 1e-9
    impact_path = out_dir / "sfx_impact.wav"
    sf.write(str(impact_path), (buf * 0.46).astype(np.float32), SR, subtype="PCM_16")
    paths["impact"] = str(impact_path)

    # 4. Warm two-note confirmation chime (G5 -> C6)
    dur = 0.72
    n = int(SR * dur)
    buf = np.zeros((n, 2), dtype=np.float64)
    add_mono(buf, 0.00, bright_pluck(79, 0.45, vel=0.36), pan=0.42)
    add_mono(buf, 0.070, bright_pluck(84, 0.58, vel=0.42), pan=0.58)
    buf = stereo_reverb(buf, wet=0.25, decay=0.5, seed=99)
    buf /= float(np.max(np.abs(buf))) + 1e-9
    chime_path = out_dir / "sfx_chime.wav"
    sf.write(str(chime_path), (buf * 0.42).astype(np.float32), SR, subtype="PCM_16")
    paths["chime"] = str(chime_path)

    # 5. Crisp rising pop for kinetic callouts & stat count-ups
    n = int(SR * 0.07)
    t = np.arange(n) / SR
    f = 380.0 + 460.0 * (1.0 - np.exp(-t * 72.0))
    ph = 2.0 * np.pi * np.cumsum(f) / SR
    pop = np.sin(ph) * (np.sin(np.pi * t / 0.07) ** 1.25) * 0.36
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
