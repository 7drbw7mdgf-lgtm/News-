"""Publish a separate, regularly refreshed feed for each followed Pheme publisher.

The publisher feed is independent of Pheme's curated editorial edition.
Only published article metadata from the publisher's own RSS/Atom feeds appears here.
"""
import concurrent.futures
import datetime
import json
import re
from pathlib import Path
from runpy import run_path

ROOT = Path(__file__).resolve().parent.parent
_feed_module = run_path(str(ROOT / 'scripts' / 'collect-feeds.py'), run_name='pheme_feed_library')
FEEDS, collect = _feed_module['FEEDS'], _feed_module['collect']
OUTPUT = ROOT / "assets" / "publisher-feeds.json"
LOCATIONS = json.loads((ROOT / "feeds" / "publisher-locations.json").read_text(encoding="utf-8"))
PUBLISHERS = list(LOCATIONS)

MAX_ITEMS = 35


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=7)
    previous = {}
    if OUTPUT.exists():
        try:
            previous = json.loads(OUTPUT.read_text(encoding="utf-8")).get("publishers", {})
        except (ValueError, OSError):
            pass
    entries = {name: [] for name in PUBLISHERS}
    active = [f for f in FEEDS if f[0] in entries]
    successes = {name: 0 for name in PUBLISHERS}
    errors = {name: [] for name in PUBLISHERS}

    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        futures = {pool.submit(collect, feed, cutoff): feed for feed in active}
        for future in concurrent.futures.as_completed(futures):
            name, _, url = futures[future]
            try:
                records = future.result()
                successes[name] += 1
                for record in records:
                    title = re.sub(r"\s+", " ", record.get("title", "")).strip()
                    link = record.get("url", "")
                    if not title or not link.startswith("https://"):
                        continue
                    entries[name].append({
                        "title": title[:320],
                        "summary": record.get("summary", "")[:400],
                        "url": link,
                        "published": record.get("published", ""),
                        "topic": record.get("topic", ""),
                        "image": record.get("image", ""),
                    })
            except Exception as exc:
                errors[name].append(type(exc).__name__ + ": " + str(exc)[:100])

    publishers = {}
    for name in PUBLISHERS:
        seen = set()
        unique = []
        for item in sorted(entries[name], key=lambda x: x["published"], reverse=True):
            key = item["url"].split("#")[0].split("?")[0].rstrip("/")
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
            if len(unique) >= MAX_ITEMS:
                break
        old = previous.get(name, {})
        if successes[name] == 0 and old.get("articles"):
            publishers[name] = {
                "articles": old["articles"], "updatedAt": old.get("updatedAt"),
                "status": "stale", "feedCount": 0, "location": LOCATIONS[name],
            }
        else:
            publishers[name] = {
                "articles": unique,
                "updatedAt": now.isoformat() if successes[name] else None,
                "status": "ok" if successes[name] else "unavailable",
                "feedCount": successes[name], "location": LOCATIONS[name],
            }
    output = {"generatedAt": now.isoformat(), "cadenceMinutes": 60, "publishers": publishers}
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("Publisher feed: {} sources, {} configured RSS feeds, {} responding, {} articles".format(
        len(PUBLISHERS), len(active), sum(successes.values()),
        sum(len(p["articles"]) for p in publishers.values()),
    ))
    for name in PUBLISHERS:
        print("{}: {} articles ({} feeds; {})".format(name, len(publishers[name]["articles"]), successes[name], publishers[name]["status"]))


if __name__ == "__main__":
    main()
