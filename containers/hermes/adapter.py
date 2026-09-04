"""Minimal HTTP adapter: Worker -> Hermes Agent one-shot completion.

Contract:
  POST /v1/complete {"profile", "system", "user", "idempotency_key"}
    -> {"text"} (model final answer, expected to be raw JSON arguments)
  GET /health -> {"ok": true}

Secrets: MODEL_API_KEY lives only in this container's environment (injected
at deploy time, never committed). The Worker authenticates with
HERMES_SHARED_SECRET. Request bodies are never logged; only the profile,
byte sizes, and idempotency key are logged.
"""

import hmac
import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
SHARED_SECRET = os.environ.get("HERMES_SHARED_SECRET", "")
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
MAX_BODY_BYTES = 512 * 1024
SUBPROCESS_TIMEOUT_SECONDS = 300

# profile and functionName are interpolated into the subprocess argv, so both
# are restricted to a strict token alphabet below.
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

INSTRUCTION_TEMPLATE = (
  "Call the {function} contract exactly once. Respond with ONLY the raw "
  "JSON value for its arguments. No prose, no code fences."
)


def _unauthorized(handler: BaseHTTPRequestHandler) -> None:
  body = b'{"error":"unauthorized"}'
  handler.send_response(401)
  handler.send_header("content-type", "application/json")
  handler.send_header("content-length", str(len(body)))
  handler.end_headers()
  handler.wfile.write(body)


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
  body = json.dumps(payload).encode("utf-8")
  handler.send_response(status)
  handler.send_header("content-type", "application/json")
  handler.send_header("content-length", str(len(body)))
  handler.end_headers()
  handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
  server_version = "HermesAdapter/1"

  def log_message(self, *args: object) -> None:
    pass

  def do_GET(self) -> None:
    if self.path == "/health":
      _json(self, 200, {"ok": True})
    else:
      _json(self, 404, {"error": "not found"})

  def do_POST(self) -> None:
    if self.path != "/v1/complete":
      _json(self, 404, {"error": "not found"})
      return
    presented = self.headers.get("authorization", "")
    expected = f"Bearer {SHARED_SECRET}"
    if not SHARED_SECRET or not hmac.compare_digest(presented, expected):
      _unauthorized(self)
      return
    try:
      length = int(self.headers.get("content-length", "0"))
    except ValueError:
      _json(self, 400, {"error": "bad content length"})
      return
    if length <= 0 or length > MAX_BODY_BYTES:
      _json(self, 413, {"error": "body too large"})
      return
    try:
      payload = json.loads(self.rfile.read(length).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
      _json(self, 400, {"error": "invalid json"})
      return
    profile = payload.get("profile")
    system = payload.get("system")
    user = payload.get("user")
    idempotency_key = payload.get("idempotency_key")
    function = payload.get("functionName")
    if not all(
      isinstance(value, str) and value
      for value in (profile, system, user, idempotency_key, function)
    ):
      _json(self, 400, {"error": "profile, system, user, idempotency_key, functionName required"})
      return
    if TOKEN_PATTERN.match(profile) is None or TOKEN_PATTERN.match(function) is None:
      _json(self, 400, {"error": "profile and functionName must be plain tokens"})
      return
    print(
      json.dumps(
        {
          "event": "complete",
          "profile": profile,
          "system_bytes": len(system.encode("utf-8")),
          "user_bytes": len(user.encode("utf-8")),
          "idempotency_key": idempotency_key,
        }
      ),
      flush=True,
    )
    prompt = f"{system}\n\n{user}\n\n{INSTRUCTION_TEMPLATE.format(function=function)}"
    try:
      completed = subprocess.run(
        [HERMES_BIN, "chat", "--oneshot", "--profile", profile, "--quiet", "-q", prompt],
        capture_output=True,
        text=True,
        timeout=SUBPROCESS_TIMEOUT_SECONDS,
        check=False,
      )
    except subprocess.TimeoutExpired:
      _json(self, 502, {"error": "model timed out"})
      return
    except OSError:
      _json(self, 502, {"error": "model backend unavailable"})
      return
    if completed.returncode != 0:
      _json(self, 502, {"error": "model failed"})
      return
    text = completed.stdout.strip()
    if not text:
      _json(self, 502, {"error": "empty model answer"})
      return
    _json(self, 200, {"text": text})


if __name__ == "__main__":
  ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
