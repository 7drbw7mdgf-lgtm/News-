"""Collect RSS/Atom candidates for an editor across UK, World, Science, Tech, Business and Finance.
Output never replaces the public edition automatically.
"""

import concurrent.futures
import datetime
import email.utils
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

FEEDS = [
    # UK
    ("BBC News", "uk", "https://feeds.bbci.co.uk/news/uk/rss.xml"),
    ("The Guardian", "uk", "https://www.theguardian.com/uk-news/rss"),
    ("Sky News", "uk", "https://feeds.skynews.com/feeds/rss/uk.xml"),
    ("The Telegraph", "uk", "https://www.telegraph.co.uk/rss.xml"),
    ("Daily Mail", "uk", "https://www.dailymail.co.uk/news/index.rss"),
    # World (global + multi-spectrum)
    ("BBC News", "world", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("The Guardian", "world", "https://www.theguardian.com/world/rss"),
    ("Al Jazeera English", "world", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("France 24", "world", "https://www.france24.com/en/rss"),
    ("DW News", "world", "https://rss.dw.com/xml/rss-en-world"),
    ("Politico Europe", "world", "https://www.politico.eu/feed/"),
    ("NPR", "world", "https://feeds.npr.org/1004/rss.xml"),
    ("The New York Times", "world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("CBS News", "world", "https://www.cbsnews.com/latest/rss/world"),
    ("Fox News", "world", "https://moxie.foxnews.com/google-publisher/world.xml"),
    ("South China Morning Post", "world", "https://www.scmp.com/rss/3/feed"),
    ("ABC News Australia", "world", "https://www.abc.net.au/news/feed/2942460/rss.xml"),
    ("Times of India", "world", "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms"),
    ("MercoPress", "world", "https://en.mercopress.com/rss/"),
    # Science
    ("ScienceDaily", "science", "https://www.sciencedaily.com/rss/top/science.xml"),
    ("Nature News", "science", "https://www.nature.com/nature.rss"),
    ("Phys.org", "science", "https://phys.org/rss-feed/"),
    ("New Scientist", "science", "https://www.newscientist.com/feed/home/"),
    # Tech
    ("Ars Technica", "tech", "https://feeds.arstechnica.com/arstechnica/index"),
    ("The Verge", "tech", "https://www.theverge.com/rss/index.xml"),
    ("TechCrunch", "tech", "https://techcrunch.com/feed/"),
    ("Wired", "tech", "https://www.wired.com/feed/rss"),
    # Business
    ("BBC News", "business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("The Guardian", "business", "https://www.theguardian.com/uk/business/rss"),
    ("CNBC", "business", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147"),
    ("The Economist", "business", "https://www.economist.com/finance-and-economics/rss.xml"),
    # Finance
    ("CNBC", "finance", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"),
    ("Financial Times", "finance", "https://www.ft.com/rss/home/uk"),
    ("City AM", "finance", "https://www.cityam.com/feed/"),
    ("MarketWatch", "finance", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
]

ATOM_NS = "{http://www.w3.org/2005/Atom}"
RSS1_NS = "{http://purl.org/rss/1.0/}"
DC_NS = "{http://purl.org/dc/elements/1.1/}"


def parse_timestamp(raw):
    if not raw:
        return None
    raw = raw.strip()
    try:
        dt = email.utils.parsedate_to_datetime(raw)
        if dt.tzinfo is not None:
            return dt.astimezone(datetime.timezone.utc)
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(datetime.timezone.utc)
    except ValueError:
        return None


def first_text(node, tags):
    for tag in tags:
        el = node.find(tag)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def first_link(node):
    for tag in ("link", f"{ATOM_NS}link", f"{RSS1_NS}link"):
        el = node.find(tag)
        if el is not None:
            href = (el.attrib.get("href") or el.text or "").strip()
            if href:
                return href
    return ""


def collect(feed, cutoff):
    outlet, topic, url = feed
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; PhemeRSS/1.0)"})
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000 or b"<!DOCTYPE" in body.upper():
        raise ValueError("Unexpected feed payload")
    root = ET.fromstring(body)
    entries = (
        root.findall(".//item")
        or root.findall(f".//{ATOM_NS}entry")
        or root.findall(f".//{RSS1_NS}item")
    )
    items = []
    for entry in entries:
        title = first_text(entry, ("title", f"{ATOM_NS}title", f"{RSS1_NS}title"))
        link = first_link(entry)
        raw_date = first_text(
            entry,
            ("pubDate", "published", "updated", f"{ATOM_NS}published", f"{ATOM_NS}updated", f"{DC_NS}date"),
        )
        published = parse_timestamp(raw_date)
        if not published:
            continue
        if title and urllib.parse.urlsplit(link).scheme == "https" and published >= cutoff:
            items.append(
                dict(
                    outlet=outlet,
                    topic=topic,
                    title=title,
                    url=link,
                    published=published.isoformat(),
                )
            )
    return items


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=2)
    groups = {}
    errors = []
    urls = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        jobs = [(feed, pool.submit(collect, feed, cutoff)) for feed in FEEDS]
        for feed, job in jobs:
            try:
                for item in job.result():
                    if item["url"] in urls:
                        continue
                    urls.add(item["url"])
                    key = " ".join(re.findall(r"\w+", item["title"].casefold()))
                    groups.setdefault(key, []).append(item)
            except (OSError, ValueError, ET.ParseError) as error:
                errors.append({"outlet": feed[0], "url": feed[2], "error": str(error)})
    candidates = sorted(
        groups.values(),
        key=lambda group: max(datetime.datetime.fromisoformat(item["published"]) for item in group),
        reverse=True,
    )
    print(
        json.dumps(
            {
                "collectedAt": now.isoformat(),
                "feedCount": len(FEEDS),
                "candidateGroups": candidates,
                "feedErrors": errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if candidates else 1


if __name__ == "__main__":
    sys.exit(main())
