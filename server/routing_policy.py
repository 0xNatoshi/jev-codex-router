"""Compact Jev contract: one model/effort choice for the next model call."""
import math

POLICY_VERSION = "joint-v2-per-call-compact"
LUNA, SOL, ASTRA = "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"
TIERS = (LUNA, SOL, ASTRA)
EFFORTS = ["low", "medium", "high", "xhigh", "max"]

# These are compact priors, not benchmark-derived success rates. The short
# option ids are deliberate: this entire contract is paid on every sub-action.
MODEL_PROFILES = {
    "luna": "cost-efficient GPT-5.6; routine work",
    "sol": "strong GPT-5.6; complex work",
    "astra": "most capable; hardest or highest-risk work",
}
DEPTH_PROFILES = {
    "low": "small",
    "medium": "moderate",
    "high": "substantial",
    "xhigh": "extended",
    "max": "largest",
}
MODEL_IDS = {"luna": LUNA, "sol": SOL, "astra": ASTRA}
ROUTE_PAIRS = {f"{name}:{depth}": (model, depth)
               for name, model in MODEL_IDS.items() for depth in EFFORTS}
QUESTIONS = {
    "route": {
        "type": "choice",
        "instructions": {
            "question": "Best model and effort for this next model call?",
            "rules": [
                "Choose the least costly pair that is sufficient for a correct result.",
                "Judge capability and effort separately; extra effort does not make models equal.",
                "Use only the supplied task, step, intent, image and tool evidence.",
                "No default pair or target distribution. Account for likely corrections.",
            ],
            "models": MODEL_PROFILES,
            "effort": DEPTH_PROFILES,
        },
        "criteria": {key: key for key in ROUTE_PAIRS},
    },
}


def route_choice(model, effort):
    """Compact option id for fixtures and callers that already know a pair."""
    for choice, pair in ROUTE_PAIRS.items():
        if pair == (model, effort):
            return choice
    raise ValueError("invalid model/effort pair")


def route(tier, depth, conf=None, step=None):
    """Apply a valid Jev pair verbatim; confidence and step type are observations."""
    if tier not in TIERS or depth not in EFFORTS:
        raise ValueError("invalid model/effort pair")
    return tier, depth, "default", "apply"


def decision_from_answers(answers):
    """Validate the interface without interpreting confidence as success probability."""
    answer = answers.get("route") if isinstance(answers, dict) else None
    if not isinstance(answer, dict):
        raise ValueError("missing joint route decision")
    choice = answer.get("choice")
    if not isinstance(choice, str) or choice not in ROUTE_PAIRS:
        raise ValueError("unknown joint route choice")
    probabilities = answer.get("probabilities")
    if probabilities is not None:
        if not isinstance(probabilities, dict) or set(probabilities) != set(ROUTE_PAIRS):
            raise ValueError("incomplete route distribution")
        values = list(probabilities.values())
        if any(isinstance(p, bool) or not isinstance(p, (int, float))
               or not math.isfinite(p) or not 0 <= p <= 1 for p in values):
            raise ValueError("invalid route probabilities")
        if abs(sum(values) - 1) > 0.02 or probabilities[choice] < max(values) - 1e-6:
            raise ValueError("inconsistent route distribution")
    conf = answer.get("confidence")
    if (isinstance(conf, bool) or not isinstance(conf, (int, float))
            or not math.isfinite(conf) or not 0 <= conf <= 1):
        conf = None
    model, effort = ROUTE_PAIRS[choice]
    return {
        "model": model, "effort": effort, "speed": "default", "gate": "apply",
        "confidence": conf, "probabilities": probabilities,
        "chosen_probability": probabilities.get(choice) if probabilities else None,
        "policy_version": POLICY_VERSION,
    }
