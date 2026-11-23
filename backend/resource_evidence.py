"""Pheme-8 Stage 4: conservative article-to-resource evidence candidate index.

Publisher RSS titles/descriptions only. This is *not* claim-level semantic
verification or proof of any economic edge. A repeated keyword is not a
validated proposition; octal corroboration is only assigned to matching
directional resource-change candidates from different named publishers.
"""
import datetime
import re
from collections import defaultdict

# Exact resource nouns keep unrelated uses of "power", "chip" etc from
# silently entering a market graph. Unknown/custom resources remain unlinked.
LEXICON = {
    "gas": r"\b(?:natural gas|lng|gas prices?|gas futures)\b",
    "copper": r"\bcopper\b",
    "silicon": r"\b(?:silicon|silicon wafers?)\b",
    "labour": r"\b(?:wages?|labou?r costs?|skilled workers?|electricians?|engineers? salaries)\b",
    "powerplant": r"\b(?:power generation|gas-fired power|power stations?|power plants?)\b",
    "semifab": r"\b(?:semiconductor fabrication|chip fabrication|chip foundr(?:y|ies)|wafer fabs?)\b",
    "power": r"\b(?:electricity prices?|power prices?|electricity costs?|grid tariffs?)\b",
    "chips": r"\b(?:gpus?|graphics processors?|ai accelerators?|hbm memory|semiconductor prices?|chip prices?)\b",
    "equipment": r"\b(?:electrical equipment|transformers?|switchgear)\b",
    "build": r"\b(?:data.centre construction|data.center construction|data.centre build|data.center build)\b",
    "dc": r"\b(?:ai data centres?|ai data centers?|data.centre operators?|data.center operators?)\b",
    "margin": r"\b(?:operating margins?|operating profits?)\b",
}
UP = re.compile(r"\b(?:rises?|rose|rising|surges?|surged|jumps?|jumped|increas(?:es?|ed|ing)|hikes?|hiked|higher|expensive|soars?|soared)\b",re.I)
DOWN = re.compile(r"\b(?:falls?|fell|falling|drops?|dropped|declin(?:es?|ed|ing)|decreas(?:es?|ed|ing)|cuts?|cutting|lower|cheaper|slumps?|slumped)\b",re.I)
QUALIFIED = re.compile(r"\b(?:may|might|could|potentially|possibly|expects?|expected|forecast|predicts?|rumou?rs?|reportedly|plans?|considering|if|would|perhaps|likely)\b",re.I)
NEGATED = re.compile(r"\b(?:not|never|no|den(?:y|ies|ied)|reject(?:s|ed)?|rules? out|won't|will not)\b",re.I)
MAX_AGE_HOURS = 96


def published_date(value):
    if not value:
        return None
    try:
        stamp = datetime.datetime.fromisoformat(str(value).replace("Z","+00:00"))
        if stamp.tzinfo is None:
            return None
        return stamp.astimezone(datetime.timezone.utc)
    except (TypeError,ValueError,OverflowError):
        return None


def extract(item, url, now=None):
    """Return possible *directional news claims* tied to seed resources."""
    now=now or datetime.datetime.now(datetime.timezone.utc)
    if item.get("status") == "edition-reference" or not item.get("publisher"):
        return []
    stamp=published_date(item.get("published"))
    if stamp is None or (now-stamp).total_seconds() > MAX_AGE_HOURS*3600 or stamp>now+datetime.timedelta(hours=1):
        return []
    # Treat headline as the unit of assertion. The RSS summary may describe
    # unrelated events; combining them would fabricate grammatical scope.
    title=str(item.get("title") or "")[:320]
    out=[]
    for key,pattern in LEXICON.items():
        m=re.search(pattern,title,re.I)
        if not m:
            continue
        # Restrict direction to a short local phrase, not the whole story.
        nearby=title[max(0,m.start()-42):min(len(title),m.end()+42)]
        up=bool(UP.search(nearby))
        down=bool(DOWN.search(nearby))
        hedged=bool(QUALIFIED.search(title))
        denied=bool(NEGATED.search(nearby))
        direction="up" if up and not down else ("down" if down and not up else "unspecified")
        if hedged or denied:
            direction="qualified"
        out.append({"node":key,"direction":direction,"publisher":str(item["publisher"])[:120],
                    "headline":title,"url":url,"published":stamp.isoformat(),
                    "excerpt":nearby,"eligible":direction in ("up","down")})
    return out


def correlate(items, now=None):
    """Assemble candidate claims per resource, never prove an edge."""
    now=now or datetime.datetime.now(datetime.timezone.utc)
    bynode=defaultdict(list)
    for url,item in items.items():
        if not isinstance(item,dict):
            continue
        for row in extract(item,url,now):
            bynode[row["node"]].append(row)
    output={}
    for node in LEXICON:
        records=sorted(bynode.get(node,[]),key=lambda x:x["published"],reverse=True)
        directions=defaultdict(dict)
        for entry in records:
            if not entry["eligible"]:
                continue
            publisher=entry["publisher"].casefold().strip()
            # Identical headlines across outlets may indicate syndication.
            fingerprint=re.sub(r"\W+","",entry["headline"].lower())
            if any(re.sub(r"\W+","",v["headline"].lower())==fingerprint for v in directions[entry["direction"]].values()):
                continue
            directions[entry["direction"]].setdefault(publisher,entry)
        counts={d:len(sources) for d,sources in directions.items()}
        opposed=bool(counts.get("up") and counts.get("down"))
        dominant=sorted(["up","down"],key=lambda x:counts.get(x,0),reverse=True)[0]
        support=counts.get(dominant,0)
        # More than one publisher is necessary to call it corroborated.
        score=None if opposed or support<2 else (4 if support==2 else 5 if support==3 else 6)
        status=("contested" if opposed else "cross-source-candidate" if score is not None
                else "unverified" if records else "no-evidence")
        output[node]={
            "node":node,"status":status,"direction":None if opposed or score is None else dominant,
            "octalCorroboration":score,"publisherCount":support,
            "opposingPublisherCount":counts.get("down" if dominant=="up" else "up",0),
            "articles":records[:16],
            "evidenceType":"RSS headline keyword-and-direction candidate",
            "notice":"Corroboration is coverage, not factual truth; node associations do not verify graph edges or predicted price effects.",
        }
    return output


def resource_evidence(items,node=None,now=None):
    if node is not None and node not in LEXICON:
        return {"error":"No established extractor for this resource","node":node,
                "status":"unsupported","octalCorroboration":None,"articles":[]}
    indexed=correlate(items,now)
    return {"generatedAt":(now or datetime.datetime.now(datetime.timezone.utc)).isoformat(),
            "resources":{node:indexed[node]} if node is not None else indexed,
            "model":"rss-resource-candidates-v1","execution":"disabled"}
