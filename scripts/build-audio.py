"""Generate natural conversational neural audio narration for Pheme stories.

Produces compact MP3 narration files and a manifest.json with per-paragraph
timing cues so the native Pheme reader plays warm, human-sounding speech
instead of robotic browser speechSynthesis.

Providers (selected automatically or via PHEME_TTS_PROVIDER):
- OpenAI gpt-4o-mini-tts (when OPENAI_API_KEY is set)
- ElevenLabs (when ELEVENLABS_API_KEY is set)
- Microsoft Edge Neural conversational voices via edge-tts (default, zero-key)
- Self-hosted open-source Kokoro-82M via kokoro-onnx (automatic offline fallback
  when edge-tts is unavailable, or explicitly via PHEME_TTS_PROVIDER=kokoro)
"""
import argparse
import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

KOKORO_MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'
KOKORO_VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
ESPEAK_LIB_CANDIDATES = (
    '/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1',
    '/usr/lib/x86_64-linux-gnu/libespeak-ng.so',
    '/usr/lib/aarch64-linux-gnu/libespeak-ng.so.1',
    '/usr/lib/libespeak-ng.so.1',
    '/opt/homebrew/lib/libespeak-ng.dylib',
    '/usr/local/lib/libespeak-ng.dylib',
)

VOICES = [
    {
        'id': 'ava',
        'label': 'Ava',
        'accent': 'US',
        'tagline': 'Warm & expressive',
        'edge': 'en-US-AvaMultilingualNeural',
        'kokoro': 'af_heart',
        'kokoro_lang': 'en-us',
        'openai': 'coral',
        'elevenlabs': 'EXAVITQu4vr4xnSDxMaL',
    },
    {
        'id': 'andrew',
        'label': 'Andrew',
        'accent': 'US',
        'tagline': 'Calm & conversational',
        'edge': 'en-US-AndrewMultilingualNeural',
        'kokoro': 'am_michael',
        'kokoro_lang': 'en-us',
        'openai': 'ash',
        'elevenlabs': 'TxGEqnHWrfWFTfGW9XjX',
    },
    {
        'id': 'sonia',
        'label': 'Sonia',
        'accent': 'UK',
        'tagline': 'British Southern · Crisp & warm',
        'edge': 'en-GB-SoniaNeural',
        'kokoro': 'bf_emma',
        'kokoro_lang': 'en-gb',
        'openai': 'sage',
        'elevenlabs': 'Xb7hH8MSUJpSbSDYk0k2',
    },
    {
        'id': 'libby',
        'label': 'Libby',
        'accent': 'UK',
        'tagline': 'British London · Modern & friendly',
        'edge': 'en-GB-LibbyNeural',
        'kokoro': 'bf_isabella',
        'kokoro_lang': 'en-gb',
        'openai': 'shimmer',
        'elevenlabs': '21m00Tcm4TlvDq8ikWAM',
    },
    {
        'id': 'amelia',
        'label': 'Amelia',
        'accent': 'UK',
        'tagline': 'British · Young & expressive',
        'edge': 'en-GB-MaisieNeural',
        'kokoro': 'bf_alice',
        'kokoro_lang': 'en-gb',
        'free_provider': 'kokoro',
        'openai': 'shimmer',
        'elevenlabs': 'ZF6FPAbjXT4488VcRRnw',
    },
    {
        'id': 'allison',
        'label': 'Allison',
        'accent': 'UK',
        'tagline': 'British · Smooth & velvety',
        'edge': 'en-GB-SoniaNeural',
        'kokoro': 'bf_isabella',
        'kokoro_lang': 'en-gb',
        'free_provider': 'kokoro',
        'openai': 'coral',
        'elevenlabs': 'Se2Vw1WbHmGbBbyWTuu4',
    },
    {
        'id': 'bradford',
        'label': 'Bradford',
        'accent': 'UK',
        'tagline': 'British · Expressive storyteller',
        'edge': 'en-GB-RyanNeural',
        'kokoro': 'bm_george',
        'kokoro_lang': 'en-gb',
        'free_provider': 'kokoro',
        'openai': 'ballad',
        'elevenlabs': 'NNl6r8mD7vthiJatiJt1',
    },
    {
        'id': 'sally',
        'label': 'Sally Ford',
        'accent': 'UK',
        'tagline': 'British · Calm & well-spoken',
        'edge': 'en-GB-LibbyNeural',
        'kokoro': 'bf_lily',
        'kokoro_lang': 'en-gb',
        'free_provider': 'kokoro',
        'openai': 'sage',
        'elevenlabs': 'kBag1HOZlaVBH7ICPE8x',
    },
    {
        'id': 'emily',
        'label': 'Emily',
        'accent': 'IE',
        'tagline': 'Irish · Warm & lyrical',
        'edge': 'en-IE-EmilyNeural',
        'kokoro': 'bf_alice',
        'kokoro_lang': 'en-gb',
        'openai': 'alloy',
        'elevenlabs': 'EXAVITQu4vr4xnSDxMaL',
    },
    {
        'id': 'ernesto',
        'label': 'Ernesto',
        'accent': 'MX',
        'tagline': 'Mexican-American · Warm & conversational',
        'edge': 'es-MX-JorgeNeural',
        'kokoro': 'am_fenrir',
        'kokoro_lang': 'en-us',
        'openai': 'echo',
        'elevenlabs': 'ZwLTvq6uCfb4W00YFl7F',
    },
    {
        'id': 'ximena',
        'label': 'Ximena',
        'accent': 'ES',
        'tagline': 'Spanish English · Warm & natural',
        'edge': 'es-ES-XimenaNeural',
        'kokoro': 'af_bella',
        'kokoro_lang': 'en-us',
        'openai': 'nova',
        'elevenlabs': '21m00Tcm4TlvDq8ikWAM',
    },
    {
        'id': 'alvaro',
        'label': 'Alvaro',
        'accent': 'ES',
        'tagline': 'Spanish English · Castilian & clear',
        'edge': 'es-ES-AlvaroNeural',
        'kokoro': 'am_adam',
        'kokoro_lang': 'en-us',
        'openai': 'fable',
        'elevenlabs': 'TxGEqnHWrfWFTfGW9XjX',
    },
]

