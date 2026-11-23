"""Typed resource dependency network: schema, validation and demo chain.

Stage 3 formalizes resource categories and admissible causal/production edges.
No assumptions here are measured; example edges are modelling hypotheses.
"""
import re

NODE_TYPES = ("primary", "secondary", "process", "company", "financial")
RELATIONS = {
    "produces": (("primary", "process"), ("process", "secondary"), ("process", "process")),
    "requires": (("primary", "process"), ("secondary", "process"), ("primary", "secondary")),
    "supplies": (("primary", "secondary"), ("secondary", "process"), ("secondary", "company")),
    "affects_cost": (("primary", "secondary"), ("secondary", "company"), ("process", "company"),
                     ("primary", "company"), ("company", "financial")),
}
UNITS = ("unit", "kg", "tonne", "MWh", "kWh", "litre", "m3", "hour", "GPU-hour", "GBP", "USD", "percent")
ID = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")

EXAMPLE = {
    "name": "AI infrastructure — illustrative dependencies",
    "nodes": [
        {"id":"gas","label":"Natural gas","type":"primary"},
        {"id":"copper","label":"Copper","type":"primary"},
        {"id":"silicon","label":"Silicon","type":"primary"},
        {"id":"labour","label":"Skilled labour","type":"primary"},
        {"id":"powerplant","label":"Power generation","type":"process"},
        {"id":"semifab","label":"Semiconductor fabrication","type":"process"},
        {"id":"power","label":"Electricity","type":"secondary"},
        {"id":"chips","label":"GPUs / accelerators","type":"secondary"},
        {"id":"equipment","label":"Electrical equipment","type":"secondary"},
        {"id":"build","label":"Data-centre build","type":"process"},
        {"id":"dc","label":"AI data centre","type":"company"},
        {"id":"margin","label":"Operating margin","type":"financial"},
    ],
    "edges": [
        {"source":"gas","target":"powerplant","relation":"requires"},
        {"source":"powerplant","target":"power","relation":"produces"},
        {"source":"silicon","target":"semifab","relation":"requires"},
        {"source":"power","target":"semifab","relation":"requires"},
        {"source":"semifab","target":"chips","relation":"produces"},
        {"source":"copper","target":"equipment","relation":"supplies"},
        {"source":"equipment","target":"build","relation":"requires"},
        {"source":"labour","target":"build","relation":"requires"},
        {"source":"power","target":"dc","relation":"affects_cost"},
        {"source":"chips","target":"dc","relation":"supplies"},
        {"source":"build","target":"dc","relation":"affects_cost"},
        {"source":"dc","target":"margin","relation":"affects_cost"},
    ],
}


def validate(graph):
    if not isinstance(graph, dict):
        raise ValueError("Graph must be an object")
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list) or len(nodes) > 120 or len(edges) > 360:
        raise ValueError("Invalid graph size")
    known = {}
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not ID.fullmatch(node["id"]):
            raise ValueError("Invalid node ID")
        if node["id"] in known:
            raise ValueError("Duplicate node ID")
        if node.get("type") not in NODE_TYPES:
            raise ValueError("Invalid node type")
        if not isinstance(node.get("label"), str) or not 1 <= len(node["label"]) <= 90:
            raise ValueError("Invalid node label")
        known[node["id"]] = node
    seen = set()
    adj = {key: [] for key in known}
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("relation") not in RELATIONS:
            raise ValueError("Invalid relationship type")
        a, b = edge.get("source"), edge.get("target")
        if a not in known or b not in known or a == b:
            raise ValueError("Missing or self-referential edge")
        if (known[a]["type"], known[b]["type"]) not in RELATIONS[edge["relation"]]:
            raise ValueError("Invalid resource relationship direction or node types")
        key = (a,b)
        if key in seen:
            raise ValueError("Duplicate directed edge")
        seen.add(key)
        adj[a].append(b)
        if "quantity" in edge:
            quantity = edge["quantity"]
            if isinstance(quantity, bool) or not isinstance(quantity,(float,int)) or not 0 < quantity <= 1e12 or edge.get("unit") not in UNITS:
                raise ValueError("Edge quantity requires a positive number and explicit unit")
    # A dependency graph must be a DAG. Cycle detection via topological sort.
    marks = {}
    def visit(node):
        if marks.get(node) == 1:
            raise ValueError("Cycle detected")
        if marks.get(node) == 2:
            return
        marks[node] = 1
        for neighbor in adj[node]:
            visit(neighbor)
        marks[node] = 2
    for node in known:
        visit(node)
    return {"valid":True,"nodeCount":len(nodes),"edgeCount":len(edges),
            "nodeTypes":list(NODE_TYPES),"relationTypes":list(RELATIONS),
            "notes":"Topology only; edges do not prove causal magnitude or provide trade signals"}
