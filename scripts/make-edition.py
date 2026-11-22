"""Turn the collected articles into today's Pheme edition, automatically.

Input:  candidates.json from scripts/collect-feeds.py (articles from the last 2 days).
Output: editions/YYYY-MM-DD.json in the same format as the hand-built editions,
        then scripts/build-editions.mjs regenerates assets/data.js.

Steps
1. Group articles about the same event (TF-IDF cosine similarity on headline
   and description, greedy clustering against cluster centroids).
2. Keep events reported by at least MIN_OUTLETS different outlets.
3. Rate every outlet with Media Bias/Fact Check (scripts/ratings.py).
4. Rank events by how many outlets covered them, how recent they are and how
   much of the political spectrum covered them; pick a balanced set per topic.
5. Write each story. If ANTHROPIC_API_KEY is set, Claude writes an original,
   neutral headline, summary, key points, a place for the map and a comparison
   of where outlets agree or differ, using only the collected headlines and
   descriptions. Without a key, the lead outlet's headline is shown with
   attribution and the summary lists who covered it; no publisher text is copied.
"""
import datetime
import json
import math
import os
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ratings  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LONDON = ZoneInfo('Europe/London')
MIN_OUTLETS = 3
SIMILARITY = 0.30
QUOTA = {'world': 12, 'uk': 8, 'science': 6, 'tech': 6, 'business': 5, 'finance': 5}
TOTAL = sum(QUOTA.values())
MODEL = os.environ.get('PHEME_MODEL', 'claude-sonnet-5-5')
LEFT, RIGHT = {'L', 'LL'}, {'LR', 'R'}

STOP = set('''a an and are as at be been but by for from has have he her his i in into is it its of on or our she so than that the their them they this to was were will with you your not no new says said say after over about more most up out who what when where which why how all can could would should may might just also one two three first last year years week day days today news live update updates latest report reports via amid against new us uk vs its it's s'''.split())


def tokens(text):
    words = re.findall(r"[a-z0-9][a-z0-9'’-]*", text.lower())
    out = []
    for w in words:
        w = w.strip("'’-")
        if len(w) < 3 or w in STOP or w.isdigit() and len(w) < 4:
            continue
        if len(w) > 4 and w.endswith('s') and not w.endswith('ss'):
            w = w[:-1]
        out.append(w)
    return out


def vectorise(articles):
    docs = []
    for a in articles:
        tf = Counter()
        for t in tokens(a['title']):
            tf[t] += 2
        for t in tokens(a.get('summary', ''))[:60]:
            tf[t] += 1
        docs.append(tf)
    df = Counter(t for d in docs for t in d)
    n = len(docs)
    vecs = []
    for d in docs:
        v = {t: c * math.log((1 + n) / (1 + df[t])) for t, c in d.items() if df[t] < n * 0.05}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({t: x / norm for t, x in v.items()})
    return vecs


def cosine(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0.0) for t, x in a.items())


def cluster(articles):
    vecs = vectorise(articles)
    order = sorted(range(len(articles)), key=lambda i: articles[i]['published'], reverse=True)
    clusters = []          # each: {'members': [...], 'sum': {}, 'centroid': {}}
    index = defaultdict(set)
    for i in order:
        v = vecs[i]
        if not v:
            continue
        top = sorted(v, key=v.get, reverse=True)[:8]
        cands = set()
        for t in top:
            cands |= index[t]
        best, best_sim = None, 0.0
        for c in cands:
            sim = cosine(v, clusters[c]['centroid'])
            if sim > best_sim:
                best, best_sim = c, sim
        if best is not None and best_sim >= SIMILARITY:
            c = clusters[best]
            c['members'].append(i)
            for t, x in v.items():
                c['sum'][t] = c['sum'].get(t, 0.0) + x
            norm = math.sqrt(sum(x * x for x in c['sum'].values())) or 1.0
            c['centroid'] = {t: x / norm for t, x in c['sum'].items()}
            for t in top:
                index[t].add(best)
        else:
            clusters.append({'members': [i], 'sum': dict(v), 'centroid': dict(v)})
            for t in top:
                index[t].add(len(clusters) - 1)
    return [[articles[i] for i in c['members']] for c in clusters]


