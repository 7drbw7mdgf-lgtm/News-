"""Stage 5: transparent scenario propagation across a typed resource DAG.

The coefficients describe hypothetical elasticity of a target *cost metric*
to a source metric: 1% change upstream => coefficient% change downstream.
No octal evidence value is ever used as a financial elasticity.
No shareholder return or company valuation is inferred.
"""
import math


def simulate(graph, shock, percent, validator):
    validator(graph)
    if isinstance(percent, bool) or not isinstance(percent, (float, int)) or not math.isfinite(percent) or not -100 <= percent <= 100:
        raise ValueError("Scenario shock must be a finite percentage from -100 to 100")
    known = {node["id"]: node for node in graph["nodes"]}
    if shock not in known or known[shock]["type"] not in ("primary", "secondary"):
        raise ValueError("Shock must target an existing primary or secondary resource")

    outgoing = {key: [] for key in known}
    for edge in graph["edges"]:
        outgoing[edge["source"]].append(edge)

    # Enumerate all paths independently. If the same upstream shock reaches
    # a downstream metric by two routes, double-counting cannot be excluded.
    paths = {shock: [{"path": [shock], "changePercent": float(percent), "assumptions": []}]}
    queue = [shock]
    while queue:
        current = queue.pop(0)
        for edge in outgoing[current]:
            target = edge["target"]
            coefficient = edge.get("passThrough")
            if coefficient is None:
                continue
            if isinstance(coefficient, bool) or not isinstance(coefficient, (float, int)) or not math.isfinite(coefficient) or not 0 <= coefficient <= 1:
                raise ValueError("Invalid pass-through coefficient")
            children = []
            for parent in paths[current]:
                if len(parent["path"]) >= 30:
                    raise ValueError("Scenario path exceeds safety bound")
                children.append({
                    "path": parent["path"] + [target],
                    "changePercent": parent["changePercent"] * coefficient,
                    "assumptions": parent["assumptions"] + [{
                        "from": current, "to": target, "passThrough": coefficient,
                        "status": "hypothetical-user-assumption"}],
                })
            if not children:
                continue
            if target not in paths:
                paths[target] = []
                queue.append(target)
            paths[target].extend(children)
            if len(paths[target]) > 120:
                raise ValueError("Too many overlapping scenario paths")
    output = []
    for node in graph["nodes"]:
        entries = paths.get(node["id"], [])
        if not entries:
            status, impact = "unreached", None
        elif len(entries) > 1:
            status, impact = "overlap-review-required", None
        else:
            status, impact = "scenario-only", round(entries[0]["changePercent"], 6)
        output.append({"node": node["id"], "label": node["label"],
                       "status": status, "changePercent": impact,
                       "paths": entries[:12]})
    return {
        "shock": shock, "shockPercent": percent, "results": output,
        "execution": "disabled", "model": "illustrative-elasticity-dag-v1",
        "limitations": [
            "Assumptions are not calibrated against issuer accounts or measured production data",
            "Nodes reached through multiple paths are blocked to avoid double-counting",
            "Missing edge coefficients block propagation; absent evidence is not zero",
            "The model does not predict asset prices, valuation or trades",
        ],
    }


# Four explicit demonstration assumptions, not researched financial facts.
DEMO_ASSUMPTIONS = (
    ("gas", "powerplant", 0.35),
    ("powerplant", "power", 0.8),
    ("power", "dc", 0.2),
    ("dc", "margin", 0.4),
)


def demo_graph(source):
    import copy
    copy_graph = copy.deepcopy(source)
    for a, b, coefficient in DEMO_ASSUMPTIONS:
        for edge in copy_graph["edges"]:
            if edge["source"] == a and edge["target"] == b:
                edge["passThrough"] = coefficient
                break
    return copy_graph
