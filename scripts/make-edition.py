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
from native_articles import article_is_ready, apply_editorial  # noqa: E402
from story_images import enrich_stories  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LONDON = ZoneInfo('Europe/London')
MIN_OUTLETS = 3
SIMILARITY = 0.30
MERGE = 0.50
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
    # Second pass: merge fragments of the same event whose centroids are close.
    merged = True
    while merged:
        merged = False
        big = [i for i, c in enumerate(clusters) if len(c['members']) >= 2]
        for x in range(len(big)):
            a = clusters[big[x]]
            if not a['members']:
                continue
            for y in range(x + 1, len(big)):
                b = clusters[big[y]]
                if b['members'] and cosine(a['centroid'], b['centroid']) >= MERGE:
                    a['members'] += b['members']
                    for t, v in b['sum'].items():
                        a['sum'][t] = a['sum'].get(t, 0.0) + v
                    norm = math.sqrt(sum(v * v for v in a['sum'].values())) or 1.0
                    a['centroid'] = {t: v / norm for t, v in a['sum'].items()}
                    b['members'] = []
                    merged = True
        clusters = [c for c in clusters if c['members']]
    out = []
    for c in clusters:
        group = []
        for i in c['members']:
            a = dict(articles[i])
            a['typicality'] = cosine(vecs[i], c['centroid'])
            group.append(a)
        out.append(group)
    return out


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


NOT_NEWS = re.compile(r"\b(lotto|lottery|euromillions|thunderball|horoscope|black friday|cyber monday|best .* deals?|price drops?|discount(ed)?|coupon|crossword|wordle|quordle)\b", re.I)
SPORT = re.compile(r"premier league|champions league|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|how to watch|team news|predicted line-?up|kick-?off time|start time tonight|live stream|\bvs\.? \w+.*(live|score|result)|strictly come dancing|i'?m a celebrity|\bf1\b|grand prix|six nations|ashes|wimbledon", re.I)
SPORT_URL = re.compile(r"/(sport|sports|football|soccer|rugby|rugby-union|rugby-league|cricket|tennis|golf|f1|formula-?1|motorsport|boxing|nfl|nba|mlb|nhl|cycling|athletics|olympics)(/|-)", re.I)
CULTURE_URL = re.compile(r"/(culture|entertainment|film|films|movies|tv|tv-and-radio|television|music|celebrity|showbiz|tvshowbiz|lifestyle|style|fashion|travel|food|recipes|shopping|deals|reviews?|horoscopes?)(/|-)", re.I)
OPINION_URL = re.compile(r"/(opinion|opinions|comment|commentisfree|columnists?|editorials?|letters|analysis/opinion)(/|-)", re.I)
URL_TOPIC = [
    (re.compile(r"/(uk-news|uk|politics|scotland|wales|northern-ireland|england)(/|-)", re.I), 'uk'),
    (re.compile(r"/(money|markets|personal-finance|investing|your-money|stocks|crypto)(/|-)", re.I), 'finance'),
    (re.compile(r"/(business|economy|economics|companies)(/|-)", re.I), 'business'),
    (re.compile(r"/(technology|tech|science-and-technology|gadgets|ai)(/|-)", re.I), 'tech'),
    (re.compile(r"/(science|environment|health|space|climate)(/|-)", re.I), 'science'),
    (re.compile(r"/(world|international|global|us-news|europe|asia|africa|middle-east|americas)(/|-)", re.I), 'world'),
]
KEYWORDS = {
    'finance': r"stocks?|shares|markets?|investors?|inflation|interest rates?|bonds?|crypto|bitcoin|dow|nasdaq|s&p|ftse|wall street|treasury yields?|central bank|fed\b|ecb\b|mortgage",
    'business': r"compan(y|ies)|merger|acquisition|ceo|profits?|revenue|layoffs?|job cuts|retail(er)?s?|ipo|settlement|tariffs?|trade deal|factory|airline|oil prices?",
    'tech': r"\bai\b|artificial intelligence|apple|google|microsoft|nvidia|openai|anthropic|chips?|semiconductor|software|iphone|android|cyber|hack(ed|ers?)?|video game|gta|grand theft auto|startup|robot",
    'science': r"scientists?|researchers?|study|nasa|esa\b|space(craft)?|telescope|astronom|species|fossil|physics|vaccine|virus|bacteri|disease|cancer|climate|cop\d\d|mercury|mars\b|moon\b|quantum|mathematic",
    'uk': r"\buk\b|britain|british|england|scotland|wales|welsh|northern ireland|london|starmer|reeves|badenoch|farage|labour|tor(y|ies)|conservatives|nhs\b|ofsted|councillor|westminster|princess of wales|prince william|king charles|bbc licence",
}


