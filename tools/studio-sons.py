# Studio : assemble les sons de l'application à partir de vrais enregistrements (CC0 / CC-BY), puis les encode en MP3.
# Sources (voir public/sounds/CREDITS.txt) :
#   git clone https://github.com/sgossner/VCSL     (échantillons CC0 : orgue, sifflet, cloches…)
#   git clone https://github.com/ALEX11BR/AltSFX   (train, bateau, foules…)
# Utilisation : VCSL=chemin/VCSL ALTSFX=chemin/AltSFX python3 tools/studio-sons.py public/sounds
# (nécessite python3, numpy et ffmpeg)
import subprocess, numpy as np, os, sys
SR = 44100
V = os.environ.get('VCSL', 'VCSL').rstrip('/') + '/'; A = os.environ.get('ALTSFX', 'AltSFX').rstrip('/') + '/src/wav/'
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return x / (np.max(np.abs(x)) + 1e-9)

def trim(x, start=0.0, dur=None, fade_in=0.005, fade_out=0.08):
    s = int(start * SR); e = len(x) if dur is None else min(len(x), s + int(dur * SR))
    y = x[s:e].copy()
    fi, fo = int(fade_in * SR), int(fade_out * SR)
    if fi: y[:fi] *= np.linspace(0, 1, fi)
    if fo and fo < len(y): y[-fo:] *= np.linspace(1, 0, fo) ** 1.5
    return y

def silence_trim(x, thr=0.02):
    idx = np.where(np.abs(x) > thr)[0]
    return x[idx[0]:] if len(idx) else x

def pitch(x, semis):
    r = 2 ** (semis / 12)
    n = int(len(x) / r)
    return np.interp(np.arange(n) * r, np.arange(len(x)), x)

def mix(length, parts):
    out = np.zeros(int(length * SR))
    for at, sig, gain in parts:
        s = int(at * SR); e = min(len(out), s + len(sig))
        if e > s: out[s:e] += sig[:e - s] * gain
    return out

def reverb(x, size=1.2, wet=0.18, seed=1):
    # Réverbération de salle (aréna) : réponse impulsionnelle de bruit à décroissance exponentielle.
    rng = np.random.default_rng(seed); n = int(size * SR)
    ir = rng.standard_normal(n) * np.exp(-np.linspace(0, 7, n)); ir[0] = 0
    ir = np.convolve(ir, np.ones(30) / 30, mode='same')  # adoucit les aigus de la queue
    L = len(x) + n
    w = np.fft.irfft(np.fft.rfft(x, L) * np.fft.rfft(ir, L), L)[:L]
    w /= np.max(np.abs(w)) + 1e-9
    y = np.concatenate([x, np.zeros(n)])
    return y * (1 - wet) + w * wet

def master(x, name, peak=0.89):
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    x = np.tanh(x * 1.2) / np.tanh(1.2)  # légère compression douce
    pcm = (x * 32767).astype(np.int16).tobytes()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-', '-codec:a', 'libmp3lame', '-b:a', '96k', os.path.join(OUT, name + '.mp3')], input=pcm, check=True)
    print(f'{name}.mp3  {len(x) / SR:.1f} s')

# ---------- Orgue à tuyaux (VCSL, CC0) : notes échantillonnées tous les 3 demi-tons ----------
ORG = {}
NAMES = {'C': 0, 'D#': 3, 'F#': 6, 'A': 9}
for nm, off in NAMES.items():
    for octv in range(1, 7):
        p = f'{V}Aerophones/Edge-blown Aerophones/Pipe Organ/Loud/Rode_Man3Open_{nm}{octv}.wav'
        if os.path.exists(p): ORG[12 * (octv + 1) + off] = silence_trim(load(p), 0.01)
def midi(n):
    names = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
    return 12 * (int(n[-1]) + 1) + names[n[:-1]]
def organ(note, dur):
    m = midi(note); base = min(ORG, key=lambda k: abs(k - m))
    return trim(pitch(ORG[base], m - base), 0, dur + 0.05, 0.004, 0.06)
