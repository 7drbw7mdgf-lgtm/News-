"""Conservative cross-publisher proposition matching for the Pheme RSS cache.

This first-pass rules engine returns traceable corroboration candidates, not a
fact-check verdict, calibrated truth probabilities, financial advice or trades.
Only publisher-authored titles and excerpts qualify; Pheme's editorial summaries
are intentionally excluded from claim detection.
"""
import datetime
import json
import re
import urllib.parse
from collections import defaultdict
from pathlib import Path

# Rate verbs and nouns. A bare "rates" is accepted only directly after the verb
# (optionally one non-lending word, e.g. "cuts key rates"), so "cuts growth
# forecast as rates stay high" or "cuts mortgage rates" do not count.
_CUT = r"(?:cuts?|cutting|slash(?:es|ed|ing)?|lower(?:s|ed|ing)?|reduc(?:es?|ed|ing))"
_HIKE = r"(?:raises?|raised|raising|hikes?|hiked|hiking|increas(?:es?|ed|ing)|lifts?|lifted|lifting)"
_RATE_NOUN = r"(?:interest|policy|base|bank|benchmark|official) rates?"
_GAP_WORD = r"(?:(?!(?:mortgage|savings|deposit|loan|lending|borrowing|tax|job|growth|fares?|prices?)\b)[a-z]+\s+)?"


def _rate_pattern(verb, noun_form):
    return (rf"\b{verb}\b.{{0,50}}\b{_RATE_NOUN}\b|\b{_RATE_NOUN}\b.{{0,50}}\b{verb}\b"
            rf"|\b{verb}\s+{_GAP_WORD}rates?\b|\brates?\s+{noun_form}\b")


EVENTS = (
    ("rate_cut", _rate_pattern(_CUT, r"cuts?"),
     _rate_pattern(_HIKE, r"(?:hikes?|rises?|increases?)")),
    ("inflation_down", r"\b(?:inflation|consumer prices?|cpi)\b.{0,55}\b(?:falls?|fell|drop(?:s|ped)?|declin(?:es?|ed)|cool(?:s|ed|ing)?|slow(?:s|ed|ing)?)\b|\b(?:falling|cooling|slowing)\s+(?:inflation|consumer prices?)\b",
     r"\b(?:inflation|consumer prices?|cpi)\b.{0,55}\b(?:ris(?:es|ing)|rose|surges?|increas(?:es?|ed|ing)|accelerat(?:es?|ed|ing)?)\b|\b(?:rising|surging)\s+(?:inflation|consumer prices?)\b"),
    ("earnings_beat", r"\b(?:earnings|profits?|revenues?|results?)\b.{0,65}\b(?:beat(?:s|ing)?|exceed(?:s|ed)?|tops?|above)\b.{0,25}\b(?:forecasts?|expectations?|estimates?|consensus)\b|\b(?:beat(?:s|ing)?|exceed(?:s|ed)?|tops?)\b.{0,25}\b(?:earnings|profit|revenue)\b",
     r"\b(?:earnings|profits?|revenues?|results?)\b.{0,65}\b(?:miss(?:es|ed)?|below|fall(?:s|ing)? short)\b.{0,25}\b(?:forecasts?|expectations?|estimates?|consensus)\b|\b(?:miss(?:es|ed)?|below)\b.{0,25}\b(?:earnings|profit|revenue)\b"),
)
# Macro entities. Each claim takes the entity nearest to its own wording, not
# the first entity anywhere in the article. "US" is case-sensitive so the
# pronoun "us" is never read as the United States.
ENTITY_RULES = (
    ("bank-of-england", re.compile(r"\b(?:bank of england|boe)\b", re.I)),
    ("federal-reserve", re.compile(r"\b(?:federal reserve|the fed|fed chair|fomc)\b|\bFed\b", re.I)),
    ("ecb", re.compile(r"\b(?:european central bank|ecb)\b", re.I)),
    ("bank-of-japan", re.compile(r"\b(?:bank of japan|boj)\b", re.I)),
    ("uk", re.compile(r"\b(?:uk|britain|british|united kingdom)\b", re.I)),
    ("us", re.compile(r"\bUS\b|\bU\.S\.(?!\w)|\b(?:[Aa]merica|[Aa]merican|[Uu]nited [Ss]tates)\b")),
    ("eurozone", re.compile(r"\b(?:eurozone|euro area)\b", re.I)),
    ("japan", re.compile(r"\bjapan(?:ese)?\b", re.I)),
)
# Rate decisions belong to the central bank; inflation belongs to the economy.
# Mapping both directions lets "UK cuts rates" match "BoE cuts rates" and keeps
# "BoE holds as UK inflation falls" under UK inflation.
CENTRAL_BANK_FOR = {"uk": "bank-of-england", "us": "federal-reserve",
                    "eurozone": "ecb", "japan": "bank-of-japan"}
ECONOMY_FOR = {bank: economy for economy, bank in CENTRAL_BANK_FOR.items()}