def slug(text, taken):
    words = [w for w in re.findall(r'[a-z0-9]+', text.lower().replace('’', '').replace("'", '')) if w not in STOP][:7]
    base = '-'.join(words) or 'story'
    if '-' not in base:
        base += '-story'
    s, n = base, 2
    while s in taken:
        s, n = base + '-' + str(n), n + 1
    taken.add(s)
    return s


def day_label(iso):
    d = datetime.datetime.fromisoformat(iso).astimezone(LONDON)
    return f'{d.day} {d:%b}'


def build_events(articles):
    events = []
    for members in cluster(articles):
        by_outlet = {}
        for a in sorted(members, key=lambda a: a['published']):
            by_outlet.setdefault(a['outlet'], a)
        if len(by_outlet) < MIN_OUTLETS:
            continue
        rated = {o: ratings.rate(o, [a['url'], a.get('feed', '')]) for o, a in by_outlet.items()}
        topic = Counter(a['topic'] for a in by_outlet.values()).most_common(1)[0][0]
        codes = [r['code'] for r in rated.values()]
        newest = max(a['published'] for a in members)
        age_h = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(newest)).total_seconds() / 3600
        spread = len({'left' if c in LEFT else 'right' if c in RIGHT else 'centre' if c == 'C' else None for c in codes} - {None})
        score = len(by_outlet) * (1 + 0.25 * spread) * math.exp(-max(age_h, 0) / 36)
        events.append({'topic': topic, 'outlets': by_outlet, 'ratings': rated, 'score': score, 'newest': newest})
    return sorted(events, key=lambda e: e['score'], reverse=True)


def choose(events):
    picked, per = [], Counter()
    for e in events:
        if per[e['topic']] < QUOTA.get(e['topic'], 0):
            picked.append(e)
            per[e['topic']] += 1
    for e in events:  # fill any empty topic slots with the next strongest stories
        if len(picked) >= TOTAL:
            break
        if e not in picked:
            picked.append(e)
    return sorted(picked, key=lambda e: e['score'], reverse=True)


def lead_article(e):
    good = [(a['published'], o) for o, a in e['outlets'].items()
            if e['ratings'][o]['code'] in {'L', 'LL', 'C', 'LR', 'R', 'S'} and not e['ratings'][o]['questionable']]
    pool = good or [(a['published'], o) for o, a in e['outlets'].items()]
    return min(pool)[1]


# ---------- writing ----------

PROMPT = """You write stories for Pheme, a neutral news briefing that compares how outlets cover the same event.
Below are headlines and short descriptions from several outlets about what should be ONE news event.
Using ONLY this material (no outside knowledge), return a JSON object with:
- "same_event": true if these mostly describe one event, else false
- "headline": a neutral headline in your own words, at most 90 characters, no quotation marks from outlets
- "summary": one or two sentences in your own words, at most 45 words
- "points": three short factual key points in your own words, each at most 30 words
- "digest": a one-line version for a daily digest, at most 18 words
- "location": the main place the event happened as {{"label": "City, Country", "shortLabel": "City", "lat": number, "lng": number}}, or null if not one place
- "agree": up to 2 points that most outlets agree on, each {{"text": "...", "sources": [outlet names exactly as given]}}
- "differ": up to 2 points where outlets differ in facts or framing, each {{"text": "...", "sources": [outlet names]}}; empty if none
Never copy a sentence from an outlet; paraphrase. Do not speculate. Reply with the JSON only.

Material:
{material}"""


