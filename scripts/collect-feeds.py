"""Collect RSS/Atom candidates for an editor from the 500 feeds in feeds/feeds.json, across UK, World, Science, Tech, Business and Finance.
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
from pathlib import Path

FEEDS_FILE = Path(__file__).resolve().parent.parent / "feeds" / "feeds.json"
# 500 tested feeds; see feeds/candidates.json and the "Check candidate feeds" workflow.
FEEDS = [(f["outlet"], f["topic"], f["url"]) for f in json.loads(FEEDS_FILE.read_text())]

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
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        jobs = [(feed, pool.submit(collect, feed, cutoff)) for feed in FEEDS]
        for feed, job in jobs:
            try:
                for item in job.result():
                    if item["url"] in urls:
                        continue
                    urls.add(item["url"])
                    key = " ".join(re.findall(r"\w+", item["title"].casefold()))
                    groups.setdefault(key, []).append(item)
            except (OSError, ValueError, ET.ParseError, UnicodeError) as error:
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
