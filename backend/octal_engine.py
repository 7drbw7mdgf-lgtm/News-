"""PHEME-8: octal evidence multiplication followed by explicit filtering.

This is a *corroboration aggregation prototype*. Multiplying octal intensities
does not make them independent probabilities and does not establish truth,
market direction, execution suitability, or predicted returns.

Values 0..7 are integers; None is an explicit unknown. All calculations are
integer-exact until the final quantization. No broker execution.
"""

MIN_OCTAL = 0
MAX_OCTAL = 7
DEFAULT_INPUT_FLOOR = 4
DEFAULT_OUTPUT_FLOOR = 4
MAX_INPUTS = 8


def checked(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 7:
        raise ValueError("Octal evidence must be an integer 0..7 or None (unknown)")
    return value


def threshold(value, name="threshold"):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 7:
        raise ValueError(name + " must be an integer from 0 to 7")
    return value


def multiply(a, b):
    """Quantized two-input multiplication (a*b)/7, nearest integer, half-up."""
    a, b = checked(a), checked(b)
    return None if a is None or b is None else (2 * a * b + 7) // 14


def multiply_many(values):
    """Multiply normalized intensities, rounding *once*, not after each input.

    For n scores: round_half_up(7 * Π(value_i / 7)).
    Per-step rounding would make the result depend on arbitrary grouping.
    """
    values = list(values)
    if not values or len(values) > MAX_INPUTS:
        raise ValueError("Expected 1..8 evidence inputs")
    for value in values:
        checked(value)
    if any(value is None for value in values):
        return None
    numerator = 1
    for value in values:
        numerator *= value
    denominator = 7 ** (len(values) - 1)
    return (2 * numerator + denominator) // (2 * denominator)


def evaluate_product(values):
    """Return an audit trail for the aggregate, preserving exact fractions."""
    values = list(values)
    result = multiply_many(values)
    if result is None:
        return {"operator": "MULTIPLY8", "values": values, "exact": None,
                "value": None, "quantization": "round-half-up-once"}
    numerator = 1
    for value in values:
        numerator *= value
    denominator = 7 ** (len(values) - 1)
    return {"operator": "MULTIPLY8", "values": values,
            "exact": {"numerator": numerator, "denominator": denominator},
            "value": result, "quantization": "round-half-up-once"}


def infer_from_corroboration(result, input_floor=DEFAULT_INPUT_FLOOR,
                             output_floor=DEFAULT_OUTPUT_FLOOR):
    """Filter unreliable premises *before* multiplication, filter aggregate after.

    The filter never silently removes a weak premise to inflate the result:
    it blocks the compound inference with a full trace instead.
    """
    input_floor = threshold(input_floor, "input_floor")
    output_floor = threshold(output_floor, "output_floor")
    propositions = result.get("propositions")
    if not isinstance(propositions, list):
        raise ValueError("Expected propositions array")
    if len(propositions) > MAX_INPUTS:
        return {"status": "blocked", "octalResult": None, "execution": "disabled",
                "reason": "More than eight propositions", "inputs": [], "trace": None}
    if not propositions:
        return {"status": "unknown", "octalResult": None, "execution": "disabled",
                "reason": "No extractable economic propositions", "inputs": [], "trace": None}

    inputs = []
    for index, claim in enumerate(propositions):
        if not isinstance(claim, dict):
            raise ValueError("Invalid proposition")
        score = checked(claim.get("octalCorroboration"))
        state = str(claim.get("status") or "")
        valid_state = state in ("cross-source-support", "limited-cross-source-support")
        if not valid_state:
            score = None
        supporting = claim.get("supporting", [])
        contradicting = claim.get("contradicting", [])
        if not isinstance(supporting, list) or not isinstance(contradicting, list):
            raise ValueError("Evidence records must be lists")
        inputs.append({
            "symbol": "P" + str(index + 1), "proposition": str(claim.get("key") or ""),
            "state": state, "octalValue": score,
            "supportingPublishers": int(claim.get("supportingPublishers") or 0),
            "contradictingPublishers": int(claim.get("contradictingPublishers") or 0),
            "supportingEvidence": [
                {"publisher": p.get("publisher"), "url": p.get("url"), "published": p.get("published")}
                for p in supporting[:12] if isinstance(p, dict)
            ],
            "contradictingEvidence": [
                {"publisher": p.get("publisher"), "url": p.get("url"), "published": p.get("published")}
                for p in contradicting[:12] if isinstance(p, dict)
            ],
        })

    trace = {"pipeline": ["INPUT_FILTER", "MULTIPLY8", "OUTPUT_FILTER"],
             "inputFloor": input_floor, "outputFloor": output_floor, "filters": [],
             "multiplication": None}
    for entry in inputs:
        value = entry["octalValue"]
        if entry["state"] == "contested" or entry["contradictingPublishers"] > 0:
            passed, reason = False, "contradicted"
        elif value is None:
            passed, reason = False, "unknown-or-unverified"
        elif value < input_floor:
            passed, reason = False, "below-input-floor"
        else:
            passed, reason = True, "passed"
        trace["filters"].append({"symbol": entry["symbol"], "value": value,
                                 "pass": passed, "reason": reason})

    problems = [f for f in trace["filters"] if not f["pass"]]
    if problems:
        state = "contested" if any(f["reason"] == "contradicted" for f in problems) else (
            "unknown" if any(f["reason"] == "unknown-or-unverified" for f in problems) else "filtered")
        return {
            "status": state, "octalResult": None, "rawOctalResult": None,
            "execution": "disabled", "operator": "MULTIPLY8",
            "reason": "Input filtering blocked a compound inference",
            "inputs": inputs, "trace": trace,
            "interpretation": "Filtered corroboration evidence, not trading strength",
        }

    trace["multiplication"] = evaluate_product([entry["octalValue"] for entry in inputs])
    aggregate = trace["multiplication"]["value"]
    approved = aggregate >= output_floor
    trace["outputFilter"] = {"value": aggregate, "floor": output_floor,
                             "pass": approved, "reason": "passed" if approved else "below-output-floor"}
    return {
        "status": "supported" if approved else "filtered",
        "octalResult": aggregate if approved else None,
        "rawOctalResult": aggregate, "operator": "MULTIPLY8",
        "execution": "disabled",
        "reason": "All input and output evidence filters passed" if approved else "Compound evidence fell below output threshold",
        "inputs": inputs, "trace": trace,
        "interpretation": "Corroboration strength only; not probability, asset direction or a trade signal",
        "caveats": [
            "Multiplication assumes an intentionally chosen aggregation rule, not probabilistic independence",
            "RSS proposition extraction and publisher-independence detection remain provisional",
            "No broker orders or trade recommendations are generated",
        ],
    }
