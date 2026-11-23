"""Conservative cross-publisher proposition matching for the Pheme RSS cache.

This first-pass rules engine returns traceable corroboration candidates, not a
fact-check verdict, calibrated truth probabilities, financial advice or trades.
Only publisher-authored titles and excerpts qualify; Pheme's editorial summaries
are intentionally excluded from claim detection.
"""
import datetime
import re
import urllib.parse
from collections import defaultdict

EVENTS = (
    ("rate_cut", r"\b(?:cuts?|cutting|lower(?:s|ed|ing)?|reduc(?:es?|ed|ing))\b.{0,50}\b(?:interest rates?|policy rates?|base rates?)\b|\b(?:interest rates?|policy rates?|base rates?)\b.{0,50}\b(?:cuts?|lower(?:s|ed|ing)?|reduc(?:es?|ed|ing))\b",
     r"\b(?:raises?|raised|raising|hikes?|hiked|hiking|increas(?:es?|ed|ing))\b.{0,50}\b(?:interest rates?|policy rates?|base rates?)\b|\b(?:interest rates?|policy rates?|base rates?)\b.{0,50}\b(?:raises?|raised|raising|hikes?|hiked|hiking|increas(?:es?|ed|ing))\b"),
    ("inflation_down", r"\b(?:inflation|consumer prices?|cpi)\b.{0,55}\b(?:falls?|fell|drop(?:s|ped)?|declin(?:es?|ed)|cool(?:s|ed|ing)?|slow(?:s|ed|ing)?)\b|\b(?:falling|cooling|slowing)\s+(?:inflation|consumer prices?)\b",
     r"\b(?:inflation|consumer prices?|cpi)\b.{0,55}\b(?:ris(?:es|ing)|rose|surges?|increas(?:es?|ed|ing)|accelerat(?:es?|ed|ing)?)\b|\b(?:rising|surging)\s+(?:inflation|consumer prices?)\b"),
    ("earnings_beat", r"\b(?:earnings|profits?|revenues?|results?)\b.{0,65}\b(?:beat(?:s|ing)?|exceed(?:s|ed)?|tops?|above)\b.{0,25}\b(?:forecast|expectations?|estimates?|consensus)\b|\b(?:beat(?:s|ing)?|exceed(?:s|ed)?|tops?)\b.{0,25}\b(?:earnings|profit|revenue)\b",
     r"\b(?:earnings|profits?|revenues?|results?)\b.{0,65}\b(?:miss(?:es|ed)?|below|fall(?:s|ing)? short)\b.{0,25}\b(?:forecast|expectations?|estimates?|consensus)\b|\b(?:miss(?:es|ed)?|below)\b.{0,25}\b(?:earnings|profit|revenue)\b"),
)
ENTITY_RULES = (
    ("bank-of-england", r"\b(?:bank of england|boe)\b"),
    ("federal-reserve", r"\b(?:federal reserve|the fed|fed chair|fomc)\b"),
    ("ecb", r"\b(?:european central bank|ecb)\b"),
    ("bank-of-japan", r"\b(?:bank of japan|boj)\b"),
    ("uk", r"\b(?:uk|britain|british|united kingdom)\b"),
    ("us", r"\b(?:us|u\.s\.|america|american|united states)\b"),
    ("eurozone", r"\b(?:eurozone|euro area)\b"),
    ("japan", r"\bjapan(?:ese)?\b"),
)
HEDGES = re.compile(r"\b(?:may|might|could|possibly|potentially|consider(?:s|ing)?|expects?|expected|forecast|predict(?:s|ed)?|plans?|planned|rumou?r(?:s|ed)?|reportedly|likely|unlikely|if|would|should)\b", re.I)
DENIALS = re.compile(r"\b(?:den(?:y|ies|ied)|rules? out|no plans? to|not going to|won't|will not|reject(?:s|ed)?)\b", re.I)
SPACE = re.compile(r"\s+")
WORD = re.compile(r"[a-z0-9]+")
MAX_ARTICLE_AGE_HOURS = 96


def _time(value):
    if not value:
        return None
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(datetime.timezone.utc)
    except (ValueError, TypeError):
        return None


def _fresh(published, now):
    stamp = _time(published)
    if stamp is None:
        return False
    seconds = (now - stamp).total_seconds()
    return -3600 <= seconds <= MAX_ARTICLE_AGE_HOURS * 3600


def _publisher_group(publisher):
    """A publisher is the minimum independence unit, not an article count."""
    return SPACE.sub(" ", str(publisher or "").casefold().strip())


def _content(item):
    """Never mistake Pheme-written context for source-reported evidence."""
    if item.get("status") == "edition-reference":
        return ""
    return SPACE.sub(" ", " ".join([
        str(item.get("title") or "")[:320],
        str(item.get("summary") or "")[:800],
    ]).strip())


def _entity(text):
    for key, regex in ENTITY_RULES:
        if re.search(regex, text, re.I):
            return key
    return None


def _fingerprint(title):
    return " ".join(WORD.findall(str(title or "").casefold()))[:220]


