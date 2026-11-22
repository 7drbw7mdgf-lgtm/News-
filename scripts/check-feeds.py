"""Test every candidate feed in feeds/candidates.json and record whether it works.

For each feed: fetch it, parse RSS 2.0 / RSS 1.0 / Atom, and record the item
count, newest item date, share of https links, declared language and a
non-ASCII ratio of titles (a rough English check). Writes
feeds/check-results.json. Never prints anything secret; feeds are public.
"""
import concurrent.futures
import datetime
import email.utils
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATOM = '{http://www.w3.org/2005/Atom}'
RSS1 = '{http://purl.org/rss/1.0/}'
DC = '{http://purl.org/dc/elements/1.1/}'
UA = 'Mozilla/5.0 (compatible; PhemeFeedCheck/1.0; +https://pheme24.online/)'


def when(raw):
    if not raw:
        return None
    raw = raw.strip()
    try:
        d = email.utils.parsedate_to_datetime(raw)
        if d.tzinfo:
            return d.astimezone(datetime.timezone.utc)
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        d = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).astimezone(datetime.timezone.utc)
    except ValueError:
        return None


def text(node, tags):
    for t in tags:
        el = node.find(t)
        if el is not None and (el.text or '').strip():
            return el.text.strip()
    return ''


def link_of(node):
    el = node.find('link')
    if el is not None and (el.text or '').strip():
        return el.text.strip()
    for el in node.findall(ATOM + 'link'):
        if el.get('rel', 'alternate') == 'alternate' and el.get('href'):
            return el.get('href')
    el = node.find(RSS1 + 'link')
    return (el.text or '').strip() if el is not None else ''


def check(c):
    r = {'url': c['url'], 'ok': False}
    try:
        req = urllib.request.Request(c['url'], headers={'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            r['status'] = resp.status
            r['final_url'] = resp.geturl()
            body = resp.read(8 * 1024 * 1024)
        root = ET.fromstring(body)
    except Exception as e:  # network, HTTP or parse error
        r['error'] = type(e).__name__ + ': ' + str(e)[:120]
        return r
    channel = root.find('channel')
    items = (channel.findall('item') if channel is not None else []) or root.findall(ATOM + 'entry') or root.findall(RSS1 + 'item') or root.findall('item')
    lang = ''
    if channel is not None:
        lang = text(channel, ['language', DC + 'language'])
    lang = lang or root.get('{http://www.w3.org/XML/1998/namespace}lang', '') or ''
    dates, https, titles = [], 0, []
    for it in items:
        d = when(text(it, ['pubDate', ATOM + 'updated', ATOM + 'published', DC + 'date', 'published', 'updated']))
        if d:
            dates.append(d)
        if link_of(it).startswith('https://'):
            https += 1
        t = text(it, ['title', ATOM + 'title', RSS1 + 'title'])
        if t:
            titles.append(t)
    now = datetime.datetime.now(datetime.timezone.utc)
    joined = ''.join(titles)
    letters = [ch for ch in joined if ch.isalpha()]
    r.update({
        'ok': bool(items),
        'items': len(items),
        'newest_days': round((now - max(dates)).total_seconds() / 86400, 2) if dates else None,
        'https_share': round(https / len(items), 2) if items else 0,
        'lang': lang.lower(),
        'non_ascii_letters': round(sum(1 for ch in letters if ord(ch) > 127) / len(letters), 3) if letters else None,
        'feed_title': text(channel, ['title']) if channel is not None else text(root, [ATOM + 'title']),
    })
    return r


def main():
    cands = json.loads((ROOT / 'feeds' / 'candidates.json').read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(check, cands))
    for c, r in zip(cands, results):
        r.update({'name': c['name'], 'topic': c['topic'], 'origin': c.get('origin', '')})
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    (ROOT / 'feeds' / 'check-results.json').write_text(json.dumps({'checked_at': stamp, 'results': results}, indent=1, ensure_ascii=False))
    ok = sum(1 for r in results if r['ok'])
    fresh = sum(1 for r in results if r['ok'] and r['newest_days'] is not None and r['newest_days'] <= 7)
    print(f'Checked {len(results)} feeds: {ok} parse with items, {fresh} have an item from the last 7 days.')


if __name__ == '__main__':
    sys.exit(main())
