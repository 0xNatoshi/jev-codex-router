"""Reproducible classifier calibration; --live spends only Jev input credits."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import jev_server as jev


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("routing_cases.json"))
    args = parser.parse_args()
    with args.cases.open() as source:
        cases = json.load(source)
    key = jev.load_key() if args.live else None
    if args.live and not key:
        raise SystemExit("TypeSafe key not configured")
    passed = 0
    for case in cases:
        state = jev.decision_dossier({"input": case["input"]})
        row = {"id": case["id"], "dossier_chars": len(json.dumps(state)),
               "policy_version": jev.POLICY_VERSION}
        if args.live:
            start = time.monotonic()
            try:
                result = jev.call_jev_routed(key, state, timeout=15)
                decision = jev.decision_from_answers(result.get("answers"))
                ok = (decision["model"] in case["models"] and
                      decision["astra_policy"] == case.get("policy", decision["astra_policy"]))
                row.update(model=decision["model"], effort=decision["effort"],
                           astra_policy=decision["astra_policy"], passed=ok,
                           input_tokens=(result.get("usage") or {}).get("input_tokens"),
                           ms=round(1000 * (time.monotonic() - start)))
                passed += int(ok)
            except Exception as error:
                row.update(passed=False, error_type=type(error).__name__)
        print(json.dumps(row))
    if args.live:
        print(json.dumps({"passed": passed, "total": len(cases),
                          "note": "classification sample, not executor quality or savings"}))
    return int(args.live and passed != len(cases))


if __name__ == "__main__":
    raise SystemExit(main())
