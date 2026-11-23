"""PHEME-8 primary-cost taxonomy and branch-level, evidence-aware aggregation.

Cost classes are reusable across sectors. Industry relevance is a *candidate*
classification, not a verified exposure weight or model of equity returns.
The model never silently turns a missing score into zero and never issues trades.
"""
from decimal import Decimal, ROUND_HALF_UP

COSTS = {
    "energy": ("Power, fuel and electricity", "energy", "electricity prices, gas, oil, diesel, power contracts"),
    "materials": ("Raw materials and commodities", "materials", "steel, copper, aluminium, lithium, concrete, chemicals"),
    "compute": ("Semiconductors and computing hardware", "hardware", "GPU, HBM, memory, processors, server equipment"),
    "equipment": ("Industrial equipment and machinery", "capital", "machinery, transformers, cooling, turbines, generators"),
    "labour": ("Direct labour and specialist skills", "labour", "wages, engineers, electricians, technicians, unions"),
    "construction": ("Construction and expansion", "capital", "project build, contractors, data centres, capacity expansion"),
    "logistics": ("Shipping and distribution", "transport", "freight, ports, maritime rates, road haulage"),
    "tariffs": ("Tariffs, duties and trade barriers", "policy", "import tariffs, duties, sanctions, export controls"),
    "property": ("Land, rent and real estate", "property", "land, leases, property taxes, commercial rents"),
    "financing": ("Debt and cost of capital", "finance", "interest expense, borrowing costs, credit spreads"),
    "compliance": ("Compliance and regulation", "policy", "licensing, audits, safety, data regulation"),
    "cloud": ("Cloud, network and digital operations", "technology", "cloud hosting, bandwidth, networking, software"),
    "maintenance": ("Maintenance and replacement", "maintenance", "repairs, replacement cycle, servicing"),
    "taxes": ("Taxes and compulsory contributions", "tax", "corporate tax, payroll tax, business rates"),
    "supply_chain": ("Supplier scarcity and disruption", "supply", "shortages, bottlenecks, lead times, supplier concentration"),
    "water": ("Water and cooling resources", "utilities", "cooling water, water use and treatment"),
    "insurance": ("Insurance and business continuity", "risk", "premium, liability, disaster coverage"),
    "sales": ("Sales and customer acquisition", "commercial", "marketing, distribution channels, sales commissions"),
}
# Relevant candidates are not costs verified for any named issuer.
PROFILES = {
    "ai_infrastructure": ("energy","compute","equipment","labour","construction","logistics",
                          "tariffs","property","financing","compliance","cloud","maintenance",
                          "taxes","supply_chain","water","insurance"),
    "software_ai": ("compute","cloud","labour","financing","compliance","taxes",
                    "sales","energy","supply_chain"),
    "semiconductors": ("materials","energy","equipment","labour","logistics","tariffs",
                       "financing","compliance","maintenance","taxes","supply_chain","water"),
    "manufacturing": ("energy","materials","equipment","labour","construction","logistics",
                      "tariffs","property","financing","compliance","maintenance","taxes","supply_chain"),
    "retail": ("energy","materials","labour","logistics","tariffs","property","financing",
               "compliance","taxes","insurance","sales","supply_chain"),
    "airlines": ("energy","labour","equipment","logistics","property","financing","compliance",
                 "maintenance","taxes","insurance","supply_chain"),
    "utilities": ("energy","materials","equipment","labour","construction","property",
                  "financing","compliance","maintenance","taxes","water","insurance"),
    "mining": ("energy","materials","equipment","labour","construction","logistics",
               "property","financing","compliance","maintenance","taxes","water","insurance"),
    "healthcare": ("energy","materials","equipment","labour","logistics","tariffs","property",
                   "financing","compliance","maintenance","taxes","insurance","supply_chain"),
}
# Costs with a common driver should appear together for review, not be
# blindly multiplied into one huge number.
DEPENDENCIES = (
    ("energy","water","cooling and power are often linked"),
    ("tariffs","compute","import duties may already be embedded in chip prices"),
    ("tariffs","equipment","duties may already be embedded in equipment prices"),
    ("materials","construction","materials may already be embedded in project costs"),
    ("labour","construction","wages may already be embedded in contractor prices"),
    ("logistics","supply_chain","transport disruptions often cause supply shortages"),
    ("financing","construction","capital costs affect project economics"),
    ("compute","cloud","hardware costs can flow through to cloud bills"),
)


