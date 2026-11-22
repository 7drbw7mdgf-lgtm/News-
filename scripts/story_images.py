"""Extract and verify real publisher article photographs (og:image / twitter:image / RSS media) for Pheme stories."""
import concurrent.futures
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

BAD_IMAGE_RE = re.compile(
    r'(?:'
    r'logo|favicon|apple-touch-icon|icon[-_.]|avatar|placeholder|'
    r'default[-_]?img|default[-_]?image|default[-_]?og|og[-_]?default|'
    r'og_image_\d+|static\.seekingalpha\.com/assets/|'
    r'site[-_]?image|social[-_]?share|brand[-_.]|spacer|pixel|1x1|blank|'
    r'fallback|generic|no[-_]?image|0_brand\.|'
    r'/ALTERNATES/s(?:98|120|150)/|'
    r'\.svg(?:\?|$)|\.ico(?:\?|$)'
    r')',
    re.I,
)

# Prefer established editorial photography newsrooms ahead of small aggregators or blogs.
PREFERRED_OUTLETS = [
    'BBC News',
    'The Guardian',
    'Reuters',
    'Associated Press',
    'Al Jazeera English',
    'Sky News',
    'Financial Times',
    'The New York Times',
    'Washington Post',
    'The Economist',
    'NPR',
    'CBC News',
    'DW News',
    'Euronews',
    'RTÉ News',
    'ABC News',
    'CBS News',
    'NBC News',
    'CNBC',
    'Bloomberg',
    'The Wall Street Journal',
    'Nature News',
    'New Scientist',
    'ScienceDaily',
    'Ars Technica',
    'Wired',
    'The Verge',
    'TechCrunch',
    'MIT Technology Review',
    'The Telegraph',
    'The Independent',
    'Evening Standard',
    'The Times',
    'ITV News',
    'France 24',
    'Politico',
    'Axios',
    'The Hill',
    'CNN',
    'Fox News',
    'Fox Business',
    'Android Authority',
    '9to5Mac',
    'ZDNET',
    'CNET',
    'Digital Trends',
    'Daily Mail',
    'Metro',
    'Economic Times',
    'Nautilus',
    'MoneyWeek',
    'Freightwaves',
    'Investors Business Daily',
]
OUTLET_PRIORITY = {name: i for i, name in enumerate(PREFERRED_OUTLETS)}

