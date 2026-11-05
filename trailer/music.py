"""Soundtrack for the Slide It !! trailer.

Usage: python music.py events.json music.wav

A 60 second pastel lo-fi piece at 96 BPM (one bar = 2.5 s, so every trailer
cut lands on a bar line), plus sound effects placed at the exact moments the
trailer logged in events.json (typing, the portal swallowing the cube, title
card pops, wipes...). Everything is synthesised with numpy; no samples.
"""
import json
import sys
import wave

import numpy as np

SR = 44100
DUR = 60.0
N = int(SR * DUR)
BPM = 96
BEAT = 60 / BPM
BAR = BEAT * 4
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
wet = np.zeros((N, 2))  # sent to the reverb
sfx = np.zeros((N, 2))


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tline(dur):
    return np.arange(int(dur * SR)) / SR


def place(buf, sig, t0, gain=1.0, pan=0.0):
    """Add a mono signal at time t0 (s) with equal-power panning."""
    i0 = int(t0 * SR)
    if i0 >= N or len(sig) == 0:
        return
    if i0 < 0:
        sig = sig[-i0:]
        i0 = 0
    n = min(len(sig), N - i0)
    left = np.cos((pan + 1) * np.pi / 4)
    right = np.sin((pan + 1) * np.pi / 4)
    buf[i0:i0 + n, 0] += sig[:n] * gain * left
    buf[i0:i0 + n, 1] += sig[:n] * gain * right


def env_ar(n, attack, release):
    e = np.ones(n)
    a = min(n, int(attack * SR))
    r = min(n, int(release * SR))
    if a:
        e[:a] = np.linspace(0, 1, a)
    if r:
        e[n - r:] *= np.linspace(1, 0, r)
    return e


def soft_saw(f, t, harmonics=6):
    return sum(np.sin(2 * np.pi * k * f * t) / k for k in range(1, harmonics + 1))