def classify(members, votes):
    text = ' '.join(a['title'] for a in members).lower()
    n = sum(votes.values()) or 1
    score = {t: votes.get(t, 0) / n for t in QUOTA}
    for a in members:
        for pattern, t in URL_TOPIC:
            if pattern.search(a['url']):
                score[t] += 0.6 / len(members)
                break
    for t, pattern in KEYWORDS.items():
        hits = len(re.findall(pattern, text))
        score[t] += (0.2 if t == 'uk' else 0.12) * min(hits / max(len(members), 1) * 3, 3)
    return max(score, key=score.get)


def build_events(articles):
    events = []
    for members in cluster(articles):
        by_outlet = {}
        for a in sorted(members, key=lambda a: a['published']):
            by_outlet.setdefault(a['outlet'], a)
        if len(by_outlet) < MIN_OUTLETS:
            continue
        n = len(members)
        if sum(1 for a in members if SPORT.search(a['title']) or SPORT_URL.search(a['url'])) >= 0.4 * n:
            continue  # Pheme has no sport section
        if sum(1 for a in members if NOT_NEWS.search(a['title'])) >= 0.4 * n:
            continue  # lotteries, shopping deals, puzzles
        if sum(1 for a in members if OPINION_URL.search(a['url'])) >= 0.5 * n:
            continue  # opinion pieces, not a news event
        if len(by_outlet) < 15 and sum(1 for a in members if CULTURE_URL.search(a['url'])) >= 0.5 * n:
            continue  # arts and entertainment, unless it is a very big story
        rated = {o: ratings.rate(o, [a['url'], a.get('feed', '')]) for o, a in by_outlet.items()}
        topic = classify(members, Counter(a['topic'] for a in by_outlet.values()))
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


FOLLOWED = set()


def lead_article(e):
    """The outlet whose headline best represents the story, preferring well-known outlets."""
    def rank(o):
        r = e['ratings'][o]
        if r['questionable']:
            return 4
        if o in FOLLOWED:
            return 0
        return {'C': 1, 'LL': 1, 'LR': 1, 'S': 1, 'L': 2, 'R': 2}.get(r['code'], 3)
    def ok_title(t):
        return 25 <= len(t) <= 120 and not t.isupper()
    return min(e['outlets'], key=lambda o: (rank(o), not ok_title(e['outlets'][o]['title']), -e['outlets'][o].get('typicality', 0)))


# ---------- writing ----------