OPENAI_INSTRUCTIONS = (
    'Speak like a warm, thoughtful human briefing host on Sesame. '
    'Use a relaxed, natural conversational cadence with gentle warmth, clear phrasing, '
    'and brief natural breaths between paragraphs. Never sound robotic, stiff, or like a news anchor.'
)

_kokoro_lock = threading.Lock()
_kokoro_instance = None


def prepare_spoken_text(text):
    """Normalise written journalism shorthand into natural spoken phrasing."""
    s = str(text or '').strip()
    s = s.replace('—', ', ').replace('–', ' to ')
    s = re.sub(r'\bGTA\s+VI\b', 'GTA Six', s)
    s = re.sub(r'\bRTÉ\b', 'R T E', s)
    s = re.sub(r'\bGLP-1s\b', 'G L P ones', s)
    s = re.sub(r'\bGLP-1\b', 'G L P one', s)
    s = re.sub(r'\bCOP(\d+)\b', r'COP \1', s)
    s = re.sub(r'\$(\d+(?:\.\d+)?)\s*bn\b', r'\1 billion dollars', s, flags=re.I)
    s = re.sub(r'\$(\d+(?:\.\d+)?)\s*m\b', r'\1 million dollars', s, flags=re.I)
    s = re.sub(r'£(\d+(?:\.\d+)?)\s*bn\b', r'\1 billion pounds', s, flags=re.I)
    s = re.sub(r'£(\d+(?:\.\d+)?)\s*m\b', r'\1 million pounds', s, flags=re.I)
    s = re.sub(r'£(\d+(?:\.\d+)?)k\b', r'\1 thousand pounds', s, flags=re.I)
    s = re.sub(r'€(\d+(?:\.\d+)?)\s*bn\b', r'\1 billion euros', s, flags=re.I)
    s = re.sub(r'€(\d+(?:\.\d+)?)\s*m\b', r'\1 million euros', s, flags=re.I)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def story_script_parts(story):
    """Return [spoken_headline, spoken_para_0, spoken_para_1, ...]."""
    headline = prepare_spoken_text(story.get('headline', '')).rstrip('.!?') + '.'
    paras = [prepare_spoken_text(p) for p in (story.get('article') or []) if isinstance(p, str) and p.strip()]
    return [headline] + paras