def propositions_for_article(url, item, now=None):
    """Detect explicit single-event economic claims only, preserving provenance.

    Ambiguous subjects, speculative/negated claims and undated items are not
    counted as confirmation; they are surfaced as limitations where possible.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    title = str(item.get("title") or "")
    text = _content(item)
    entity = _entity(text)
    if not text or not entity:
        return []
    published = item.get("published") or ""
    fresh = _fresh(published, now)
    found = []
    for event, positive, contrary in EVENTS:
        matched_pos = re.search(positive, text, re.I)
        matched_neg = re.search(contrary, text, re.I)
        if not matched_pos and not matched_neg:
            continue
        if matched_pos and matched_neg:
            continue  # competing assertions in one article require deeper parsing
        match = matched_pos or matched_neg
        # Prevent unsupported article-level speculation from becoming confirmation.
        window = text[max(0, match.start()-75): min(len(text), match.end()+55)]
        speculative = bool(HEDGES.search(window))
        denial = bool(DENIALS.search(window))
        stance = "against" if matched_neg else "for"
        if speculative or denial:
            stance = "qualified"
        # Text strength is intentionally independent from publisher reliability.
        found.append({
            "key": entity + ":" + event,
            "entity": entity, "event": event, "stance": stance,
            "publisher": str(item.get("publisher") or ""),
            "url": url, "headline": title, "published": published,
            "quote": window[:180],
            "fresh": fresh,
            "eligible": bool(fresh and not speculative and not denial),
            "limitation": "speculative-or-denied" if (speculative or denial) else ("missing-or-stale-time" if not fresh else None),
            "fingerprint": _fingerprint(title),
        })
    return found


def corroborate(url, items, now=None):
    """Corroborate claims extracted from one target against other publishers.

    Includes only propositions with the same *entity and event*; do not
    interpret publication count as statistical independence or truth.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    target = items.get(url)
    if not target:
        return {"error": "Article not in cache"}
    premises = propositions_for_article(url, target, now)
    if not premises:
        return {"url": url, "propositions": [],
                "note": "No sufficiently explicit, entity-linked proposition identified in accessible source metadata."}
    desired = set(p["key"] for p in premises)
    evidence = defaultdict(list)
    for candidate_url, item in items.items():
        if not item.get("publisher"):
            continue
        for proposition in propositions_for_article(candidate_url, item, now):
            if proposition["key"] in desired:
                evidence[proposition["key"]].append(proposition)
    output = []
    for premise in premises:
        records = sorted(evidence[premise["key"]], key=lambda a: a.get("published") or "", reverse=True)
        # Independently corroborating publishers must differ from the target.
        # If two outlets share identical headlines, treat them as a possible
        # syndicated cluster rather than two independently verified reports.
        by_source = {}
        seen_titles = {}
        for row in records:
            if not row["eligible"]:
                continue
            source = _publisher_group(row["publisher"])
            if not source:
                continue
            if source not in by_source:
                by_source[source] = row
        for source, row in by_source.items():
            fp = row["fingerprint"]
            if fp and fp in seen_titles and seen_titles[fp] != source:
                row = dict(row, possibleSyndication=True)
            elif fp:
                seen_titles[fp] = source
            by_source[source] = row
        anchor = _publisher_group(premise["publisher"])
        supporters = [row for source,row in by_source.items() if source != anchor and row["stance"] == premise["stance"] and row["stance"] != "qualified" and not row.get("possibleSyndication")]
        contradictors = [row for source,row in by_source.items() if source != anchor and row["stance"] != premise["stance"] and row["stance"] != "qualified" and not row.get("possibleSyndication")]
        if not premise["eligible"] or premise["stance"] == "qualified":
            grade = None
            status = "unresolved"
        elif contradictors:
            grade = None
            status = "contested"
        elif len(supporters) >= 3:
            grade = 6
            status = "cross-source-support"
        elif len(supporters) == 2:
            grade = 5
            status = "cross-source-support"
        elif len(supporters) == 1:
            grade = 4
            status = "limited-cross-source-support"
        else:
            grade = None
            status = "unverified"
        output.append({
            "key": premise["key"], "entity": premise["entity"],
            "event": premise["event"], "targetStance": premise["stance"],
            "status": status, "supportingPublishers": len(supporters),
            "contradictingPublishers": len(contradictors),
            "octalCorroboration": grade,
            "scoreMeaning": "Amount of independent publisher corroboration, NOT proposition truth, source credibility, or trade probability",
            "anchor": premise,
            "supporting": supporters[:15], "contradicting": contradictors[:15],
            "qualified": [a for a in records if a["stance"] == "qualified"][:8],
            "caveats": [
                "RSS headline/description matching, not article-body fact-checking",
                "Publisher names are a provisional independence proxy; identical headlines are deduplicated",
                "Publishers may share primary sources, ownership, wires or reporting errors",
                "No trading action is inferred from corroboration",
            ],
        })
    return {"url": url, "propositions": output, "evaluatedAt": now.isoformat()}