PROMPT = """You write stories for Pheme, a neutral news briefing that compares how outlets cover the same event.
Below are headlines and short descriptions from several outlets about what should be ONE news event.
Using ONLY this material (no outside knowledge), return a JSON object with:
- "same_event": true if these mostly describe one news event, else false
- "is_news": false for sport fixtures, TV listings, shopping deals, horoscopes or opinion-only pieces, else true
- "topic": one of "uk", "world", "science", "tech", "business", "finance" (uk = UK and Ireland domestic news)
- "headline": a neutral headline in your own words, at most 90 characters, no quotation marks from outlets
- "summary": one or two sentences in your own words, at most 45 words
- "article": 2-5 original news paragraphs, at least 80 words altogether, about what happened and the concrete facts and context supported by this material. Do not write about source counts, political leanings, Pheme, or how to use the website
- "article_sources": names of the outlets whose supplied material supports the article, exactly as given
- "insufficient_material": true if the material is too thin to write a factual article without padding or speculation; if true, return an empty article
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
        'model': MODEL, 'max_tokens': 1300,
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
    if not data.get('same_event', True) or data.get('is_news') is False:
        return {'reject': True}
    return data


def ask_groq(e):
    key = os.environ.get('GROQ_API_KEY')
    if not key:
        return None
    lines = []
    for o, a in sorted(e['outlets'].items(), key=lambda x: x[1]['published'])[:12]:
        lines.append(f"- {o} ({day_label(a['published'])}): {a['title']} — {a.get('summary', '')[:240]}")
    body = json.dumps({
        'model': os.environ.get('PHEME_GROQ_MODEL', 'openai/gpt-oss-20b'),
        'max_tokens': 1100,
        'temperature': 0.3,
        'messages': [{'role': 'user', 'content': PROMPT.format(material='\n'.join(lines))}],
    }).encode()
    req = urllib.request.Request('https://api.groq.com/openai/v1/chat/completions', data=body, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'PhemeEdition/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = json.loads(resp.read())['choices'][0]['message']['content']
        raw = re.sub(r'<think>[\s\S]*?</think>', '', raw).strip()
        data = json.loads(raw[raw.index('{'): raw.rindex('}') + 1])
    except Exception as error:
        print('Groq writer unavailable for one story (' + type(error).__name__ + ').', file=sys.stderr)
        return None
    if not data.get('same_event', True) or data.get('is_news') is False:
        return {'reject': True}
    return data


def ask_writer(e):
    return ask_claude(e) or ask_groq(e)


GAZETTEER = [
    (r'\b(sinaloa|guasave)\b', 'Guasave, Sinaloa, Mexico', 'Sinaloa', 25.5747, -108.4718),
    (r'\b(mexico city|mexican|mexico)\b', 'Mexico City, Mexico', 'Mexico', 19.4326, -99.1332),
    (r'\b(brasília|brasilia|bolsonaro|brazil|brazilian)\b', 'Brasília, Brazil', 'Brasília', -15.7975, -47.8919),
    (r'\b(argentina|buenos aires)\b', 'Buenos Aires, Argentina', 'Buenos Aires', -34.6037, -58.3816),
    (r'\b(venezuela|caracas)\b', 'Caracas, Venezuela', 'Caracas', 10.4806, -66.9036),
    (r'\b(colombia|bogota|bogotá)\b', 'Bogotá, Colombia', 'Bogotá', 4.7110, -74.0721),
    (r'\b(the hague|icj|international court of justice)\b', 'The Hague, Netherlands', 'The Hague', 52.0800, 4.3100),
    (r'\b(brussels|eu summit|european commission|european union)\b', 'Brussels, Belgium', 'Brussels', 50.8503, 4.3517),
    (r'\b(cern|lhcb|geneva)\b', 'Geneva, Switzerland', 'Geneva', 46.2330, 6.0557),
    (r'\b(gulf of finland|helsinki|finland|finnish)\b', 'Helsinki, Finland', 'Finland', 60.1699, 24.9384),
    (r'\b(lublin|chmielek|warsaw|poland|polish)\b', 'Warsaw, Poland', 'Poland', 52.2297, 21.0122),
    (r'\b(kryvyi rih|kyiv|ukraine|ukrainian|crimea|crimean)\b', 'Kyiv, Ukraine', 'Ukraine', 50.4501, 30.5234),
    (r'\b(moscow|kremlin|russia|russian)\b', 'Moscow, Russia', 'Russia', 55.7558, 37.6173),
    (r'\b(belfast|northern ireland)\b', 'Belfast, Northern Ireland', 'Belfast', 54.5973, -5.9301),
    (r'\b(edinburgh|glasgow|scotland|scottish|rockstar|grand theft auto|gta\s+vi|gta\s+6)\b', 'Edinburgh, Scotland, UK', 'Edinburgh', 55.9533, -3.1883),
    (r'\b(cardiff|wales|welsh)\b', 'Cardiff, Wales, UK', 'Cardiff', 51.4816, -3.1791),
    (r'\b(bradford|leeds|yorkshire)\b', 'Bradford, West Yorkshire, UK', 'Bradford', 53.7960, -1.7594),
    (r'\b(liverpool|merseyside)\b', 'Liverpool, UK', 'Liverpool', 53.4084, -2.9916),
    (r'\b(manchester)\b', 'Manchester, UK', 'Manchester', 53.4808, -2.2426),
    (r'\b(birmingham|walsall|midlands|poundland)\b', 'West Midlands, UK', 'Midlands', 52.4862, -1.8904),
    (r'\b(devizes|wiltshire|henry aldridge|titanic)\b', 'Devizes, Wiltshire, UK', 'Wiltshire', 51.3526, -1.9951),
    (r'\b(somerset|bristol|bath|devon|cornwall|plymouth)\b', 'Bristol, UK', 'Bristol', 51.4545, -2.5879),
    (r'\b(windsor|buckingham|princess of wales|catherine|prince william|prince harry|king charles|royal titles|royal family)\b', 'Windsor, Berkshire, UK', 'Windsor', 51.4839, -0.6044),
    (r'\b(bank of england|ftse|city of london|bailey)\b', 'City of London, UK', 'City of London', 51.5142, -0.0886),
    (r'\b(westminster|downing street|whitehall|london|nhs|ons|uk|britain|british)\b', 'London, UK', 'London', 51.5072, -0.1276),
    (r'\b(dublin|ireland|irish)\b', 'Dublin, Ireland', 'Dublin', 53.3498, -6.2603),
    (r'\b(paris|france|french|macron)\b', 'Paris, France', 'Paris', 48.8566, 2.3522),
    (r'\b(munich|garching|berlin|germany|german|darmstadt|lufthansa|frankfurt)\b', 'Berlin, Germany', 'Germany', 52.5200, 13.4050),
    (r'\b(rome|milan|italy|italian|vatican)\b', 'Rome, Italy', 'Italy', 41.9028, 12.4964),
    (r'\b(madrid|barcelona|spain|spanish)\b', 'Madrid, Spain', 'Spain', 40.4168, -3.7038),
    (r'\b(antalya|istanbul|ankara|turkey|turkish|cop31)\b', 'Antalya, Turkey', 'Turkey', 36.8969, 30.7133),
    (r'\b(gaza|jerusalem|tel aviv|israel|israeli|netanyahu)\b', 'Jerusalem, Israel', 'Israel', 31.7683, 35.2137),
    (r'\b(beirut|lebanon|lebanese)\b', 'Beirut, Lebanon', 'Lebanon', 33.8938, 35.5018),
    (r'\b(bahrain|manama|al-riffa)\b', 'Manama, Bahrain', 'Bahrain', 26.2285, 50.5860),
    (r'\b(tehran|iran|iranian|strait of hormuz)\b', 'Tehran, Iran', 'Iran', 35.6892, 51.3890),
    (r'\b(riyadh|saudi arabia|saudi)\b', 'Riyadh, Saudi Arabia', 'Saudi Arabia', 24.7136, 46.6753),
    (r'\b(baghdad|iraq|iraqi)\b', 'Baghdad, Iraq', 'Iraq', 33.3152, 44.3661),
    (r'\b(cairo|egypt|egyptian)\b', 'Cairo, Egypt', 'Egypt', 30.0444, 31.2357),
    (r'\b(sterkfontein|johannesburg|cape town|south africa)\b', 'Johannesburg, South Africa', 'South Africa', -26.2041, 28.0473),
    (r'\b(nairobi|kenya|nigeria|lagos|sudan|khartoum)\b', 'Nairobi, Kenya', 'East Africa', -1.2921, 36.8219),
    (r'\b(new delhi|mumbai|india|indian)\b', 'New Delhi, India', 'India', 28.6139, 77.2090),
    (r'\b(myanmar|rohingya|rakhine|yangon)\b', 'Rakhine State, Myanmar', 'Myanmar', 20.1462, 92.8984),
    (r'\b(jakarta|indonesia|indonesian)\b', 'Jakarta, Indonesia', 'Jakarta', -6.2088, 106.8456),
    (r'\b(manila|philippines|philippine|asean)\b', 'Manila, Philippines', 'Manila', 14.5995, 120.9842),
    (r'\b(shenzhen|hong kong)\b', 'Shenzhen, China', 'Shenzhen', 22.5431, 114.0579),
    (r'\b(beijing|shanghai|china|chinese|xi jinping)\b', 'Beijing, China', 'Beijing', 39.9042, 116.4074),
    (r'\b(taipei|taiwan|taiwanese)\b', 'Taipei, Taiwan', 'Taiwan', 25.0330, 121.5654),
    (r'\b(tokyo|japan|japanese)\b', 'Tokyo, Japan', 'Tokyo', 35.6762, 139.6503),
    (r'\b(seoul|south korea|north korea|pyongyang)\b', 'Seoul, South Korea', 'Seoul', 37.5665, 126.9780),
    (r'\b(sydney|melbourne|canberra|australia|australian)\b', 'Sydney, Australia', 'Australia', -33.8688, 151.2093),
    (r'\b(mountain view|signal)\b', 'Mountain View, California, USA', 'California', 37.3861, -122.0839),
    (r'\b(cupertino|apple|silicon valley|san francisco|anthropic|openai|nvidia|santa clara|google|meta|california)\b', 'San Francisco Bay Area, USA', 'California', 37.4419, -122.1430),
    (r'\b(spacex|los angeles|hollywood|hawthorne)\b', 'Los Angeles, California, USA', 'Los Angeles', 34.0522, -118.2437),
    (r'\b(seattle|amazon|microsoft)\b', 'Seattle, Washington, USA', 'Seattle', 47.6062, -122.3321),
    (r'\b(austin|houston|texas|nasa|tesla)\b', 'Austin, Texas, USA', 'Texas', 30.2672, -97.7431),
    (r'\b(st\.?\s+louis|missouri|roundup|bayer)\b', 'St. Louis, Missouri, USA', 'St. Louis', 38.6270, -90.1994),
    (r'\b(mayo clinic|minnesota)\b', 'Rochester, Minnesota, USA', 'Minnesota', 44.0225, -92.4669),
    (r'\b(chicago|illinois)\b', 'Chicago, Illinois, USA', 'Chicago', 41.8781, -87.6298),
    (r'\b(boston|harvard|mit\b|massachusetts)\b', 'Boston, Massachusetts, USA', 'Boston', 42.3601, -71.0589),
    (r'\b(columbia university|sloan kettering|daraxonrasib|wall street|nasdaq|s&p 500|dow jones|new york|nyc|gold and silver|precious metals|comex|bullion)\b', 'New York, USA', 'New York', 40.7128, -74.0060),
    (r'\b(james webb|jwst|stsci|baltimore|maryland)\b', 'Baltimore, Maryland, USA', 'Baltimore', 39.2904, -76.6122),
    (r'\b(white house|pentagon|fbi|federal reserve|congress|senate|washington|trump|usda|fcc)\b', 'Washington, D.C., USA', 'Washington, D.C.', 38.9072, -77.0369),
    (r'\b(ottawa|toronto|canada|canadian)\b', 'Ottawa, Canada', 'Canada', 45.4215, -75.6972),
]


def infer_location(e, headline, extra_text=''):
    parts = [headline, extra_text]
    for a in list(e['outlets'].values())[:10]:
        parts.append(a.get('title', ''))
        parts.append(a.get('summary', '')[:200])
    text = ' '.join(p for p in parts if p).lower()
    for pattern, label, short_label, lat, lng in GAZETTEER:
        if re.search(pattern, text):
            return {'label': label, 'shortLabel': short_label, 'lat': lat, 'lng': lng}
    return None


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
    gen = ask_writer(e)
    if not isinstance(gen, dict):
        gen = None
    if gen and gen.get('reject'):
        return None
    source_names = [name for name in (gen.get('article_sources') or []) if isinstance(name, str) and name in e['outlets']] if isinstance(gen, dict) else []
    if gen and gen.get('headline') and gen.get('summary') and not gen.get('insufficient_material') and article_is_ready(gen) and source_names:
        headline = gen['headline'].strip()[:110]
        summary = gen['summary'].strip()
        points = [p.strip() for p in gen.get('points', []) if isinstance(p, str) and p.strip()][:3]
        article = [p.strip() for p in gen.get('article', []) if isinstance(p, str) and p.strip()][:5]
        digest = (gen.get('digest') or headline).strip()
        if gen.get('topic') in QUOTA:
            e['topic'] = gen['topic']
    else:
        headline = la['title']
        summary = headline
        points = []
        article = []
        digest = f'{headline} ({lead})'
        gen = {}
    story = {
        'id': slug(headline, taken), 'topic': e['topic'], 'source': lead,
        'time': day_label(la['published']), 'url': la['url'], 'headline': headline,
        'summary': summary, 'points': points,
        'publishedLabel': datetime.datetime.fromisoformat(la['published']).astimezone(LONDON).strftime('%-d %b %Y'),
    }
    if article:
        story['article'] = article
        story['articleStatus'] = 'ready'
        story['articleOrigin'] = 'generated'
        story['articleUpdatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        story['articleSources'] = [{'name': name, 'url': e['outlets'][name]['url']} for name in source_names]
    loc = gen.get('location')
    if isinstance(loc, dict):
        try:
            lat, lng = float(loc['lat']), float(loc['lng'])
            if abs(lat) <= 85 and abs(lng) <= 180 and str(loc.get('label', '')).strip():
                story['location'] = {'label': str(loc['label']).strip(), 'shortLabel': str(loc.get('shortLabel') or loc['label']).split(',')[0].strip(), 'lat': lat, 'lng': lng}
        except (KeyError, TypeError, ValueError):
            pass
    if not story.get('location'):
        extra = ' '.join([summary] + points + article[:2])
        inferred = infer_location(e, headline, extra)
        if inferred:
            story['location'] = inferred
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
    coverage = [[o, day_label(e['outlets'][o]['published']), e['outlets'][o]['url'], e['outlets'][o]['title']] for o in names]
    return story, coverage, digest


def reuse_ids(stories, coverage, previous):
    """Keep yesterday's ID (and curated media/location) when a story continues."""
    prev_urls = {sid: {row[2] for row in rows} for sid, rows in previous.get('COVERAGE', {}).items()}
    prev_stories = {s['id']: s for s in previous.get('STORIES', [])}
    used = set()
    for s in stories:
        urls = {row[2] for row in coverage[s['id']]}
        for sid, purls in prev_urls.items():
            if sid not in used and (len(urls & purls) >= 2 or s['url'] in purls):
                coverage[sid] = coverage.pop(s['id'])
                s['id'] = sid
                prev = prev_stories.get(sid)
                if prev:
                    prev_img = prev.get('image')
                    if not s.get('image') and prev_img and (prev_img.startswith('https://') or (ROOT / prev_img).exists()):
                        s['image'] = prev_img
                        s['imageAlt'] = prev.get('imageAlt', s['headline'])
                        if prev.get('imageCredit'):
                            s['imageCredit'] = prev['imageCredit']
                    if not s.get('location') and prev.get('location'):
                        s['location'] = prev['location']
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
    FOLLOWED.update(f['name'] for f in previous.get('FOLLOWED', []))
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
    apply_editorial(stories, coverage, previous)
    missing = [s['id'] for s in stories if not article_is_ready(s)]
    if missing:
        print(f'Article quality gate: {len(missing)} stories have no source-backed article. Keeping the published edition unchanged. Configure ANTHROPIC_API_KEY or GROQ_API_KEY for new articles.', file=sys.stderr)
        return 1
    rss_images = {a['url']: a['image'] for a in articles if a.get('image')}
    needs_img = [s for s in stories if not (s.get('image') or '').startswith('https://')]
    if needs_img:
        found_imgs = enrich_stories(needs_img, coverage, rss_image_by_url=rss_images)
        print(f'Resolved {found_imgs}/{len(needs_img)} live publisher images.', file=sys.stderr)
    digests = [s['headline'] + ' (' + s['source'] + ')' for s in stories]
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
            'articlePolicy': 'source-based-v1',
            'writer': 'claude' if os.environ.get('ANTHROPIC_API_KEY') else ('groq' if os.environ.get('GROQ_API_KEY') else 'editorial-cache'),
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