def content_hash(provider, voice_id, parts, voice_cfg=None):
    h = hashlib.sha256()
    model = os.environ.get('PHEME_ELEVENLABS_MODEL', 'eleven_multilingual_v2') if provider == 'elevenlabs' else ''
    speaker = voice_cfg.get('elevenlabs', '') if voice_cfg and provider == 'elevenlabs' else ''
    h.update(f'v2|{provider}|{voice_id}|{speaker}|{model}|'.encode('utf-8'))
    for part in parts:
        h.update(part.encode('utf-8'))
        h.update(b'\n\n')
    return h.hexdigest()[:12]


def _norm_words(text):
    return re.findall(r'[a-z0-9]+', (text or '').lower())


def split_sentences(text, max_chars=300):
    """Split text into natural sentence chunks short enough for Kokoro-82M's phoneme window."""
    raw = re.split(r'(?<=[.!?])\s+', (text or '').strip())
    chunks = []
    for sent in raw:
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= max_chars:
            chunks.append(sent)
            continue
        # Soft-split very long sentences on clauses or word boundaries.
        parts = re.split(r'(?<=[,;:])\s+', sent)
        buf = ''
        for part in parts:
            if buf and len(buf) + 1 + len(part) > max_chars:
                chunks.append(buf)
                buf = part
            else:
                buf = f'{buf} {part}'.strip() if buf else part
        if buf:
            chunks.append(buf)
    return chunks


def align_paragraph_cues(parts, sentence_events, total_duration):
    """Map sentence boundary timestamps back to article paragraph indices (0..len(article)-1)."""
    para_count = max(0, len(parts) - 1)
    if para_count == 0:
        return []
    if not sentence_events:
        weights = [max(1, len(_norm_words(p))) for p in parts]
        total_w = sum(weights) or 1
        acc = weights[0]
        cues = []
        for w in weights[1:]:
            cues.append(round(total_duration * (acc / total_w), 2))
            acc += w
        return cues

    cues = [None] * para_count
    para_heads = [_norm_words(p)[:5] for p in parts[1:]]
    cursor = 1 if len(sentence_events) > 1 else 0
    for pidx, head_words in enumerate(para_heads):
        if not head_words:
            continue
        matched = None
        for idx in range(cursor, len(sentence_events)):
            ev_words = _norm_words(sentence_events[idx]['text'])
            if not ev_words:
                continue
            overlap = sum(1 for w in head_words[:4] if w in ev_words[:8])
            if overlap >= min(2, len(head_words)):
                matched = idx
                break
        if matched is not None:
            cues[pidx] = round(sentence_events[matched]['offset'], 2)
            cursor = matched + 1

    for i in range(para_count):
        if cues[i] is None:
            prev_t = cues[i - 1] if i > 0 and cues[i - 1] is not None else (
                round(sentence_events[0]['offset'] + sentence_events[0]['duration'], 2) if sentence_events else 0.0
            )
            next_t = next((cues[j] for j in range(i + 1, para_count) if cues[j] is not None), total_duration)
            cues[i] = round(prev_t + (next_t - prev_t) * 0.35, 2)
    return cues


