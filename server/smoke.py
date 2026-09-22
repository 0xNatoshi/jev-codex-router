"""Small end-to-end check through the parent router; never print credentials."""
import http.client
import json
from pathlib import Path

from healthcheck import healthy
from routing_policy import POLICY_VERSION


def main():
    if not healthy():
        raise RuntimeError("local health check failed")
    health = http.client.HTTPConnection("127.0.0.1", 4319, timeout=5)
    try:
        health.request("GET", "/health")
        if json.loads(health.getresponse().read()).get("policy_version") != POLICY_VERSION:
            raise RuntimeError("running policy differs from checkout; reload required")
    finally:
        health.close()
    secret = (Path.home() / ".codex/codex-router/caller-secret").read_text().strip()
    connection = http.client.HTTPConnection("127.0.0.1", 4202, timeout=120)
    result = {"policy": POLICY_VERSION, "model": None, "status": None}
    try:
        body = {"model": "jev/auto", "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Reply only OK."}]}
        ], "stream": True}
        connection.request("POST", f"/_codex-router/{secret}/v1/responses",
                           json.dumps(body), {"Content-Type": "application/json"})
        response = connection.getresponse()
        result["http"] = response.status
        if response.status != 200:
            raise RuntimeError(f"parent router returned HTTP {response.status}")
        for line in response:
            if not line.startswith(b"data: "):
                continue
            try:
                event = json.loads(line[6:])
            except ValueError:
                continue
            if event.get("type") == "response.created":
                result["model"] = (event.get("response") or {}).get("model")
            if event.get("type") == "response.completed":
                result["status"] = (event.get("response") or {}).get("status")
        if result["status"] != "completed":
            raise RuntimeError("no successful terminal response")
        print(json.dumps(result))
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Transport exceptions can carry request URLs: expose only their class.
        print(json.dumps({"ok": False, "error_type": type(error).__name__}))
        raise SystemExit(1)