# Company earnings are keyed to a company named in the Pheme company directory,
# never to a country, so unrelated UK firms cannot corroborate one another.
COMPANY_FILE = Path(__file__).resolve().parents[1] / "assets" / "companies.json"
_COMPANY_SUFFIXES = {"inc", "incorporated", "corp", "corporation", "co", "company", "plc", "ltd",
                     "limited", "holdings", "holding", "group", "sa", "ag", "nv", "se", "spa",
                     "asa", "ab", "oyj", "llc", "lp", "adr", "the"}
# Capitalised words that often open earnings headlines without naming a firm.
_NOT_COMPANIES = {"record", "strong", "weak", "bumper", "higher", "lower", "solid", "robust",
                  "surprise", "quarterly", "annual", "first", "second", "third", "fourth", "half",
                  "full", "big", "tech", "bank", "banks", "oil", "retail", "global", "uk", "us",
                  "european", "british", "american", "chinese", "fed", "boe", "ecb", "shares",
                  "stocks", "markets", "q1", "q2", "q3", "q4"}
_CAPITAL_RUN = re.compile(r"(?:[A-Z0-9][\w&.'’-]*)(?:\s+(?:[A-Z0-9][\w&.'’-]*|&|of|and|de|la))*")


def _company_key(name):
    text = str(name or "").casefold().replace("’", "'")
    text = re.sub(r"'s\b", "", text)
    text = re.sub(r"/[a-z]{2,4}/?", " ", text)
    text = re.sub(r"[.,()]", " ", text)
    tokens = text.split()
    while tokens and tokens[0] == "the":
        tokens.pop(0)
    while len(tokens) > 1 and (tokens[-1] in _COMPANY_SUFFIXES or tokens[-2:] == ["&", "co"]):
        tokens = tokens[:-2] if tokens[-2:] == ["&", "co"] else tokens[:-1]
    return " ".join(tokens)


def _load_companies(path=COMPANY_FILE):
    try:
        rows = json.loads(Path(path).read_text(encoding="utf-8")).get("companies", [])
    except (OSError, ValueError, AttributeError):
        return {}
    names = {}
    for row in rows:
        if isinstance(row, list) and len(row) > 1 and isinstance(row[1], str):
            key = _company_key(row[1])
            if len(key) >= 2 and key not in _NOT_COMPANIES:
                names.setdefault(key, row[1])
    return names


COMPANIES = _load_companies()
HEDGES = re.compile(r"\b(?:may|might|could|possibly|potentially|consider(?:s|ing)?|expects?|expected|forecast|predict(?:s|ed)?|plans?|planned|rumou?r(?:s|ed)?|reportedly|likely|unlikely|if|would|should|hopes?|bets?|odds|calls? for|pressure)\b", re.I)
COMPARED_FORECAST = re.compile(r"\b(?:beat\w*|exceed\w*|tops?|topped|topping|miss\w*|above|below|short of)\s+(?:[\w'’-]+\s+){0,2}forecasts?\b", re.I)
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


def _distance(span, match):
    """Characters between an entity mention and the claim (0 if they overlap)."""
    if span[1] <= match.start():
        return match.start() - span[1]
    if span[0] >= match.end():
        return span[0] - match.end()
    return 0


def _macro_entity(text, match, event):
    """The macro entity closest to this claim, normalised for the event type."""
    best = None
    for key, regex in ENTITY_RULES:
        for found in regex.finditer(text):
            distance = _distance(found.span(), match)
            if best is None or distance < best[0]:
                best = (distance, key)
    if best is None:
        return None
    key = best[1]
    if event == "rate_cut":
        return CENTRAL_BANK_FOR.get(key, key)
    return ECONOMY_FOR.get(key, key)


def _company(text, match, companies=None):
    """The directory company named immediately before an earnings claim.

    Only capitalised names ending before the claim (within 60 characters) are
    considered, nearest first. Unknown names give no entity, so the claim is
    skipped rather than grouped under a country.
    """
    companies = COMPANIES if companies is None else companies
    region_start = max(0, match.start() - 60)
    region = text[region_start:match.start()]
    best = None
    for run in _CAPITAL_RUN.finditer(region):
        words = list(re.finditer(r"\S+", run.group(0)))
        for first in range(len(words)):
            for last in range(len(words) - 1, first - 1, -1):
                phrase = run.group(0)[words[first].start():words[last].end()]
                key = _company_key(phrase)
                if key in _NOT_COMPANIES or key not in companies:
                    continue
                end = region_start + run.start() + words[last].end()
                rank = (match.start() - end, -(last - first))
                if best is None or rank < best[0]:
                    best = (rank, key)
    return "company:" + best[1] if best else None


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
    if not text:
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
        # Each claim is tied to its own subject, not the article's first entity.
        entity = _company(text, match) if event == "earnings_beat" else _macro_entity(text, match, event)
        if not entity:
            continue
        # Prevent unsupported article-level speculation from becoming confirmation.
        window = text[max(0, match.start()-75): min(len(text), match.end()+55)]
        # "Beat forecast" reports a comparison with a forecast; it is not a hedge.
        speculative = bool(HEDGES.search(COMPARED_FORECAST.sub(" ", window)))
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
        # Seed with the target's own headline so a copy of it can never count
        # as support, whichever article happens to be newer.
        seen_titles = {premise["fingerprint"]: _publisher_group(premise["publisher"])} if premise["fingerprint"] else {}
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