def _download_atomic(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    req = urllib.request.Request(url, headers={'User-Agent': 'PhemeAudioBuilder/1.0'})
    with urllib.request.urlopen(req, timeout=180) as resp, tmp.open('wb') as out:
        shutil.copyfileobj(resp, out, length=1024 * 256)
    tmp.replace(dest)


def get_kokoro(cache_dir):
    """Lazily download and initialise self-hosted Kokoro-82M ONNX runtime."""
    global _kokoro_instance
    if _kokoro_instance is not None:
        return _kokoro_instance
    with _kokoro_lock:
        if _kokoro_instance is not None:
            return _kokoro_instance
        from kokoro_onnx import Kokoro

        model_dir = (cache_dir or (ROOT / '.audio-cache')) / 'kokoro'
        model_path = model_dir / 'kokoro-v1.0.onnx'
        voices_path = model_dir / 'voices-v1.0.bin'
        if not model_path.exists():
            print('Downloading Kokoro-82M ONNX weights for offline neural TTS fallback...', flush=True)
            _download_atomic(KOKORO_MODEL_URL, model_path)
        if not voices_path.exists():
            _download_atomic(KOKORO_VOICES_URL, voices_path)

        try:
            _kokoro_instance = Kokoro(str(model_path), str(voices_path))
        except Exception:
            from kokoro_onnx import EspeakConfig
            lib = next((p for p in ESPEAK_LIB_CANDIDATES if Path(p).exists()), None)
            if not lib:
                raise
            _kokoro_instance = Kokoro(str(model_path), str(voices_path), espeak_config=EspeakConfig(lib_path=lib))
        return _kokoro_instance


def encode_pcm_to_mp3(samples, sample_rate):
    """Encode float32 mono PCM array to a compact 48 kbps 24 kHz MP3 via ffmpeg."""
    import numpy as np

    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required to encode Kokoro-82M audio to MP3')
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype('<i2')
    wav_buf = io.BytesIO()
    with wave.open(wav_buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    proc = subprocess.run(
        [ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-b:a', '48k', '-ac', '1', '-ar', '24000', '-f', 'mp3', 'pipe:1'],
        input=wav_buf.getvalue(),
        capture_output=True,
        check=True,
    )
    if len(proc.stdout) < 1024:
        raise RuntimeError('Empty MP3 produced by ffmpeg')
    return proc.stdout


def synth_kokoro_sync(parts, voice_cfg, cache_dir):
    """Synthesise an entire article with self-hosted Kokoro-82M and exact paragraph cues."""
    import numpy as np

    kokoro = get_kokoro(cache_dir)
    voice_name = voice_cfg['kokoro']
    kokoro_lang = voice_cfg.get('kokoro_lang', 'en-us')
    segments = []
    cues = []
    sample_rate = 24000
    total_samples = 0

    for idx, part in enumerate(parts):
        if idx > 0:
            cues.append(round(total_samples / sample_rate, 2))
        part_chunks = split_sentences(part)
        for s_idx, chunk in enumerate(part_chunks):
            samples, sr = kokoro.create(chunk, voice=voice_name, speed=0.96, lang=kokoro_lang)
            sample_rate = int(sr)
            arr = np.asarray(samples, dtype=np.float32)
            segments.append(arr)
            total_samples += len(arr)
            if s_idx + 1 < len(part_chunks):
                pause = np.zeros(int(sample_rate * 0.14), dtype=np.float32)
                segments.append(pause)
                total_samples += len(pause)
        if idx + 1 < len(parts):
            gap_sec = 0.42 if idx == 0 else 0.32
            pause = np.zeros(int(sample_rate * gap_sec), dtype=np.float32)
            segments.append(pause)
            total_samples += len(pause)

    full_pcm = np.concatenate(segments) if segments else np.zeros(0, dtype=np.float32)
    mp3_bytes = encode_pcm_to_mp3(full_pcm, sample_rate)
    duration = round(total_samples / sample_rate, 2)
    return mp3_bytes, duration, cues


async def synth_edge(parts, voice_cfg):
    import edge_tts

    text = '\n\n'.join(parts)
    comm = edge_tts.Communicate(
        text,
        voice=voice_cfg['edge'],
        rate='-3%',
        boundary='SentenceBoundary',
    )
    audio = bytearray()
    events = []
    async for chunk in comm.stream():
        ctype = chunk.get('type')
        if ctype == 'audio':
            audio.extend(chunk['data'])
        elif ctype == 'SentenceBoundary':
            events.append({
                'offset': chunk['offset'] / 1e7,
                'duration': chunk['duration'] / 1e7,
                'text': chunk.get('text', ''),
            })
    if len(audio) < 1024:
        raise RuntimeError('Empty audio returned by edge-tts')
    est_dur = len(audio) / 6000.0
    if events:
        last = events[-1]
        duration = round(max(est_dur, last['offset'] + last['duration']), 2)
    else:
        duration = round(est_dur, 2)
    cues = align_paragraph_cues(parts, events, duration)
    return bytes(audio), duration, cues


def synth_openai_sync(parts, voice_cfg):
    key = os.environ['OPENAI_API_KEY']
    text = '\n\n'.join(parts)
    payload = json.dumps({
        'model': os.environ.get('PHEME_OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
        'voice': voice_cfg['openai'],
        'input': text,
        'instructions': OPENAI_INSTRUCTIONS,
        'response_format': 'mp3',
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://api.openai.com/v1/audio/speech',
        data=payload,
        headers={
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        audio = resp.read()
    if len(audio) < 1024:
        raise RuntimeError('Empty audio returned by OpenAI TTS')
    words = len(_norm_words(text))
    duration = round(max(5.0, words / 2.65), 2)
    cues = align_paragraph_cues(parts, [], duration)
    return audio, duration, cues


def synth_elevenlabs_sync(parts, voice_cfg):
    key = os.environ['ELEVENLABS_API_KEY']
    text = '\n\n'.join(parts)
    payload = json.dumps({
        'text': text,
        'model_id': os.environ.get('PHEME_ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
        'voice_settings': {'stability': 0.45, 'similarity_boost': 0.78, 'style': 0.25},
    }).encode('utf-8')
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_cfg['elevenlabs']}?output_format=mp3_22050_32",
        data=payload,
        headers={
            'xi-api-key': key,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        audio = resp.read()
    if len(audio) < 1024:
        raise RuntimeError('Empty audio returned by ElevenLabs')
    duration = round(len(audio) / 4000.0, 2)
    cues = align_paragraph_cues(parts, [], duration)
    return audio, duration, cues


def choose_provider():
    forced = os.environ.get('PHEME_TTS_PROVIDER', 'auto').strip().lower()
    if forced != 'auto':
        if forced not in ('elevenlabs', 'openai', 'edge', 'kokoro'):
            raise ValueError('Unknown PHEME_TTS_PROVIDER: ' + forced)
        if forced == 'elevenlabs' and not os.environ.get('ELEVENLABS_API_KEY'):
            raise ValueError('ElevenLabs requested but ELEVENLABS_API_KEY is missing. Add the GitHub Actions secret.')
        return forced
    if os.environ.get('ELEVENLABS_API_KEY'):
        return 'elevenlabs'
    if os.environ.get('OPENAI_API_KEY'):
        return 'openai'
    return 'edge'


def _try_cache(cache_dir, voice_id, story_id, digest, dest):
    if not cache_dir:
        return None
    cache_mp3 = cache_dir / f'{voice_id}-{story_id}-{digest}.mp3'
    cache_meta = cache_dir / f'{voice_id}-{story_id}-{digest}.json'
    if cache_mp3.exists() and cache_meta.exists():
        shutil.copy2(cache_mp3, dest)
        return json.loads(cache_meta.read_text())
    return None


def _save_cache(cache_dir, voice_id, story_id, digest, audio, duration, cues):
    if not cache_dir:
        return
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f'{voice_id}-{story_id}-{digest}.mp3').write_bytes(audio)
    (cache_dir / f'{voice_id}-{story_id}-{digest}.json').write_text(json.dumps({'duration': duration, 'cues': cues}))


async def generate_one(story, voice_cfg, provider, out_dir, cache_dir, sem, kokoro_sem):
    parts = story_script_parts(story)
    if len(parts) < 2:
        return None
    effective_provider = voice_cfg.get('free_provider', provider) if provider == 'edge' else provider
    digest = content_hash(effective_provider, voice_cfg['id'], parts, voice_cfg)
    rel_file = f"{voice_cfg['id']}/{story['id']}.mp3"
    dest = out_dir / rel_file
    dest.parent.mkdir(parents=True, exist_ok=True)

    cached_meta = _try_cache(cache_dir, voice_cfg['id'], story['id'], digest, dest)
    if cached_meta:
        return {
            'story_id': story['id'],
            'voice_id': voice_cfg['id'],
            'hash': digest,
            'file': rel_file,
            'duration': cached_meta['duration'],
            'cues': cached_meta['cues'],
            'cached': True,
            'provider': effective_provider,
        }

    # Try primary provider first.
    last_err = None
    if effective_provider != 'kokoro':
        async with sem:
            for attempt in range(1, 4):
                try:
                    if effective_provider == 'openai':
                        audio, duration, cues = await asyncio.to_thread(synth_openai_sync, parts, voice_cfg)
                    elif effective_provider == 'elevenlabs':
                        audio, duration, cues = await asyncio.to_thread(synth_elevenlabs_sync, parts, voice_cfg)
                    else:
                        audio, duration, cues = await synth_edge(parts, voice_cfg)
                    dest.write_bytes(audio)
                    _save_cache(cache_dir, voice_cfg['id'], story['id'], digest, audio, duration, cues)
                    return {
                        'story_id': story['id'],
                        'voice_id': voice_cfg['id'],
                        'hash': digest,
                        'file': rel_file,
                        'duration': duration,
                        'cues': cues,
                        'cached': False,
                        'provider': effective_provider,
                    }
                except Exception as err:
                    last_err = err
                    if attempt < 3:
                        await asyncio.sleep(1.5 * attempt)

    # Explicit ElevenLabs production mode must never serve a different voice engine.
    # On a provider error, leave the track unavailable rather than silently
    # substituting Kokoro under the same voice label.
    if effective_provider == 'elevenlabs' and os.environ.get('PHEME_TTS_STRICT') == '1':
        print(f"ElevenLabs audio unavailable: {story['id']} ({voice_cfg['id']}): "
              f"{type(last_err).__name__ if last_err else 'unknown'}", file=sys.stderr)
        return None

    # Self-hosted Kokoro-82M: either selected for this voice or automatic offline fallback.
    fallback_digest = content_hash('kokoro', voice_cfg['id'], parts, voice_cfg)
    cached_fallback = _try_cache(cache_dir, voice_cfg['id'], story['id'], fallback_digest, dest)
    if cached_fallback:
        return {
            'story_id': story['id'],
            'voice_id': voice_cfg['id'],
            'hash': fallback_digest,
            'file': rel_file,
            'duration': cached_fallback['duration'],
            'cues': cached_fallback['cues'],
            'cached': True,
            'provider': 'kokoro',
        }
    async with kokoro_sem:
        try:
            audio, duration, cues = await asyncio.to_thread(synth_kokoro_sync, parts, voice_cfg, cache_dir)
            dest.write_bytes(audio)
            _save_cache(cache_dir, voice_cfg['id'], story['id'], fallback_digest, audio, duration, cues)
            if effective_provider != 'kokoro':
                print(f"Kokoro-82M fallback rescued {story['id']} ({voice_cfg['id']}) after {type(last_err).__name__}.", flush=True)
            return {
                'story_id': story['id'],
                'voice_id': voice_cfg['id'],
                'hash': fallback_digest,
                'file': rel_file,
                'duration': duration,
                'cues': cues,
                'cached': False,
                'provider': 'kokoro',
            }
        except Exception as fallback_err:
            print(
                f"Audio skipped for {story['id']} ({voice_cfg['id']}): "
                f"primary={type(last_err).__name__ if last_err else 'none'}, "
                f"kokoro={type(fallback_err).__name__}: {fallback_err}",
                file=sys.stderr,
            )
            return None


async def build_all(edition_path, out_dir, cache_dir, voice_ids, concurrency):
    edition = json.loads(edition_path.read_text())
    provider = choose_provider()
    selected_voices = [v for v in VOICES if v['id'] in voice_ids]
    sem = asyncio.Semaphore(concurrency)
    # Limit CPU-bound ONNX inference concurrency to keep memory and CPU throughput optimal.
    kokoro_sem = asyncio.Semaphore(2)
    needs_kokoro = provider == 'kokoro' or (provider == 'edge' and any(v.get('free_provider') == 'kokoro' for v in selected_voices))
    if needs_kokoro:
        await asyncio.to_thread(get_kokoro, cache_dir)
    tasks = [
        generate_one(story, v, provider, out_dir, cache_dir, sem, kokoro_sem)
        for story in edition['STORIES']
        for v in selected_voices
    ]
    results = await asyncio.gather(*tasks)

    stories_map = {}
    cached_count = 0
    fresh_count = 0
    kokoro_count = 0
    for item in results:
        if not item:
            continue
        if item['cached']:
            cached_count += 1
        else:
            fresh_count += 1
        if item['provider'] == 'kokoro':
            kokoro_count += 1
        entry = stories_map.setdefault(item['story_id'], {'hash': item['hash'], 'voices': {}})
        entry['voices'][item['voice_id']] = {
            'file': item['file'],
            'duration': item['duration'],
            'cues': item['cues'],
            'hash': item['hash'],
            'provider': item['provider'],
        }

    manifest = {
        'version': 1,
        'provider': provider,
        'fallback': 'disabled' if provider == 'elevenlabs' and os.environ.get('PHEME_TTS_STRICT') == '1' else 'kokoro',
        'voices': [{'id': v['id'], 'label': v['label'], 'accent': v.get('accent', ''), 'tagline': v['tagline']} for v in selected_voices],
        'stories': stories_map,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n')
    total_expected = len(edition['STORIES']) * len(selected_voices)
    extra = f', {kokoro_count} via kokoro-82m' if kokoro_count else ''
    print(
        f"Built audio ({provider}): {fresh_count} generated, {cached_count} cached{extra}, "
        f"{len(stories_map)}/{len(edition['STORIES'])} stories ready ({fresh_count + cached_count}/{total_expected} tracks).",
        flush=True,
    )
    if provider == 'elevenlabs' and os.environ.get('PHEME_TTS_STRICT') == '1' and (fresh_count + cached_count) != total_expected:
        print('::warning::Some ElevenLabs recordings failed; they will not be substituted with a different provider.', file=sys.stderr)
    return 0 if stories_map else 1


def latest_edition():
    files = sorted((ROOT / 'editions').glob('*.json'))
    if not files:
        raise FileNotFoundError('No editions/*.json found.')
    return files[-1]


def main():
    parser = argparse.ArgumentParser(description='Generate conversational neural audio for Pheme.')
    parser.add_argument('--edition', type=Path, default=None, help='Edition JSON path (default: latest)')
    parser.add_argument('--out', type=Path, default=ROOT / 'build' / 'site' / 'assets' / 'audio')
    parser.add_argument('--cache', type=Path, default=ROOT / '.audio-cache')
    parser.add_argument('--voices', default=','.join(v['id'] for v in VOICES), help='Comma-separated voice IDs')
    parser.add_argument('--concurrency', type=int, default=8)
    args = parser.parse_args()

    edition_path = args.edition or latest_edition()
    voice_ids = [v.strip() for v in args.voices.split(',') if v.strip()]
    return asyncio.run(build_all(edition_path, args.out, args.cache, voice_ids, max(1, args.concurrency)))


if __name__ == '__main__':
    sys.exit(main())