def taxonomy(industry=None):
    if industry is not None and industry not in PROFILES:
        raise ValueError("Unknown industry profile")
    active = PROFILES[industry] if industry else tuple(COSTS)
    return {
        "industry": industry,
        "availableIndustries": sorted(PROFILES),
        "categories": [
            {"key": key, "label": COSTS[key][0], "group": COSTS[key][1],
             "exampleDrivers": COSTS[key][2], "relevance": "candidate-only"}
            for key in active
        ],
        "dependencies": [
            {"a": a, "b": b, "reason": reason}
            for a,b,reason in DEPENDENCIES if a in active and b in active
        ],
        "status": "taxonomy-only",
        "notice": "Candidate cost drivers, not issuer-specific measured exposures or a trade signal",
    }


def _score(value):
    if value is None:
        return None
    if type(value) is not int or not 0 <= value <= 7:
        raise ValueError("Evidence strength must be an octal digit 0..7 or null")
    return value


def aggregate(industry, evidence, floor=4):
    """Evaluate each cost separately, then flag overlapping branches.

    evidence: {cost: [{score, corroborated, contested, sourceUrls}]}
    This accepts validated proposition-level evidence, never raw news titles.
    """
    if industry not in PROFILES:
        raise ValueError("Unknown industry profile")
    if type(floor) is not int or floor not in range(8):
        raise ValueError("Invalid input floor")
    if not isinstance(evidence, dict) or len(evidence) > len(COSTS):
        raise ValueError("Invalid evidence map")
    if any(x not in COSTS for x in evidence):
        raise ValueError("Unknown primary cost category")
    rows = []
    for key in PROFILES[industry]:
        values = evidence.get(key)
        if values is None:
            rows.append({"cost":key,"status":"unknown","score":None,"reason":"no-evidence"})
            continue
        if not isinstance(values, list) or not 1 <= len(values) <= 8:
            raise ValueError("Evidence branch needs 1..8 proposition records")
        trace = []
        for entry in values:
            if not isinstance(entry, dict):
                raise ValueError("Malformed proposition evidence")
            score = _score(entry.get("score"))
            url_list = entry.get("sourceUrls", [])
            if not isinstance(url_list,list) or len(url_list)>15 or any(not isinstance(u,str) or not u.startswith("https://") for u in url_list):
                raise ValueError("Invalid source references")
            state = "contested" if entry.get("contested") else (
                "unknown" if not entry.get("corroborated") or score is None else (
                "filtered" if score<floor else "passed"))
            trace.append({"score":score,"state":state,"sourceUrls":url_list})
        fails=[t["state"] for t in trace if t["state"]!="passed"]
        if fails:
            status="contested" if "contested" in fails else ("unknown" if "unknown" in fails else "filtered")
            rows.append({"cost":key,"status":status,"score":None,"inputs":trace})
            continue
        # Exact scaled product, a single quantization, no floating-point drift.
        numerator=1
        for t in trace:
            numerator*=t["score"]
        denominator=7**(len(trace)-1)
        raw=int((Decimal(numerator)/Decimal(denominator)).quantize(Decimal(1),rounding=ROUND_HALF_UP))
        rows.append({"cost":key,"status":"supported","score":raw,
                     "inputs":trace,"trace":{"operator":"MULTIPLY8","numerator":numerator,"denominator":denominator}})
    by_name={r["cost"]:r for r in rows}
    overlap=[{"a":a,"b":b,"reason":why} for a,b,why in DEPENDENCIES
             if a in by_name and b in by_name and
             by_name[a]["status"]=="supported" and by_name[b]["status"]=="supported"]
    return {"industry":industry,"branches":rows,"overlapReview":overlap,
            "combinedScore":None,"execution":"disabled",
            "note":"No global multiplication until overlap, cost exposures, direction and time horizons are validated"}
