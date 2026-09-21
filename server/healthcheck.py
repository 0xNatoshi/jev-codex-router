"""Read-only liveness check used by launch scripts; no credential is required."""
import json
import urllib.request


def healthy(url="http://127.0.0.1:4319/health"):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.load(response)
            return (response.status == 200 and isinstance(data, dict)
                    and data.get("ok") is True and data.get("service") == "jev-router")
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    raise SystemExit(0 if healthy() else 1)