def lowpass(x, cutoff):
    """Single-pole low-pass, vectorised enough for short sounds."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


# ---------- instruments ----------
def pad(notes, t0, dur, gain=0.05, harmonics=5):
    t = tline(dur + 1.4)
    for j, m in enumerate(notes):
        sig = np.zeros_like(t)
        for det in (-0.006, 0.0, 0.007):
            sig += soft_saw(hz(m) * (1 + det), t, harmonics)
        sig *= env_ar(len(t), 0.9, 1.5)
        pan = (j / max(1, len(notes) - 1)) * 1.2 - 0.6
        place(music, sig, t0, gain / 3, pan)
        place(wet, sig, t0, gain / 3 * 0.8, pan)


def bell(m, t0, gain=0.12, pan=0.0, decay=1.1, send=0.6):
    t = tline(decay * 3)
    f = hz(m)
    mod = 1.6 * np.exp(-t / 0.25) * np.sin(2 * np.pi * f * 2.0 * t)
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / decay)
    sig *= env_ar(len(t), 0.004, 0.05)
    place(music, sig, t0, gain, pan)
    place(wet, sig, t0, gain * send, pan)


def pluck(m, t0, gain=0.09, pan=0.0):
    t = tline(0.6)
    f = hz(m)
    sig = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t))
    sig *= np.exp(-t / 0.16) * env_ar(len(t), 0.004, 0.03)
    place(music, sig, t0, gain, pan)
    place(wet, sig, t0, gain * 0.4, pan)


def bass(m, t0, dur, gain=0.2):
    t = tline(dur)
    f = hz(m)
    sig = np.tanh(1.6 * (np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t)))
    sig *= env_ar(len(t), 0.012, 0.09)
    place(music, sig, t0, gain)


def lead(m, t0, dur, gain=0.07):
    t = tline(dur + 0.25)
    f = hz(m) * (1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.3, 0, 1))
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = sum(((-1) ** k) * np.sin((2 * k + 1) * phase) / (2 * k + 1) ** 2 for k in range(5))
    sig *= env_ar(len(t), 0.02, 0.22)
    place(music, sig, t0, gain, 0.15)
    place(wet, sig, t0, gain * 0.7, 0.15)


def kick(t0, gain=0.55):
    t = tline(0.45)
    f = 46 + 80 * np.exp(-t / 0.035)
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = np.sin(phase) * np.exp(-t / 0.22)
    sig[:60] += np.linspace(0.4, 0, 60) * rng.standard_normal(60)
    place(music, sig, t0, gain)


def snare(t0, gain=0.18):
    t = tline(0.3)
    noise = lowpass(rng.standard_normal(len(t)), 5200) * np.exp(-t / 0.09)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.06)
    sig = noise * 0.9 + tone * 0.6
    place(music, sig, t0, gain, -0.05)
    place(wet, sig, t0, gain * 0.35, -0.05)


def hat(t0, gain=0.05, pan=0.25, length=0.035):
    t = tline(0.12)
    noise = rng.standard_normal(len(t))
    noise = np.diff(noise, prepend=0)
    sig = noise * np.exp(-t / length)
    place(music, sig, t0, gain, pan)


def noise_swell(t0, dur, gain, peak_at=0.85):
    """filtered noise that rises then cuts: whooshes and risers"""
    t = tline(dur)
    k = t / dur
    shape = np.where(k < peak_at, (k / peak_at) ** 2, np.exp(-(k - peak_at) * dur / 0.06))
    noise = rng.standard_normal(len(t))
    sig = lowpass(noise, 2600) - 0.6 * lowpass(noise, 300)
    place(sfx, sig * shape, t0, gain, 0.0)
    place(wet, sig * shape, t0, gain * 0.5)


def sweep(t0, f0, f1, dur, gain, pan=0.0, curve=1.0, send=0.3):
    t = tline(dur)
    k = (t / dur) ** curve
    f = f0 * (f1 / f0) ** k
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = np.sin(phase) * env_ar(len(t), 0.01, dur * 0.4)
    place(sfx, sig, t0, gain, pan)
    place(wet, sig, t0, gain * send, pan)


def sfx_bell(m, t0, gain, pan=0.0, decay=0.8):
    t = tline(decay * 3)
    f = hz(m)
    mod = 1.2 * np.exp(-t / 0.2) * np.sin(2 * np.pi * f * 2.0 * t)
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / decay) * env_ar(len(t), 0.003, 0.05)
    place(sfx, sig, t0, gain, pan)
    place(wet, sig, t0, gain * 0.7, pan)


# ---------- the score ----------
CHORDS = [
    [53, 57, 60, 64, 67],  # Fmaj9
    [52, 55, 59, 62, 69],  # Em7(11)
    [50, 53, 57, 60, 64],  # Dm9
    [48, 52, 55, 59, 62],  # Cmaj9
]
ROOTS = [41, 40, 38, 36]
MELODY = [  # (beat, midi, length in beats), one bar per chord
    [(0, 72, 0.5), (0.5, 74, 0.5), (1, 76, 1.0), (2.5, 79, 0.5), (3, 77, 1.0)],
    [(0, 76, 0.75), (1, 74, 0.5), (1.5, 72, 0.5), (2, 71, 1.5), (3.5, 72, 0.5)],
    [(0, 74, 0.5), (0.5, 76, 0.5), (1, 77, 1.0), (2, 81, 0.75), (3, 79, 1.0)],
    [(0, 76, 1.0), (1, 74, 0.5), (1.5, 72, 2.5)],
]
SWING = 0.07 * BEAT


def bar_start(b):
    return b * BAR


def section(b):
    t = bar_start(b)
    if t < 5:
        return 'intro'
    if t < 12.5:
        return 'build'
    if t < 20:
        return 'groove'
    if t < 22.5:
        return 'card'
    if t < 30:
        return 'groove2'
    if t < 32.5:
        return 'card2'
    if t < 40:
        return 'montage'
    if t < 45:
        return 'features'
    if t < 52.5:
        return 'hero'
    return 'end'


for b in range(24):
    t0 = bar_start(b)
    sec = section(b)
    chord = CHORDS[b % 4]
    root = ROOTS[b % 4]
    if sec == 'end':
        chord = CHORDS[0] if b != 22 else CHORDS[3]
        root = ROOTS[0] if b != 22 else ROOTS[3]

    # pad everywhere; darker in the intro, bigger in the hero shot
    pad(chord, t0, BAR, gain={'intro': 0.045, 'hero': 0.075, 'end': 0.07}.get(sec, 0.055),
        harmonics=3 if sec == 'intro' else 5)

    if sec in ('build', 'features', 'end'):
        for beat, idx in ((0, 2), (1.5, 3), (2, 4), (3.5, 3)):
            bell(chord[idx] + 12, t0 + beat * BEAT, gain=0.07, pan=0.35 * (1 if idx % 2 else -1))

    drums = sec in ('groove', 'groove2', 'montage', 'features')
    if drums:
        for beat in (0, 2.5):
            kick(t0 + beat * BEAT)
        for beat in (1, 3):
            snare(t0 + beat * BEAT)
        steps = 16 if sec == 'montage' else 8
        for i in range(steps):
            beat = i * 4 / steps
            offbeat = (beat % 1) >= 0.5
            hat(t0 + beat * BEAT + (SWING if offbeat else 0),
                gain=0.045 if beat % 1 == 0 else 0.03, pan=0.3 if offbeat else 0.15)
        for beat in (0, 2.5):
            bass(root, t0 + beat * BEAT, BEAT * (2.4 if beat == 0 else 1.4))
        for i in range(8):
            if i % 2 == 0 or sec == 'montage':
                pluck(chord[(i * 2) % len(chord)] + 12, t0 + i * BEAT / 2 + (SWING if i % 2 else 0),
                      gain=0.05, pan=-0.3 if i % 2 else 0.3)

    if sec in ('groove2', 'montage'):
        for beat, m, length in MELODY[b % 4]:
            lead(m, t0 + beat * BEAT, length * BEAT)

    if sec == 'hero':
        kick(t0, gain=0.4)
        bass(root, t0, BAR * 0.95, gain=0.16)
        for i, idx in enumerate((4, 3, 2, 3)):
            bell(chord[idx] + 24, t0 + i * BEAT, gain=0.045, pan=0.5 * (-1) ** i, decay=1.6)

    if sec == 'end':
        bass(root, t0, BAR * 0.95, gain=0.14)
        if b == 21:
            kick(t0, gain=0.45)

# the logo motif on the end card
for beat, m in ((0, 84), (0.5, 88), (1, 91), (2, 93), (3, 91), (4, 96)):
    bell(m, 53.4 + beat * BEAT * 0.5, gain=0.08, pan=0.2, decay=1.4)

# riser into "Draw the line." -> gameplay 2, and a fill before the montage
noise_swell(20.6, 1.9, 0.10)
sweep(20.6, 200, 900, 1.9, 0.05, curve=2.0)
for i in range(8):
    snare(31.875 + i * BEAT / 8, gain=0.06 + i * 0.012)


# ---------- sound effects from the trailer's event log ----------
def play_event(kind, t):
    if kind == 'type':
        n = rng.integers(0, 3)
        tt = tline(0.03)
        click = np.diff(rng.standard_normal(len(tt)), prepend=0) * np.exp(-tt / 0.006)
        place(sfx, click, t, 0.12, 0.1)
        sfx_bell(96 + n * 2, t, 0.025, decay=0.05)
    elif kind == 'press':
        sweep(t, 180, 80, 0.09, 0.35, send=0.05)
    elif kind in ('land', 'thud'):
        sweep(t, 120, 50, 0.16, 0.45 if kind == 'thud' else 0.32, send=0.05)
    elif kind == 'portal':
        sweep(t, 300, 1500, 0.5, 0.12, curve=0.6, send=0.6)
        for i, m in enumerate((84, 88, 91, 96)):
            sfx_bell(m, t + 0.08 + i * 0.06, 0.07, pan=-0.4 + i * 0.27)
    elif kind == 'win':
        sfx_bell(79, t, 0.11, -0.2)
        sfx_bell(84, t + 0.13, 0.12, 0.2)
        sfx_bell(91, t + 0.26, 0.07, 0.0, decay=1.2)
    elif kind == 'lose':
        sweep(t, hz(76), hz(76), 0.18, 0.12, send=0.3)
        sweep(t + 0.2, hz(72), hz(70), 0.3, 0.12, send=0.3)
    elif kind == 'fall':
        sweep(t, 1100, 280, 0.8, 0.07, curve=0.8)
    elif kind == 'whoosh':
        noise_swell(t, 0.45, 0.22, peak_at=0.66)
    elif kind == 'pop':
        sweep(t, 500, 1300, 0.07, 0.14, send=0.2)
    elif kind == 'chime':
        sfx_bell(84, t, 0.05, -0.3, decay=1.0)
        sfx_bell(91, t + 0.09, 0.04, 0.3, decay=1.0)
    elif kind == 'drop':
        sweep(t, 950, 520, 0.4, 0.05, curve=0.7)
    elif kind == 'appear':
        for i, m in enumerate((79, 84, 88, 91)):
            sfx_bell(m, t + i * 0.07, 0.06, pan=0.3)
    elif kind == 'path':
        for i, m in enumerate((72, 74, 76, 79, 81, 84, 86, 88)):
            sfx_bell(m + 12, t + i * 0.18, 0.035, pan=-0.5 + i * 0.14, decay=0.6)
    elif kind == 'cut':
        hat(t, gain=0.12, pan=0.0, length=0.05)
        kick(t, gain=0.3)
    elif kind == 'tick':
        sfx_bell(100, t, 0.03, 0.2, decay=0.08)
    elif kind == 'slowmo':
        sweep(t, 220, 55, 1.0, 0.22, curve=0.5, send=0.5)
    elif kind == 'logo':
        kick(t, gain=0.5)
        noise_swell(t - 0.4, 0.55, 0.12, peak_at=0.72)
        for m in (65, 69, 72, 76, 79):
            bell(m, t, gain=0.05, decay=1.8, send=0.8)


events = json.load(open(sys.argv[1]))
for ev in events:
    play_event(ev['type'], ev['t'])


# ---------- reverb, mix, master ----------
def reverb(x, seconds=2.4, decay=0.55):
    n_ir = int(seconds * SR)
    t = np.arange(n_ir) / SR
    out = np.zeros_like(x)
    size = 1 << int(np.ceil(np.log2(len(x) + n_ir)))
    for ch in range(2):
        ir = rng.standard_normal(n_ir) * np.exp(-t / decay)
        ir = np.convolve(ir, np.ones(6) / 6, mode='same')
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        y = np.fft.irfft(np.fft.rfft(x[:, ch], size) * np.fft.rfft(ir, size), size)[: len(x)]
        out[:, ch] = y
    return out


# vinyl crackle and a whisper of tape hiss for the lo-fi texture
crackle = np.zeros(N)
idx = rng.integers(0, N, size=int(DUR * 7))
crackle[idx] = rng.uniform(-1, 1, len(idx)) * rng.uniform(0.2, 1, len(idx))
crackle = np.convolve(crackle, np.ones(3) / 3, mode='same')
hiss = np.diff(rng.standard_normal(N), prepend=0) * 0.004
for ch in range(2):
    music[:, ch] += crackle * 0.05 + hiss

mix = music * 0.85 + sfx + reverb(wet) * 0.35

# fades, gentle saturation, normalise to -1 dBFS
t = np.arange(N) / SR
fade = np.clip(t / 0.4, 0, 1) * np.clip((DUR - t) / 2.2, 0, 1)
mix *= fade[:, None]
mix = np.tanh(mix * 1.6) / 1.6
mix /= np.max(np.abs(mix)) / 10 ** (-1 / 20)

pcm = (mix * 32767).astype(np.int16)
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f'wrote {sys.argv[2]}: {DUR:.0f}s, {len(events)} sound effects')