META_RE = re.compile(r'<meta\b[^>]+>', re.I)
ATTR_RE = re.compile(r'([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))')
JSONLD_RE = re.compile(r'<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.I | re.S)


def normalise_image_url(raw_url, base_url=''):
    if not raw_url or not isinstance(raw_url, str):
        return None
    cand = html.unescape(raw_url).strip()
    if not cand or cand.startswith('data:'):
        return None
    full = urllib.parse.urljoin(base_url, cand) if base_url else cand
    parts = urllib.parse.urlsplit(full)
    if parts.scheme == 'http':
        full = urllib.parse.urlunsplit(('https', parts.netloc, parts.path, parts.query, ''))
        parts = urllib.parse.urlsplit(full)
    if parts.scheme != 'https' or not parts.netloc or parts.username or parts.password:
        return None
    if BAD_IMAGE_RE.search(parts.netloc + parts.path + ('?' + parts.query if parts.query else '')):
        return None
    return full


def extract_jsonld_image(raw_html):
    for m in JSONLD_RE.finditer(raw_html[:160000]):
        try:
            payload = json.loads(m.group(1).strip())
        except Exception:
            continue
        nodes = payload if isinstance(payload, list) else [payload]
        expanded = []
        for node in nodes:
            if isinstance(node, dict):
                expanded.append(node)
                if isinstance(node.get('@graph'), list):
                    expanded.extend(x for x in node['@graph'] if isinstance(x, dict))
        for node in expanded:
            img = node.get('image') or node.get('thumbnailUrl')
            if isinstance(img, str):
                return img
            if isinstance(img, dict) and isinstance(img.get('url'), str):
                return img['url']
            if isinstance(img, list):
                for item in img:
                    if isinstance(item, str):
                        return item
                    if isinstance(item, dict) and isinstance(item.get('url'), str):
                        return item['url']
    return None


def extract_meta_image(raw_html, page_url):
    og_img = None
    og_alt = None
    tw_img = None
    head = raw_html[:140000]
    for m in META_RE.finditer(head):
        attrs = {}
        for am in ATTR_RE.finditer(m.group(0)):
            k = am.group(1).lower()
            v = am.group(2) if am.group(2) is not None else (am.group(3) if am.group(3) is not None else am.group(4))
            attrs[k] = html.unescape(v or '').strip()
        prop = (attrs.get('property') or attrs.get('name') or '').lower()
        content = attrs.get('content', '')
        if not content:
            continue
        if prop in ('og:image', 'og:image:secure_url', 'og:image:url') and not og_img:
            og_img = content
        elif prop in ('twitter:image', 'twitter:image:src') and not tw_img:
            tw_img = content
        elif prop in ('og:image:alt', 'twitter:image:alt') and not og_alt:
            og_alt = content
    candidates = [og_img, tw_img]
    if not og_img and not tw_img:
        candidates.append(extract_jsonld_image(raw_html))
    for cand in candidates:
        url = normalise_image_url(cand, page_url)
        if url:
            clean_alt = re.sub(r'\s+', ' ', og_alt or '').strip()[:220]
            return url, clean_alt
    return None, ''


def verify_image_url(url, timeout=6):
    if not normalise_image_url(url):
        return False
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA, 'Accept': 'image/*'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = (resp.headers.get('Content-Type') or '').lower()
            cl = int(resp.headers.get('Content-Length') or 0)
            if ct.startswith('image/') and 'svg' not in ct and 'icon' not in ct and (cl == 0 or cl > 4000):
                return True
    except Exception:
        pass
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'image/*', 'Range': 'bytes=0-2047'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = (resp.headers.get('Content-Type') or '').lower()
            if ct.startswith('image/') and 'svg' not in ct and 'icon' not in ct:
                return True
    except Exception:
        return False
    return False


def order_candidates(candidates, lead_outlet=None):
    """Sort (outlet, page_url, rss_image) tuples preferring reputable photojournalism outlets."""
    def key(item):
        outlet = item[0]
        prio = OUTLET_PRIORITY.get(outlet, 500)
        is_lead_bonus = 0 if (outlet == lead_outlet and prio < 500) else 1
        return (is_lead_bonus, prio, outlet)
    seen = set()
    ordered = []
    for item in sorted(candidates, key=key):
        url = item[1]
        if url not in seen:
            seen.add(url)
            ordered.append(item)
    return ordered


def resolve_story_image(candidates, headline, lead_outlet=None, max_tries=10):
    """Fetch a verified article photograph for a story from its coverage pages or RSS media.

    candidates: iterable of (outlet, page_url, rss_image_or_none)
    Returns dict {'image': url, 'imageAlt': alt, 'imageCredit': outlet} or None.
    """
    ordered = order_candidates(candidates, lead_outlet=lead_outlet)
    rss_fallbacks = []
    for outlet, page_url, rss_img in ordered[:max_tries]:
        if rss_img:
            rss_fallbacks.append((outlet, rss_img))
        try:
            req = urllib.request.Request(
                page_url,
                headers={
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-GB,en;q=0.9',
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw_html = resp.read(160000).decode('utf-8', 'ignore')
                final_url = resp.geturl() or page_url
            img_url, alt = extract_meta_image(raw_html, final_url)
            if img_url and verify_image_url(img_url):
                return {
                    'image': img_url,
                    'imageAlt': alt or headline,
                    'imageCredit': outlet,
                }
        except Exception:
            continue
    for outlet, _, rss_img in ordered[max_tries:]:
        if rss_img:
            rss_fallbacks.append((outlet, rss_img))
    for outlet, rss_img in rss_fallbacks:
        norm = normalise_image_url(rss_img)
        if norm and verify_image_url(norm):
            return {
                'image': norm,
                'imageAlt': headline,
                'imageCredit': outlet,
            }
    return None


def enrich_stories(stories, coverage_map, rss_image_by_url=None, max_workers=12):
    """Concurrently attach verified real article images to stories."""
    rss_image_by_url = rss_image_by_url or {}

    def job(story):
        rows = coverage_map.get(story['id'], [])
        cands = [(row[0], row[2], rss_image_by_url.get(row[2]) or rss_image_by_url.get(row[2].split('?')[0])) for row in rows]
        return story['id'], resolve_story_image(cands, story['headline'], lead_outlet=story.get('source'))

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        for sid, res in pool.map(job, stories):
            if res:
                results[sid] = res
    for story in stories:
        res = results.get(story['id'])
        if res:
            story['image'] = res['image']
            story['imageAlt'] = res['imageAlt']
            story['imageCredit'] = res['imageCredit']
    return len(results)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/story_images.py editions/YYYY-MM-DD.json', file=sys.stderr)
        sys.exit(2)
    path = Path(sys.argv[1])
    edition = json.loads(path.read_text())
    found = enrich_stories(edition['STORIES'], edition['COVERAGE'])
    path.write_text(json.dumps(edition, ensure_ascii=False, indent=1) + '\n')
    print(f'Updated {path.name}: {found}/{len(edition["STORIES"])} stories have verified publisher images.')
