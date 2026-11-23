"""Source records and verified plan revisions for the Phemica program."""

import argparse
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
SOURCE_STATUSES = {"rss", "publisher-metadata", "licensed-full-text"}
PLAN_STATUSES = {"announced", "amended", "postponed", "withdrawn", "confirmed", "restarted"}


def iso_day(value):
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("Expected a YYYY-MM-DD public date")
    return parsed


def publisher_timestamp(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp.isoformat() if stamp.tzinfo is not None else None


def https_url(value):
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname and
                 not parsed.username and not parsed.password and parsed.port in (None, 443))
    except (ValueError, TypeError, AttributeError):
        valid = False
    return bool(valid)


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def source_records(snapshot, observed):
    records = []
    for url, item in sorted(snapshot["items"].items()):
        if item.get("status") not in SOURCE_STATUSES or not https_url(url):
            continue
        publisher = item.get("publisher") or ""
        title = (item.get("title") or "").strip()
        excerpt = (item.get("summary") or "").strip()
        if not publisher or not (title or excerpt):
            continue
        evidence = {
            "canonicalUrl": url,
            "publisher": publisher,
            "publisherTitle": title or None,
            "publisherExcerpt": excerpt or None,
            "publishedAt": publisher_timestamp(item.get("published")),
            "sourceType": item["status"],
        }
        records.append({
            **evidence,
            "articleId": digest(url),
            "versionId": digest(evidence),
            "observedAt": observed,
            "originId": None,
        })
    return records


def plan_records(records):
    """Validate an append-only sequence of source-backed plan assertions."""
    versions = {}
    latest = {}
    output = []
    for item in sorted(records, key=lambda row: (row["publicAvailableOn"], row["id"])):
        key = item["planId"]
        identifier = item["id"]
        previous = latest.get(key)
        public_day = iso_day(item["publicAvailableOn"])
        effective = item["effectiveOn"]
        latest_effective = item["effectiveBy"]
        if effective is not None:
            iso_day(effective)
        if latest_effective is not None:
            iso_day(latest_effective)
            if effective is not None and iso_day(effective) > iso_day(latest_effective):
                raise ValueError(f"Effective date is outside the reported window: {identifier}")
        if (not all(item[field] for field in ("id", "planId", "company", "site", "process",
                                             "originId", "sourceLabel", "evidence"))
                or item["status"] not in PLAN_STATUSES or not https_url(item["sourceUrl"])):
            raise ValueError(f"Invalid verified plan event: {identifier}")
        if identifier in versions or (previous is None and item["status"] != "announced"):
            raise ValueError(f"Invalid initial state or duplicate revision: {identifier}")
        if item["supersedes"] != (previous["id"] if previous else None):
            raise ValueError(f"Revision must supersede the current event: {identifier}")
        if previous and (public_day <= iso_day(previous["publicAvailableOn"]) or
                         any(item[k] != previous[k] for k in ("company", "site", "process")) or
                         item["status"] == "announced"):
            raise ValueError(f"Revision date, scope or state is ambiguous: {identifier}")
        versions[identifier] = item
        latest[key] = item
        output.append(item)
    return output


def plans_as_of(feed, cutoff):
    """Reduce verified revisions using the source's public day, inclusive."""
    if feed["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("Unsupported Phemica input schema")
    day = iso_day(cutoff)
    latest = {}
    for event in plan_records(feed["planEvents"]):
        if iso_day(event["publicAvailableOn"]) <= day:
            latest[event["planId"]] = event
    return latest


def build_input(snapshot, verified_events, revision=None):
    observed = publisher_timestamp(snapshot.get("generatedAt"))
    if not observed:
        raise ValueError("Reader snapshot needs an offset-aware generatedAt timestamp")
    articles = source_records(snapshot, observed)
    if not articles:
        raise ValueError("Reader snapshot contains no publisher evidence candidates")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "siteRevision": revision,
        "observedAt": observed,
        "articles": articles,
        "planEvents": plan_records(verified_events),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--revision")
    args = parser.parse_args()

    def read(path):
        return json.loads(path.read_text(encoding="utf-8"))

    feed = build_input(read(args.reader), read(args.events), args.revision)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(feed, ensure_ascii=False, separators=(",", ":")) + "\n",
                        encoding="utf-8")
    print(f"Phemica input: {len(feed['articles'])} candidates, "
          f"{len(feed['planEvents'])} verified plan revisions")


if __name__ == "__main__":
    main()
