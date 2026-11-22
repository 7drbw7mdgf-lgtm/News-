"""Generate natural conversational neural audio narration for Pheme stories.

Produces compact MP3 narration files and a manifest.json with per-paragraph
timing cues so the native Pheme reader plays warm, human-sounding speech
instead of robotic browser speechSynthesis.

Providers (selected automatically or via PHEME_TTS_PROVIDER):
- OpenAI gpt-4o-mini-tts (when OPENAI_API_KEY is set)
- ElevenLabs (when ELEVENLABS_API_KEY is set)
- Microsoft Edge Neural conversational voices via edge-tts (default, zero-key)
"""
import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

VOICES = [
    {
        'id': 'ava',
        'label': 'Ava',
        'tagline': 'Warm & expressive',
        'edge': 'en-US-AvaMultilingualNeural',
        'openai': 'coral',
        'elevenlabs': 'EXAVITQu4vr4xnSDxMaL',
    },
    {
        'id': 'andrew',
        'label': 'Andrew',
        'tagline': 'Calm & conversational',
        'edge': 'en-US-AndrewMultilingualNeural',
        'openai': 'ash',
        'elevenlabs': 'TxGEqnHWrfWFTfGW9XjX',
    },
]

OPENAI_INSTRUCTIONS = (
    'Speak like a warm, thoughtful human briefing host on Sesame. '
    'Use a relaxed, natural conversational cadence with gentle warmth, clear phrasing, '
    'and brief natural breaths between paragraphs. Never sound robotic, stiff, or like a news anchor.'
)


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


def content_hash(provider, voice_id, parts):
    h = hashlib.sha256()
    h.update(f'v1|{provider}|{voice_id}|'.encode('utf-8'))
    for part in parts:
        h.update(part.encode('utf-8'))
        h.update(b'\n\n')
    return h.hexdigest()[:12]


def _norm_words(text):
    return re.findall(r'[a-z0-9]+', (text or '').lower())


def align_paragraph_cues(parts, sentence_events, total_duration):
    """Map sentence boundary timestamps back to article paragraph indices (0..len(article)-1)."""
    para_count = max(0, len(parts) - 1)
    if para_count == 0:
        return []
    if not sentence_events:
        # Proportional estimate fallback when provider does not emit timing cues.
        weights = [max(1, len(_norm_words(p))) for p in parts]
        total_w = sum(weights) or 1
        acc = weights[0]
        cues = []
        for w in weights[1:]:
            cues.append(round(total_duration * (acc / total_w), 2))
            acc += w
        return cues

    # Walk sentence events sequentially and detect the start of each paragraph.
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

    # Fill any unmatched paragraph cues cleanly by interpolation.
    for i in range(para_count):
        if cues[i] is None:
            prev_t = cues[i - 1] if i > 0 and cues[i - 1] is not None else (
                round(sentence_events[0]['offset'] + sentence_events[0]['duration'], 2) if sentence_events else 0.0
            )
            next_t = next((cues[j] for j in range(i + 1, para_count) if cues[j] is not None), total_duration)
            cues[i] = round(prev_t + (next_t - prev_t) * 0.35, 2)
    return cues


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
    # Edge outputs 24kHz 48kbps CBR MP3 (~6000 bytes/sec). Prefer boundary end if available.
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
    # OpenAI MP3 is typically 160kbps (~20000 bytes/sec) or 128kbps; word-rate estimate is safer for cues.
    words = len(_norm_words(text))
    duration = round(max(5.0, words / 2.65), 2)
    cues = align_paragraph_cues(parts, [], duration)
    return audio, duration, cues


