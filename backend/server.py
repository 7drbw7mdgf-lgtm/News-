"""Pheme standalone reader API and scheduled publisher-feed collector.

Runs on Railway without Pheme's website hosting, serves only previously
collected data, and pushes metadata to Supabase through a secured Edge Function.
Publisher full text is never collected unless permissions explicitly allow it.
"""
import concurrent.futures
import datetime
import importlib.util
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from runpy import run_path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(os.environ.get("PHEME_CACHE_DIR", "/tmp/pheme-reader"))
CACHE_FILE = CACHE_DIR / "index.json"
FEED_FILE = CACHE_DIR / "publisher-feeds.json"
REFRESH_SECONDS = max(900, int(os.environ.get("PHEME_REFRESH_SECONDS", "1800")))
MAX_FEEDS = max(5, min(80, int(os.environ.get("PHEME_MAX_FEEDS", "48"))))
ALLOWED_ORIGIN = "https://pheme24.online"

STATE = {"status": "starting", "lastSuccess": None, "lastAttempt": None, "articleCount": 0, "error": None}
LOCK = threading.RLock()
ITEMS = {}

spec = importlib.util.spec_from_file_location("pheme_reader", ROOT / "scripts" / "build-publisher-reader.py")
READER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(READER)

corroboration_spec = importlib.util.spec_from_file_location("pheme_corroboration", ROOT / "backend" / "corroboration.py")
CORROBORATION = importlib.util.module_from_spec(corroboration_spec)
corroboration_spec.loader.exec_module(CORROBORATION)

octal_spec = importlib.util.spec_from_file_location("pheme_octal", ROOT / "backend" / "octal_engine.py")
OCTAL = importlib.util.module_from_spec(octal_spec)
octal_spec.loader.exec_module(OCTAL)

primary_cost_spec = importlib.util.spec_from_file_location("pheme_primary_costs", ROOT / "backend" / "primary_costs.py")
PRIMARY_COSTS = importlib.util.module_from_spec(primary_cost_spec)
primary_cost_spec.loader.exec_module(PRIMARY_COSTS)

resource_graph_spec = importlib.util.spec_from_file_location("pheme_resource_graph", ROOT / "backend" / "resource_graph.py")
RESOURCE_GRAPH = importlib.util.module_from_spec(resource_graph_spec)
resource_graph_spec.loader.exec_module(RESOURCE_GRAPH)


def read_cached():
    global ITEMS
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data.get("items"), dict):
            return
        with LOCK:
            ITEMS = data["items"]
            STATE["articleCount"] = len(ITEMS)
    except (OSError, ValueError):
        pass


def pick_feeds():
    """Cap collection cost and spread it across verified publisher outlets."""
    locations = json.loads((ROOT / "feeds" / "publisher-locations.json").read_text(encoding="utf-8"))
    configured = json.loads((ROOT / "feeds" / "feeds.json").read_text(encoding="utf-8"))
    selected, seen, per_publisher = [], set(), {}
    for feed in configured:
        name, url = feed.get("outlet", ""), feed.get("url", "")
        if name not in locations or not isinstance(url, str) or not url.startswith("https://"):
            continue
        if url in seen or per_publisher.get(name, 0) >= 2:
            continue
        selected.append((name, feed.get("topic", ""), url))
        seen.add(url)
        per_publisher[name] = per_publisher.get(name, 0) + 1
        if len(selected) >= MAX_FEEDS:
            break
    return selected


def collect_rss():
    collectors = run_path(str(ROOT / "scripts" / "collect-feeds.py"), run_name="pheme_reader_collect")
    collect = collectors["collect"]
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
    grouped = {}
    succeeded = 0
    feeds = pick_feeds()
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(collect, feed, cutoff): feed[0] for feed in feeds}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                found = future.result()
                succeeded += 1
            except Exception as exc:
                print("Feed skipped:", name, type(exc).__name__, flush=True)
                continue
            items = grouped.setdefault(name, [])
            for a in found:
                if READER.canonical(a.get("url")):
                    items.append({
                        "url": a["url"],
                        "title": str(a.get("title", ""))[:320],
                        "summary": str(a.get("excerpt") or a.get("summary") or "")[:1200],
                        "published": a.get("published", ""),
                        "image": a.get("image", ""),
                    })
    if not succeeded:
        raise RuntimeError("No publisher feeds responded; retaining the last good cache")
    result = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "publishers": {}}
    for name, rows in grouped.items():
        unique, dedup = [], set()
        for row in sorted(rows, key=lambda x: x["published"], reverse=True):
            key = READER.canonical(row["url"])
            if key and key not in dedup:
                dedup.add(key)
                unique.append(row)
            if len(unique) == 35:
                break
        result["publishers"][name] = {"articles": unique, "status": "ok"}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    FEED_FILE.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return succeeded


