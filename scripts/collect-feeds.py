"""Collect RSS/Atom candidates for an editor from the 500 feeds in feeds/feeds.json, across UK, World, Science, Tech, Business and Finance.
Output never replaces the public edition automatically.
"""

import concurrent.futures
import datetime
import email.utils
import html
from html.parser import HTMLParser
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
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}"
MEDIA_NS = "{http://search.yahoo.com/mrss/}"
IMG_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|avif)(?:\?|$)", re.I)
BAD_FEED_IMG_RE = re.compile(r"(?:logo|favicon|icon|avatar|placeholder|0_brand\.|/ALTERNATES/s(?:98|120)/|\.svg(?:\?|$)|\.ico(?:\?|$))", re.I)


def first_image(node):
    """Return the best high-resolution HTTPS image URL embedded in an RSS/Atom entry."""
    candidates = []
    for el in node.iter():
        tag = el.tag
        if tag in ("enclosure", f"{MEDIA_NS}content", f"{MEDIA_NS}thumbnail") or tag.endswith("}content") or tag.endswith("}thumbnail"):
            url = (el.attrib.get("url") or el.attrib.get("href") or "").strip()
            if not url:
                continue
            mime = (el.attrib.get("type") or "").lower()
            medium = (el.attrib.get("medium") or "").lower()
            if mime and not mime.startswith("image/"):
                continue
            if not mime and medium and medium != "image":
                continue
            if not mime and not medium and not IMG_EXT_RE.search(url) and "thumbnail" not in tag.lower():
                continue
            parts = urllib.parse.urlsplit(url)
            if parts.scheme == "http":
                url = urllib.parse.urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))
                parts = urllib.parse.urlsplit(url)
            if parts.scheme != "https" or not parts.netloc or parts.username or parts.password:
                continue
            if BAD_FEED_IMG_RE.search(parts.path + ("?" + parts.query if parts.query else "")):
                continue
            try:
                width = int(el.attrib.get("width") or 0)
            except ValueError:
                width = 0
            # Prefer enclosure / media:content over small thumbnails when width is omitted.
            rank = (width, 1 if "thumbnail" not in tag.lower() else 0)
            candidates.append((rank, url))
    if not candidates:
        return ""
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    return candidates[0][1]


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


def element_markup(node):
    """Return an RSS element's inner markup, retaining any paragraph structure."""
    parts = [node.text or ""]
    for child in node:
        tag = child.tag.rsplit("}", 1)[-1]
        parts.extend(("<", tag, ">", element_markup(child), "</", tag, ">", child.tail or ""))
    return "".join(parts)


def first_markup(node, tags):
    for tag in tags:
        element = node.find(tag)
        if element is not None:
            value = element_markup(element).strip()
            if value:
                return value
    return ""


class ExcerptTextParser(HTMLParser):
    """Convert feed HTML to safe plain text while preserving paragraph breaks."""

    BLOCKS = {"address", "article", "blockquote", "dd", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "pre", "section", "tr", "ul"}
    DROPPED = {"script", "style", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if self.skip_depth:
            if tag in self.DROPPED:
                self.skip_depth += 1
            return
        if tag in self.DROPPED:
            self.skip_depth = 1
        elif tag == "br":
            self.parts.append("\n")
        elif tag in self.BLOCKS:
            self.parts.append("\n\n" if tag in {"p", "div", "article", "section", "blockquote"} else "\n")

    def handle_endtag(self, tag):
        if self.skip_depth:
            if tag in self.DROPPED:
                self.skip_depth = max(0, self.skip_depth - 1)
            return
        if tag in self.BLOCKS:
            self.parts.append("\n\n" if tag in {"p", "div", "article", "section", "blockquote"} else "\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)


def full_excerpt(raw):
    if not raw:
        return ""
    parser = ExcerptTextParser()
    parser.feed(raw)
    parser.close()
    text = "".join(parser.parts)
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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
            # Keep a compact summary for editorial grouping and retain the full RSS
            # excerpt separately for the publisher feed.
            raw_excerpt = first_markup(entry, (
                f"{CONTENT_NS}encoded", f"{ATOM_NS}content", "content",
                "description", f"{ATOM_NS}summary", f"{RSS1_NS}description",
            ))
            excerpt = full_excerpt(raw_excerpt)
            summary = re.sub(r"\s+", " ", excerpt).strip()[:500]
            item = dict(
                outlet=outlet,
                topic=topic,
                title=re.sub(r"\s+", " ", html.unescape(title)).strip(),
                summary=summary,
                excerpt=excerpt,
                url=link,
                published=published.isoformat(),
            )
            image = first_image(entry)
            if image:
                item["image"] = image
            items.append(item)
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
