"""Server-side Pheme publisher reader.

Builds a static, first-party index of reader previews from publisher RSS.
Full HTML extraction is ONLY enabled for publishers explicitly authorised in
feeds/reader-permissions.json, and only where robots.txt permits automated access.

Never fetches arbitrary user-provided URLs, uses no proxy, and doesn't bypass
logins, paywalls or anti-bot protections.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import html
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = "PhemeReader/1.0 (+https://pheme24.online/)"
MAX_BYTES = 2_000_000
MAX_ARTICLES = 36


def canonical(raw):
    parsed = urllib.parse.urlsplit(raw or "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        return ""
    return urllib.parse.urlunsplit(("https", parsed.hostname.lower(), parsed.path.rstrip("/") or "/", "", "")).lower()


def safe_public_host(host):
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return bool(infos) and all(ipaddress.ip_address(item[4][0]).is_global for item in infos)
    except (OSError, ValueError):
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def fetch_bounded(url, host, accept, max_bytes=MAX_BYTES):
    # Reject private-network requests and redirects, including 30x to other hosts.
    if not canonical(url) or urllib.parse.urlsplit(url).hostname.lower() != host or not safe_public_host(host):
        raise ValueError("Unsafe article URL")
    req = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": accept})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=9) as res:
        if getattr(res, "status", 200) != 200:
            raise ValueError("Non-200 response")
        kind = res.headers.get("Content-Type", "")
        if not ("text/html" in kind or "text/plain" in kind):
            raise ValueError("Unexpected content type")
        raw = res.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError("Article response too large")
        return raw.decode("utf-8", "replace")


def robots_allows(host, path):
    url = "https://" + host + "/robots.txt"
    if not safe_public_host(host):
        return False
    try:
        raw = fetch_bounded(url, host, "text/plain", 500_000)
        robots = urllib.robotparser.RobotFileParser()
        robots.parse(raw.splitlines())
        return robots.can_fetch(AGENT, "https://" + host + path)
    except Exception:
        # No ambiguity: unknown robots access is not permission.
        return False


class BasicArticleParser(HTMLParser):
    """Small dependency-free readable-text extractor; removes scripts/navigation."""
    BLOCK = {"p", "h1", "h2", "h3", "blockquote", "li"}
    SKIP = {"script", "style", "nav", "footer", "aside", "form", "button", "noscript", "header"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.article_depth = 0
        self.found_article = False
        self.current = []
        self.paragraphs = []
    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "article":
            self.article_depth += 1
            self.found_article = True
        if tag in self.BLOCK and not self.skip:
            self.current = []
    def handle_endtag(self, tag):
        if tag in self.BLOCK and not self.skip:
            value = re.sub(r"\s+", " ", "".join(self.current)).strip()
            if len(value) > 50 and (self.article_depth or not self.found_article):
                self.paragraphs.append(value[:4000])
            self.current = []
        if tag == "article":
            self.article_depth = max(0, self.article_depth - 1)
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
    def handle_data(self, data):
        if not self.skip:
            self.current.append(data)


def authorised_rules():
    path = ROOT / "feeds" / "reader-permissions.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    rules = {}
    for rule in data.get("authorisedPublishers", []):
        name, host = rule.get("publisher"), rule.get("host")
        if (not isinstance(name, str) or not isinstance(host, str) or
                not re.fullmatch(r"[a-z0-9.-]+", host) or not rule.get("permissionConfirmed")):
            raise ValueError("Invalid or unconfirmed reader permission entry")
        rules[name] = host.lower()
    return rules


def extract_one(item, host):
    _, article = item
    url = article["url"]
    if urllib.parse.urlsplit(url).hostname.lower() != host:
        return None
    url_path = urllib.parse.urlsplit(url).path
    if not robots_allows(host, url_path):
        return None
    markup = fetch_bounded(url, host, "text/html")
    parser = BasicArticleParser()
    parser.feed(markup)
    paras = parser.paragraphs[:65]
    if len(" ".join(paras)) < 400:
        return None
    return {"paragraphs": paras, "extractedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}



def edition_references(path=None):
    """Read the edition's existing source links without fetching publisher HTML.

    Older articles can disappear from the rolling RSS feeds. Retain their
    publisher-specific headlines as *references*, not claimed full articles.
    """
    path = Path(path or ROOT / "assets" / "data.js")
    if not path.exists():
        return []
    source = path.read_text(encoding="utf-8")
    start_marker = "window.DAYBREAK = "
    end_marker = ";\nwindow.DAYBREAK_ARCHIVE"
    start = source.find(start_marker)
    end = source.find(end_marker, start)
    if start < 0 or end < 0:
        raise ValueError("Current Pheme edition JSON markers not found")
    edition = json.loads(source[start + len(start_marker):end])
    archive_marker = "window.DAYBREAK_ARCHIVE = "
    archive_start = source.find(archive_marker, end)
    archive = []
    if archive_start >= 0:
        archive_source = source[archive_start + len(archive_marker):].strip()
        archive = json.loads(archive_source.removesuffix(";"))
    result = []
    current = [(story, edition.get("COVERAGE", {}).get(story.get("id"), []))
               for story in edition.get("STORIES", [])]
    previous = [(story, story.get("coverage", [])) for story in archive]
    for story, coverage in current + previous:
        for row in coverage:
            if len(row) < 3 or not isinstance(row[2], str):
                continue
            publisher, date, url = row[:3]
            # Older archive links often have no publisher-specific article
            # title. Never misattribute Pheme's editorial headline to them.
            title = row[3] if len(row) > 3 and row[3] else ""
            if not isinstance(publisher, str) or not isinstance(title, str):
                continue
            result.append({
                "publisher": publisher, "title": title, "url": url,
                "published": "", "dateLabel": date, "status": "edition-reference",
                "summary": "", "image": "",
                "context": str(story.get("summary") or "")[:500],
                "editorialHeadline": str(story.get("headline") or "")[:320],
            })
    return result

def build(feed_path, out_dir, limit=MAX_ARTICLES):
    data = json.loads(Path(feed_path).read_text(encoding="utf-8"))
    rules = authorised_rules()
    publishers = data.get("publishers", {})
    out_dir.mkdir(parents=True, exist_ok=True)
    preview = {}
    to_fetch = []
    for publisher, entry in publishers.items():
        for article in entry.get("articles", [])[:35]:
            url = article.get("url", "")
            key = canonical(url)
            if not key or key in preview:
                continue
            preview[key] = {
                "publisher": publisher,
                "title": article.get("title", "")[:320],
                "summary": str(article.get("summary", ""))[:1000],
                "published": article.get("published", ""),
                "image": article.get("image", ""),
                "status": "rss",
            }
            host = rules.get(publisher)
            if host and urllib.parse.urlsplit(url).hostname == host and len(to_fetch) < limit:
                to_fetch.append((key, article, host))

    # Add article references from the current editorial edition even if they
    # disappeared from the seven-day RSS feed. No unlicensed article HTML is
    # downloaded or republished.
    for reference in edition_references():
        key = canonical(reference["url"])
        if not key:
            continue
        if key not in preview:
            preview[key] = {field: value for field, value in reference.items() if field != "url"}
        elif not preview[key].get("context"):
            preview[key]["context"] = reference["context"]

    # A website cannot be made a full-text syndication service just because
    # publicly visible HTML can be downloaded. Require explicit permission.
    if to_fetch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(extract_one, (key, article), host): key for key, article, host in to_fetch}
            for future in concurrent.futures.as_completed(futures):
                key = futures[future]
                try:
                    result = future.result()
                    if result:
                        preview[key].update(result)
                        preview[key]["status"] = "licensed-full-text"
                except Exception as exc:
                    print("Reader extraction skipped (" + type(exc).__name__ + ")")

    output = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "contentPolicy": "RSS metadata; full-text only for explicitly licensed publishers",
        "items": preview,
    }
    (out_dir / "index.json").write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Reader cache built: {len(preview)} source entries, " +
          f"{sum(v['status'] == 'edition-reference' for v in preview.values())} older edition references, " +
          f"{sum(v['status'] == 'licensed-full-text' for v in preview.values())} authorised full articles.")
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--feed", default=str(ROOT / "assets" / "publisher-feeds.json"))
    parser.add_argument("--out", default=str(ROOT / "build" / "site" / "assets" / "reader-cache"))
    args = parser.parse_args()
    build(args.feed, Path(args.out))


if __name__ == "__main__":
    main()