def publish_to_supabase(items):
    endpoint = os.environ.get("PHEME_SUPABASE_INGEST_URL", "")
    token = os.environ.get("PHEME_SUPABASE_INGEST_TOKEN", "")
    if not endpoint or not token:
        print("Supabase push not configured; serving local cache", flush=True)
        return
    rows = []
    for url, item in items.items():
        rows.append({
            "canonical_url": url, "publisher": str(item.get("publisher", ""))[:120],
            "title": str(item.get("title", ""))[:320],
            "summary": str(item.get("summary", ""))[:1200],
            "published_at": item.get("published") or None,
            "image_url": str(item.get("image", ""))[:1500],
            "status": item.get("status", "rss"),
            "editorial_context": str(item.get("context", ""))[:500],
        })
    total = 0
    for start in range(0, len(rows), 75):
        payload = json.dumps({"articles": rows[start:start + 75]}).encode("utf-8")
        req = urllib.request.Request(endpoint, data=payload, method="POST", headers={
            "Content-Type": "application/json",
            "x-pheme-ingest-token": token,
            "User-Agent": "PhemeReader/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                if response.status not in (200, 201):
                    raise RuntimeError("Supabase refused batch")
                response.read(1024)
                total += len(rows[start:start + 75])
        except (urllib.error.URLError, RuntimeError, TimeoutError) as exc:
            print("Supabase sync failed:", type(exc).__name__, str(exc)[:140], flush=True)
            break
    print("Supabase synced", total, "records", flush=True)


def refresh():
    global ITEMS
    with LOCK:
        STATE["status"] = "refreshing"
        STATE["lastAttempt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        STATE["error"] = None
    try:
        sources = collect_rss()
        data = READER.build(FEED_FILE, CACHE_DIR)
        if not data["items"]:
            raise RuntimeError("Reader cache is empty")
        # Preserve older results across refreshes and upstream transient outages.
        with LOCK:
            updated = dict(ITEMS)
            updated.update(data["items"])
            ITEMS = updated
            STATE["articleCount"] = len(ITEMS)
            STATE["lastSuccess"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            STATE["status"] = "ready"
        tmp = CACHE_DIR / "index.tmp"
        tmp.write_text(json.dumps({"items": updated}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(CACHE_FILE)
        publish_to_supabase(updated)
        print("Reader refreshed:", sources, "feeds;", len(updated), "articles", flush=True)
    except Exception as exc:
        with LOCK:
            STATE["status"] = "degraded"
            STATE["error"] = type(exc).__name__ + ": " + str(exc)[:180]
        print("Reader refresh failure:", STATE["error"], flush=True)


def scheduler():
    while True:
        refresh()
        time.sleep(REFRESH_SECONDS)


class Handler(BaseHTTPRequestHandler):
    def respond(self, body, code=200):
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=60" if code == 200 else "no-store")
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(path.query)
        if path.path == "/health":
            with LOCK:
                snapshot = dict(STATE)
            self.respond({"service": "pheme-reader", **snapshot})
            return
        if path.path == "/v1/article":
            url = (query.get("url") or [""])[0]
            key = READER.canonical(url)
            with LOCK:
                item = ITEMS.get(key)
            if not key or not item:
                self.respond({"error": "Article not in verified cache"}, 404)
            else:
                self.respond({"url": key, **item})
            return
        if path.path == "/v1/corroborate":
            url = (query.get("url") or [""])[0]
            key = READER.canonical(url)
            if not key:
                self.respond({"error": "Invalid article URL"}, 400)
                return
            with LOCK:
                snapshot = dict(ITEMS)
            if key not in snapshot:
                self.respond({"error": "Article not in verified cache"}, 404)
                return
            # Only use publisher-authored article previews, not Pheme's
            # contextual editorial summaries, as evidence.
            self.respond(CORROBORATION.corroborate(key, snapshot))
            return
        if path.path == "/v1/infer":
            url = (query.get("url") or [""])[0]
            key = READER.canonical(url)
            if not key:
                self.respond({"error": "Invalid article URL"}, 400)
                return
            with LOCK:
                snapshot = dict(ITEMS)
            if key not in snapshot:
                self.respond({"error": "Article not in verified cache"}, 404)
                return
            assessed = CORROBORATION.corroborate(key, snapshot)
            self.respond({
                "article": key,
                "engine": "PHEME-8",
                "model": "octal-normalized-multiplication-and-filtering-v2",
                "inference": OCTAL.infer_from_corroboration(assessed),
            })
            return
        if path.path == "/v1/resource-graph":
            self.respond({
                "graph": RESOURCE_GRAPH.EXAMPLE,
                "schema": {"nodeTypes": list(RESOURCE_GRAPH.NODE_TYPES),
                           "relations": {name: [list(pair) for pair in pairs]
                                         for name, pairs in RESOURCE_GRAPH.RELATIONS.items()},
                           "units": list(RESOURCE_GRAPH.UNITS)},
                "validation": RESOURCE_GRAPH.validate(RESOURCE_GRAPH.EXAMPLE),
                "status": "illustrative-structure-only",
            })
            return
        if path.path == "/v1/primary-costs":
            industry = (query.get("industry") or [None])[0]
            try:
                self.respond(PRIMARY_COSTS.taxonomy(industry))
            except ValueError:
                self.respond({"error": "Unknown industry profile"}, 400)
            return
        if path.path == "/v1/articles":
            try:
                limit = max(1, min(100, int((query.get("limit") or ["30"])[0])))
            except (TypeError, ValueError):
                limit = 30
            with LOCK:
                articles = [{"url": key, **value} for key, value in list(ITEMS.items())[-limit:]]
            self.respond({"articles": articles, "count": len(articles)})
            return
        self.respond({"error": "Not found"}, 404)

    def log_message(self, format, *args):
        if not self.path.startswith("/health"):
            print("HTTP:", format % args, flush=True)


def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    read_cached()
    port = int(os.environ.get("PORT", "8080"))
    threading.Thread(target=scheduler, name="feed-collector", daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Pheme reader API listening on", port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