def chord(notes, dur, gain=1.0):
    sig = sum(organ(n, dur) for n in notes) / len(notes) ** 0.6
    return sig * gain
def melody(seq, tempo_gap=0.0):
    t, parts = 0.0, []
    for notes, dur in seq:
        if notes: parts.append((t, chord(notes if isinstance(notes, list) else [notes], dur), 1.0))
        t += dur + tempo_gap
    return mix(t + 0.3, parts), t

# ---------- Échantillons ----------
crowd = load(A + '29.wav'); oohs = load(A + '30.wav')
claps = [silence_trim(load(f'{V}Idiophones/Struck Idiophones/Claps/Clap_rr{i}.wav')) for i in range(1, 7)]
drum = silence_trim(load(f'{V}Membranophones/Struck Membranophones/Bass Drum 1/BDrumNew_hit_v7_rr1_Sum.wav'))
boat = load(A + '07.wav'); boat2 = load(A + '06.wav'); train = load(A + '10.wav'); steam = load(A + '04.wav')
airhorn = load(A + '35.wav'); crossing = load(A + '14.wav'); fireworks = load(A + '00.wav'); sad = load(A + '01.wav')
whistle_l = load(f'{V}Aerophones/Edge-blown Aerophones/Ball Whistle/Main_BallWhistle_Long-001.wav')
whistle_s = load(f'{V}Aerophones/Edge-blown Aerophones/Ball Whistle/Main_BallWhistle_Short-001.wav')
siren = load(f'{V}Aerophones/Free Aerophones/Siren/Main_SirenWhistle-010.wav')
clave1 = silence_trim(load(f'{V}Idiophones/Struck Idiophones/Claves/Claves1_Hit_v3_rr1_Mid.wav'))
clave2 = silence_trim(load(f'{V}Idiophones/Struck Idiophones/Claves/Claves2_Hit_v3_rr1_Mid.wav'))
def bell(note):
    p = f'{V}Idiophones/Struck Idiophones/Tubular Bells 1/chimes_{note}.wav'
    return silence_trim(load(p))

def applause(dur, density=14, seed=3):
    rng = np.random.default_rng(seed); parts = []
    for i in range(int(dur * density)):
        c = claps[rng.integers(len(claps))]
        parts.append((rng.uniform(0, dur), pitch(c, rng.uniform(-2, 2)), rng.uniform(.25, .6)))
    return mix(dur + 0.8, parts)

# ---------- Sons d'aréna ----------
# Klaxon de but : corne grave (corne de bateau abaissée d'un ton), foule et applaudissements, réverbération d'aréna.
horn = trim(pitch(boat, -2), 0, 3.6, 0.02, 0.4)
master(reverb(mix(6.0, [(0, horn, 1.0), (0.35, trim(crowd, 0, 4.0, 0.3, 1.2), 0.55), (0.4, applause(4.5), 0.5), (0.2, trim(oohs, 0, 1.9, 0.1, 0.5), 0.35)]), 1.6, 0.2), 'klaxon-but')
# Orgue « Charge ! » : sol-do-mi-sol … mi-sol (appel de clairon traditionnel), puis la foule.
seq = [('G4', .16), ('C5', .16), ('E5', .16), (['G5', 'G4'], .34), (None, .10), ('E5', .14), (['G5', 'C5', 'G4'], .9)]
mel, t = melody(seq)
master(reverb(mix(t + 2.6, [(0, mel, 1.0), (t - 0.2, trim(crowd, 0.3, 2.5, 0.2, 0.8), 0.5), (t - 0.1, applause(2.2, 10), 0.35)]), 1.8, 0.24), 'orgue-charge')
# Orgue « Let's go! » : deux accords, puis trois, avec la grosse caisse et les mains de la foule (rythme de foule).
pat = [(['C4', 'E4', 'G4'], .28), (['C4', 'E4', 'G4'], .28), (None, .12), (['D4', 'F4', 'A4'], .16), (['D4', 'F4', 'A4'], .16), (['E4', 'G4', 'C5'], .36)]
mel, t = melody(pat)
beats = [0, .28, .68, .84, 1.0]
parts = [(0, mel, 1.0)] + [(b, drum, .55) for b in beats] + [(b + .01, applause(.12, 60, seed=int(b * 100)), .5) for b in beats]
mel2, _ = melody(pat)
parts += [(t + .25, mel2, 1.0)] + [(t + .25 + b, drum, .55) for b in beats] + [(t + .26 + b, applause(.12, 60, seed=int(b * 100) + 7), .5) for b in beats]
master(reverb(mix(2 * t + 1.2, parts), 1.6, 0.22), 'orgue-letsgo')
# Orgue « Montée » : gamme chromatique qui accélère, puis grand accord et la foule (avant une mise au jeu).
notes = ['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5']
t, parts = 0.0, []
for i, n in enumerate(notes):
    d = max(.07, .2 - i * .011); parts.append((t, organ(n, d), .9)); t += d
