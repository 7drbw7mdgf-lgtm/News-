"""PHEME-8: auditable eight-valued inference over corroborated propositions.

The output is *proposition corroboration strength*, not probability of truth,
financial sentiment, trade direction or an instruction to a broker.
Unknown is a distinct value (None), never 0. Conflicted inputs veto inference.
"""
from collections import Counter

MIN_OCTAL = 0
MAX_OCTAL = 7
OPERATORS = ("AND8", "OR8", "NOT8", "IMPLIES8")


def checked(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_OCTAL <= value <= MAX_OCTAL:
        raise ValueError("Octal evidence must be an integer from 0 to 7 or null (unknown)")
    return value


def negate(value):
    value = checked(value)
    return None if value is None else 7 - value


def conjunction(left, right):
    left, right = checked(left), checked(right)
    # Strict unknown propagation: not a closed-world assumption.
    return None if left is None or right is None else min(left, right)


def disjunction(left, right):
    left, right = checked(left), checked(right)
    return None if left is None or right is None else max(left, right)


def implies(left, right):
    left, right = checked(left), checked(right)
    return None if left is None or right is None else min(7, 7 - left + right)


def evaluate(expression, variables, depth=0):
    """Evaluate a bounded, declarative octal AST. No eval, recursion bombs or I/O."""
    if depth > 10:
        raise ValueError("Expression is too deep")
    if not isinstance(expression, dict):
        raise ValueError("Expression node must be an object")
    operation = expression.get("op")
    if operation == "VAR":
        symbol = expression.get("name")
        if not isinstance(symbol, str) or symbol not in variables:
            raise ValueError("Unrecognised proposition symbol")
        value = checked(variables[symbol])
        return value, {"op": "VAR", "name": symbol, "value": value}
    if operation not in OPERATORS:
        raise ValueError("Unsupported octal operator")
    children = expression.get("args")
    count = 1 if operation == "NOT8" else 2
    if not isinstance(children, list) or len(children) != count:
        raise ValueError("Incorrect operator arity")
    evaluated = [evaluate(x, variables, depth + 1) for x in children]
    vals = [x[0] for x in evaluated]
    result = {
        "AND8": lambda: conjunction(*vals),
        "OR8": lambda: disjunction(*vals),
        "NOT8": lambda: negate(*vals),
        "IMPLIES8": lambda: implies(*vals),
    }[operation]()
    return result, {"op": operation, "inputs": [x[1] for x in evaluated], "value": result}


def infer_from_corroboration(result):
    """Lift an article's cross-publisher assessments into a safe logical report.

    The default rule is AND8 of all extracted propositions. It describes
    corroboration completeness, not causal proof or a trading signal.
    """
    propositions = result.get("propositions")
    if not isinstance(propositions, list):
        raise ValueError("Expected propositions array")
    if not propositions:
        return {
            "status": "unknown", "octalResult": None, "execution": "disabled",
            "reason": "No extractable economic propositions",
            "inputs": [], "trace": None,
        }
    if len(propositions) > 8:
        return {"status": "blocked", "octalResult": None, "execution": "disabled",
                "reason": "Too many premises for the bounded prototype", "inputs": [], "trace": None}
    inputs = []
    for index, claim in enumerate(propositions):
        if not isinstance(claim, dict):
            raise ValueError("Invalid proposition")
        grade = checked(claim.get("octalCorroboration"))
        state = str(claim.get("status") or "")
        if state not in ("cross-source-support", "limited-cross-source-support"):
            grade = None  # Contested/qualified/unverified must not be coerced.
        inputs.append({
            "symbol": "P" + str(index + 1),
            "proposition": str(claim.get("key") or ""),
            "state": state,
            "octalValue": grade,
            "supportingPublishers": int(claim.get("supportingPublishers") or 0),
            "contradictingPublishers": int(claim.get("contradictingPublishers") or 0),
            "supportingEvidence": [
                {"publisher": p.get("publisher"), "url": p.get("url"), "published": p.get("published")}
                for p in claim.get("supporting", [])[:12] if isinstance(p, dict)
            ],
            "contradictingEvidence": [
                {"publisher": p.get("publisher"), "url": p.get("url"), "published": p.get("published")}
                for p in claim.get("contradicting", [])[:12] if isinstance(p, dict)
            ],
        })
    states = Counter(x["state"] for x in inputs)
    values = {x["symbol"]: x["octalValue"] for x in inputs}
    expression = {"op": "VAR", "name": inputs[0]["symbol"]}
    for inp in inputs[1:]:
        expression = {"op": "AND8", "args": [expression, {"op": "VAR", "name": inp["symbol"]}]}
    value, trace = evaluate(expression, values)
    if states["contested"] > 0:
        status, reason, value = "contested", "Contradictory reporting requires human review", None
    elif value is None:
        status, reason = "unknown", "One or more propositions lack eligible independent corroboration"
    else:
        status, reason = "supported", "All included propositions have independent publisher corroboration"
    return {
        "status": status,
        "octalResult": value,
        "execution": "disabled",
        "reason": reason,
        "interpretation": "Corroboration strength only; not factual certainty, market direction or trade probability",
        "operator": "AND8",
        "expression": expression,
        "inputs": inputs,
        "trace": trace,
        "caveats": [
            "Source overlap, wire syndication and shared primary evidence are not completely identifiable from RSS",
            "Keyword-based proposition extraction cannot establish full semantic equivalence",
            "An octal evidence grade is not a calibrated probability",
            "No broker orders or trade recommendations are generated",
        ],
    }