def synth_elevenlabs_sync(parts, voice_cfg):
    key = os.environ['ELEVENLABS_API_KEY']
    text = '\n\n'.join(parts)
    payload = json.dumps({
        'text': text,
        'model_id': os.environ.get('PHEME_ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
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
        return forced
    if os.environ.get('ELEVENLABS_API_KEY'):
        return 'elevenlabs'
    if os.environ.get('OPENAI_API_KEY'):
        return 'openai'
    return 'edge'


async def generate_one(story, voice_cfg, provider, out_dir, cache_dir, sem):
    parts = story_script_parts(story)
    if len(parts) < 2:
        return None
    digest = content_hash(provider, voice_cfg['id'], parts)
    rel_file = f"{voice_cfg['id']}/{story['id']}.mp3"
    dest = out_dir / rel_file
    dest.parent.mkdir(parents=True, exist_ok=True)

    cache_mp3 = cache_dir / f"{voice_cfg['id']}-{story['id']}-{digest}.mp3" if cache_dir else None
    cache_meta = cache_dir / f"{voice_cfg['id']}-{story['id']}-{digest}.json" if cache_dir else None

    if cache_mp3 and cache_meta and cache_mp3.exists() and cache_meta.exists():
        shutil.copy2(cache_mp3, dest)
        meta = json.loads(cache_meta.read_text())
        return {
            'story_id': story['id'],
            'voice_id': voice_cfg['id'],
            'hash': digest,
            'file': rel_file,
            'duration': meta['duration'],
            'cues': meta['cues'],
            'cached': True,
        }

    async with sem:
        last_err = None
        for attempt in range(1, 4):
            try:
                if provider == 'openai':
                    audio, duration, cues = await asyncio.to_thread(synth_openai_sync, parts, voice_cfg)
                elif provider == 'elevenlabs':
                    audio, duration, cues = await asyncio.to_thread(synth_elevenlabs_sync, parts, voice_cfg)
                else:
                    audio, duration, cues = await synth_edge(parts, voice_cfg)
                dest.write_bytes(audio)
                if cache_mp3 and cache_meta:
                    cache_dir.mkdir(parents=True, exist_ok=True)
                    cache_mp3.write_bytes(audio)
                    cache_meta.write_text(json.dumps({'duration': duration, 'cues': cues}))
                return {
                    'story_id': story['id'],
                    'voice_id': voice_cfg['id'],
                    'hash': digest,
                    'file': rel_file,
                    'duration': duration,
                    'cues': cues,
                    'cached': False,
                }
            except Exception as err:
                last_err = err
                if attempt < 3:
                    await asyncio.sleep(1.5 * attempt)
        print(f"Audio skipped for {story['id']} ({voice_cfg['id']}): {type(last_err).__name__}: {last_err}", file=sys.stderr)
        return None


async def build_all(edition_path, out_dir, cache_dir, voice_ids, concurrency):
    edition = json.loads(edition_path.read_text())
    provider = choose_provider()
    selected_voices = [v for v in VOICES if v['id'] in voice_ids]
    sem = asyncio.Semaphore(concurrency)
    tasks = [
        generate_one(story, v, provider, out_dir, cache_dir, sem)
        for story in edition['STORIES']
        for v in selected_voices
    ]
    results = await asyncio.gather(*tasks)

    stories_map = {}
    cached_count = 0
    fresh_count = 0
    for item in results:
        if not item:
            continue
        if item['cached']:
            cached_count += 1
        else:
            fresh_count += 1
        entry = stories_map.setdefault(item['story_id'], {'hash': item['hash'], 'voices': {}})
        entry['voices'][item['voice_id']] = {
            'file': item['file'],
            'duration': item['duration'],
            'cues': item['cues'],
            'hash': item['hash'],
        }

    manifest = {
        'version': 1,
        'provider': provider,
        'voices': [{'id': v['id'], 'label': v['label'], 'tagline': v['tagline']} for v in selected_voices],
        'stories': stories_map,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n')
    total_expected = len(edition['STORIES']) * len(selected_voices)
    print(
        f"Built audio ({provider}): {fresh_count} generated, {cached_count} cached, "
        f"{len(stories_map)}/{len(edition['STORIES'])} stories ready ({fresh_count + cached_count}/{total_expected} tracks).",
        flush=True,
    )
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
    parser.add_argument('--voices', default='ava,andrew', help='Comma-separated voice IDs')
    parser.add_argument('--concurrency', type=int, default=8)
    args = parser.parse_args()

    edition_path = args.edition or latest_edition()
    voice_ids = [v.strip() for v in args.voices.split(',') if v.strip()]
    return asyncio.run(build_all(edition_path, args.out, args.cache, voice_ids, max(1, args.concurrency)))


if __name__ == '__main__':
    sys.exit(main())
