"""Look up an outlet's Media Bias/Fact Check rating.

Used by the feed selector and the edition builder. Order of lookup:
1. feeds/rating-overrides.json (by outlet name) - for questionable sources,
   whose left/right leaning MBFC states on its site but not in its data file;
2. the domain of an article link (most reliable);
3. the feed's own host, via a table of known feed hosts;
4. the outlet name.
"""
import json
import re
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_DATA = json.loads((ROOT / 'feeds' / 'mbfc-ratings.json').read_text())['sources']
_OVERRIDES_FILE = ROOT / 'feeds' / 'rating-overrides.json'
_OVERRIDES = json.loads(_OVERRIDES_FILE.read_text()) if _OVERRIDES_FILE.exists() else {}
_BY_NAME = {}
for _d, (_name, *_rest) in _DATA.items():
    _BY_NAME.setdefault(re.sub(r'[^a-z0-9]', '', _name.lower()), _d)

CODE = {
    'left': 'L', 'left-center': 'LL', 'center': 'C', 'right-center': 'LR', 'right': 'R',
    'pro-science': 'S', 'fake-news': 'Q', 'conspiracy-pseudoscience': 'Q', 'satire': 'NR',
}

# Feed hosts that differ from the outlet's main domain.
FEED_HOSTS = {
    'feeds.bbci.co.uk': 'bbc.com', 'rss.nytimes.com': 'nytimes.com', 'feeds.skynews.com': 'news.sky.com',
    'feeds.npr.org': 'npr.org', 'moxie.foxnews.com': 'foxnews.com', 'moxie.foxbusiness.com': 'foxbusiness.com',
    'search.cnbc.com': 'cnbc.com', 'feeds.washingtonpost.com': 'washingtonpost.com', 'rss.politico.com': 'politico.com',
    'feeds.bloomberg.com': 'bloomberg.com', 'rss.dw.com': 'dw.com', 'feeds.arstechnica.com': 'arstechnica.com',
    'rss.cnn.com': 'cnn.com', 'feeds.nbcnews.com': 'nbcnews.com', 'rssfeeds.usatoday.com': 'usatoday.com',
    'rss.csmonitor.com': 'csmonitor.com', 'feeds.propublica.org': 'propublica.org', 'feeds.thedailybeast.com': 'thedailybeast.com',
    'feeds.businessinsider.com': 'businessinsider.com', 'feeds.hbr.org': 'hbr.org', 'feeds.macrumors.com': 'macrumors.com',
    'feeds.thelocal.com': 'thelocal.com', 'en.mercopress.com': 'mercopress.com', 'feeds.news24.com': 'news24.com',
    'english.kyodonews.net': 'kyodonews.net', 'en.yna.co.kr': 'yna.co.kr', 'e.vnexpress.net': 'vnexpress.net',
    'connect.biorxiv.org': 'biorxiv.org', 'connect.medrxiv.org': 'medrxiv.org', 'rss.slashdot.org': 'slashdot.org',
    'abcnews.go.com': 'abcnews.go.com', 'www3.nhk.or.jp': 'nhk.or.jp', 'newsinfo.inquirer.net': 'inquirer.net',
}
# Feeds on a shared host (one host, several outlets): resolve by outlet name.
SHARED_HOSTS = {'feeds.content.dowjones.io', 'feeds.feedburner.com', 'feeds.simplecast.com', 'hnrss.org'}
NAME_TO_DOMAIN = {
    'the wall street journal': 'wsj.com', 'marketwatch': 'marketwatch.com', "barron's": 'barrons.com',
    'sky news': 'news.sky.com', 'bbc news': 'bbc.com', 'the telegraph': 'telegraph.co.uk', 'the economist': 'economist.com',
    'financial times': 'ft.com', 'city am': 'cityam.com', 'the guardian': 'theguardian.com', 'the independent': 'independent.co.uk',
    'daily mail': 'dailymail.com', 'this is money': 'thisismoney.co.uk', 'abc news australia': 'abc.net.au', 'times of india': 'timesofindia.indiatimes.com',
    'ndtv': 'ndtv.com', 'breitbart': 'breitbart.com', 'zero hedge': 'zerohedge.com', 'scroll.in': 'scroll.in',
}


def _host(url):
    return (urllib.parse.urlsplit(url or '').hostname or '').lower().removeprefix('www.')


def _by_domain(host):
    parts = host.split('.')
    for i in range(len(parts) - 1):
        key = '.'.join(parts[i:])
        if key in _DATA:
            return key
    return None


def rate(outlet, urls=()):
    """Return {'code', 'mbfc_name', 'mbfc_bias', 'questionable'} for an outlet."""
    if outlet in _OVERRIDES:
        o = _OVERRIDES[outlet]
        return {'code': o['code'], 'mbfc_name': o.get('mbfc_name', outlet), 'mbfc_bias': o.get('note', ''), 'questionable': bool(o.get('questionable'))}
    domain = None
    for u in urls:
        h = _host(u)
        if not h:
            continue
        if h in SHARED_HOSTS:
            continue
        domain = _by_domain(FEED_HOSTS.get(h, h))
        if domain:
            break
    if not domain:
        mapped = NAME_TO_DOMAIN.get(outlet.lower())
        domain = _by_domain(mapped) if mapped else None
    if not domain:
        domain = _BY_NAME.get(re.sub(r'[^a-z0-9]', '', outlet.lower()))
    if not domain:
        return {'code': 'NR', 'mbfc_name': '', 'mbfc_bias': '', 'questionable': False}
    name, bias, _reporting, _url = _DATA[domain]
    return {'code': CODE.get(bias, 'NR'), 'mbfc_name': name, 'mbfc_bias': bias, 'questionable': bias in ('fake-news', 'conspiracy-pseudoscience')}