parts += [(t, chord(['C4', 'G4', 'C5', 'E5', 'G5'], 1.3), 1.1), (t + .2, trim(crowd, 0, 2.4, .2, .9), .5)]
master(reverb(mix(t + 2.8, parts), 1.8, 0.24), 'orgue-montee')
master(reverb(mix(3.0, [(0, trim(airhorn, 0, 2.0, .005, .3), 1.0), (.3, trim(oohs, 0, 1.9, .1, .5), .3)]), 1.0, .12), 'klaxon-air')
master(reverb(mix(5.2, [(0, trim(crowd, 0, 4.0, .05, 1.0), .9), (0, applause(4.5, 18), .6), (.5, trim(airhorn, 0, .9, .005, .2), .45), (.1, trim(oohs, 0, 1.9, .05, .5), .5)]), 1.2, .15), 'foule')
master(reverb(trim(whistle_l, 0, 2.2, .005, .2), 1.4, .2), 'sifflet')

# ---------- Sons de la vraie vie ----------
master(reverb(trim(boat, 0, None, .01, .6), 2.2, .15), 'paquebot')
master(reverb(mix(4.8, [(0, trim(boat2, 0, 1.6, .01, .3), 1.0), (2.0, trim(boat2, 0, 2.6, .01, .6), 1.0)]), 2.2, .15), 'bateau-deux-coups')
master(trim(train, 0, None, .01, .5), 'train')
master(trim(steam, 0, None, .01, .4), 'locomotive-vapeur')
master(trim(crossing, 0, None, .01, .4), 'passage-a-niveau')
master(reverb(trim(siren, 0, None, .01, .4), 1.6, .12), 'sirene-manivelle')
master(trim(fireworks, 0, None, .01, .5), 'feux-artifice')
master(trim(sad, 0, None, .01, .5), 'foule-decue')

# ---------- Repêchage ----------
master(trim(clave1, 0, .25, .001, .05), 'rep-tic', .7)
master(trim(clave2, 0, .25, .001, .05), 'rep-tac', .7)
b1, b2 = bell('E4_ff_rr2'), bell('C4_ff_rr2')
master(mix(3.4, [(0, trim(b1, 0, 2.2, .002, .8), 1.0), (.55, trim(b2, 0, 2.8, .002, 1.0), 1.0)]), 'rep-suivant')
b3, b4 = bell('D4_ff_rr2'), bell('F#3_fff_rr1')
master(mix(3.6, [(0, trim(b2, 0, 2, .002, .8), .9), (.22, trim(b4, 0, 2, .002, .8), .9), (.44, trim(b1, 0, 2.6, .002, 1), 1.0)]), 'rep-mon-tour')
seq = [('G4', .13), ('C5', .13), ('E5', .13), (['G5', 'C5', 'G4'], .7)]
mel, t = melody(seq)
master(reverb(mix(t + 1.8, [(0, mel, 1.0), (t - .15, applause(1.6, 16), .55), (t - .1, trim(crowd, .5, 1.6, .2, .6), .35)]), 1.4, .2), 'rep-selection')
master(trim(whistle_s, 0, 1.0, .002, .15), 'rep-temps-ecoule')