def ask_claude(e):
    key = os.environ.get('ANTHROPIC_API_KEY')
    if not key:
        return None
    lines = []
    for o, a in sorted(e['outlets'].items(), key=lambda x: x[1]['published'])[:14]:
        lines.append(f"- {o} ({day_label(a['published'])}): {a['title']} — {a.get('summary', '')[:300]}")
    body = json.dumps({
        'model': MODEL, 'max_tokens': 900,
        'messages': [{'role': 'user', 'content': PROMPT.format(material='\n'.join(lines))}],
    }).encode()
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=body, headers={
        'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            text = ''.join(b.get('text', '') for b in json.loads(resp.read())['content'])
        data = json.loads(text[text.index('{'): text.rindex('}') + 1])
    except Exception as error:  # fall back to the factual template
        print('Story writer unavailable for one story (' + type(error).__name__ + ').', file=sys.stderr)
        return None
    if not data.get('same_event', True):
        return {'reject': True}
    return data


def coverage_line(e):
    counts = Counter(r['code'] for r in e['ratings'].values())
    left = counts['L'] + counts['LL']
    right = counts['LR'] + counts['R']
    parts = []
    if left:
        parts.append(f'{left} left-leaning')
    if counts['C']:
        parts.append(f"{counts['C']} centre")
    if right:
        parts.append(f'{right} right-leaning')
    other = len(e['outlets']) - left - right - counts['C']
    if other:
        parts.append(f'{other} other or unrated')
    return 'Coverage: ' + ', '.join(parts) + '.'


def write_story(e, taken):
    lead = lead_article(e)
    la = e['outlets'][lead]
    names = sorted(e['outlets'], key=lambda o: e['outlets'][o]['published'])
    first = names[0]
    gen = ask_claude(e)
    if gen and gen.get('reject'):
        return None
    if gen and gen.get('headline') and gen.get('summary'):
        headline = gen['headline'].strip()[:110]
        summary = gen['summary'].strip()
        points = [p.strip() for p in gen.get('points', []) if isinstance(p, str) and p.strip()][:3]
        digest = (gen.get('digest') or headline).strip()
    else:
        headline = la['title']
        others = [o for o in names if o != lead][:3]
        summary = f"Reported by {len(names)} outlets, including {', '.join(others[:-1]) + ' and ' + others[-1] if len(others) > 1 else others[0]}."
        points = [f'First reported by {first} on {day_label(e["outlets"][first]["published"])}.', coverage_line(e),
                  'Open each outlet’s report below to compare their headlines and framing.']
        digest = f'{headline} ({lead})'
        gen = {}
    story = {
        'id': slug(headline, taken), 'topic': e['topic'], 'source': lead,
        'time': day_label(la['published']), 'url': la['url'], 'headline': headline,
        'summary': summary, 'points': points or [coverage_line(e)],
        'publishedLabel': datetime.datetime.fromisoformat(la['published']).astimezone(LONDON).strftime('%-d %b %Y'),
    }
    loc = gen.get('location')
    if isinstance(loc, dict):
        try:
            lat, lng = float(loc['lat']), float(loc['lng'])
            if abs(lat) <= 85 and abs(lng) <= 180 and str(loc.get('label', '')).strip():
                story['location'] = {'label': str(loc['label']).strip(), 'shortLabel': str(loc.get('shortLabel') or loc['label']).split(',')[0].strip(), 'lat': lat, 'lng': lng}
        except (KeyError, TypeError, ValueError):
            pass
    comparison = []
    for label, key in (('What outlets agree on', 'agree'), ('Where reports differ', 'differ')):
        pts = []
        for p in gen.get(key) or []:
            if isinstance(p, dict) and p.get('text'):
                srcs = [s for s in p.get('sources', []) if s in e['outlets']]
                if srcs:
                    pts.append({'text': str(p['text']).strip(), 'sources': srcs})
        if pts:
            comparison.append({'label': label, 'points': pts})
    if comparison:
        story['comparison'] = comparison
    coverage = [[o, day_label(e['outlets'][o]['published']), e['outlets'][o]['url']] for o in names]
    return story, coverage, digest


def reuse_ids(stories, coverage, previous):
    """Keep yesterday's ID when a story continues (shares two links or the lead link)."""
    prev_urls = {sid: {row[2] for row in rows} for sid, rows in previous.get('COVERAGE', {}).items()}
    used = set()
    for s in stories:
        urls = {row[2] for row in coverage[s['id']]}
        for sid, purls in prev_urls.items():
            if sid not in used and (len(urls & purls) >= 2 or s['url'] in purls):
                coverage[sid] = coverage.pop(s['id'])
                s['id'] = sid
                used.add(sid)
                break


def main():
    data = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else 'candidates.json').read_text())
    articles = [a for group in data['candidateGroups'] for a in group]
    feed_of = {f['outlet']: f['url'] for f in json.loads((ROOT / 'feeds' / 'feeds.json').read_text())}
    for a in articles:
        a['feed'] = feed_of.get(a['outlet'], '')
    events = build_events(articles)
    print(f'{len(articles)} articles → {len(events)} events covered by {MIN_OUTLETS}+ outlets', file=sys.stderr)
    editions = sorted((ROOT / 'editions').glob('*.json'))
    previous = json.loads(editions[-1].read_text()) if editions else {}
    taken, stories, coverage, digests, outlets, questionable = set(), [], {}, [], {}, set()
    for e in choose(events):
        written = write_story(e, taken)
        if not written:
            continue
        story, cov, digest = written
        stories.append(story)
        coverage[story['id']] = cov
        digests.append(digest)
        for o, r in e['ratings'].items():
            outlets[o] = r['code']
            if r['questionable']:
                questionable.add(o)
    if len(stories) < int(os.environ.get('PHEME_MIN_STORIES', '8')):
        print('Too few multi-outlet stories; keeping the previous edition.', file=sys.stderr)
        return 1
    reuse_ids(stories, coverage, previous)
    now = datetime.datetime.now(LONDON)
    pub = sorted(datetime.datetime.fromisoformat(a['published']).astimezone(LONDON)
                 for e in events for a in e['outlets'].values())
    start, end = (pub[0], pub[-1]) if pub else (now, now)
    rng = f'{start.day}–{end.day} {end:%b}' if start.month == end.month else f'{start.day} {start:%b}–{end.day} {end:%b}'
    edition = {k: previous[k] for k in ('TOPICS', 'CATS', 'CATALOG', 'LEAN', 'FOLLOWED') if k in previous}
    lean = dict(edition.get('LEAN', {}))
    lean.setdefault('P', ['Primary', 'Primary source, not a news outlet'])
    edition['LEAN'] = lean
    merged = dict(previous.get('OUTLETS', {}))
    merged.update(outlets)
    edition.update({
        'STORIES': stories,
        'OUTLETS': merged,
        'QUESTIONABLE': sorted(questionable | set(previous.get('QUESTIONABLE', []))),
        'COVERAGE': coverage,
        'META': {
            'editionId': now.strftime('%Y-%m-%d'),
            'dateLabel': now.strftime('%A %-d %B %Y'),
            'range': rng,
            'rangeLong': rng.replace(f'{end:%b}', f'{end:%B} {end.year}'),
            'lastRun': now.strftime('%-d %b %Y, %H:%M'),
            'digest': digests[:4],
            'generated': 'automatic',
            'writer': 'claude' if os.environ.get('ANTHROPIC_API_KEY') else 'template',
        },
        'LEGACY_IDS': {},
    })
    out = ROOT / 'editions' / (now.strftime('%Y-%m-%d') + '.json')
    out.write_text(json.dumps(edition, ensure_ascii=False, indent=1) + '\n')
    by_topic = Counter(s['topic'] for s in stories)
    print(f'Wrote {out.name}: {len(stories)} stories {dict(by_topic)}; {len(outlets)} outlets in coverage.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
