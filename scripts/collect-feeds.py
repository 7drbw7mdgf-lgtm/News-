"""Collect RSS candidates for an editor. Output never replaces the public edition."""

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
    ("BBC News", "world", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("The Guardian", "world", "https://www.theguardian.com/world/rss"),
    ("BBC News", "business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("Ars Technica", "tech", "https://feeds.arstechnica.com/arstechnica/index"),
    ("ScienceDaily", "science", "https://www.sciencedaily.com/rss/top/science.xml"),
]


def collect(feed, cutoff):
    outlet, topic, url = feed
    request = urllib.request.Request(url, headers={"User-Agent": "DaybreakRSS/1.0"})
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read(2_000_001)
    if len(body) > 2_000_000 or b"<!DOCTYPE" in body.upper():
        raise ValueError("Unexpected feed payload")
    items = []
    for entry in ET.fromstring(body).findall("./channel/item"):
        title = (entry.findtext("title") or "").strip()
        link = (entry.findtext("link") or "").strip()
        try:
            published = email.utils.parsedate_to_datetime(entry.findtext("pubDate") or "")
            if published.tzinfo is None:
                continue
        except (TypeError, ValueError, OverflowError):
            continue
        if title and urllib.parse.urlsplit(link).scheme == "https" and published >= cutoff:
            items.append(dict(outlet=outlet, topic=topic, title=title, url=link,
                              published=published.isoformat()))
    return items


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=2)
    groups = {}
    errors = []
    urls = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(FEEDS)) as pool:
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
    candidates = sorted(groups.values(), key=lambda group: max(
        datetime.datetime.fromisoformat(item["published"]) for item in group
    ), reverse=True)
    print(json.dumps({"collectedAt": now.isoformat(), "candidateGroups": candidates,
                      "feedErrors": errors}, ensure_ascii=False, indent=2))
    return 0 if candidates else 1


if __name__ == "__main__":
    sys.exit(main())
