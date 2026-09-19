import asyncio
import base64
import json
import os
import pathlib
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from computer import Computer
from cua_agent import ComputerAgent

UPSTREAM_REPO = "trycua/cua"
UPSTREAM_COMMIT = "05f29785b508a4441ec3aa06c556a8e8b26c1d71"
ARTIFACT_ROOT = pathlib.Path(os.environ.get("CUA_ARTIFACT_ROOT", "/artifacts"))
ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)


def compact(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): compact(v) for k, v in list(value.items())[:100]}
    if isinstance(value, (list, tuple)):
        return [compact(v) for v in list(value)[:100]]
    if hasattr(value, "model_dump"):
        return compact(value.model_dump())
    return str(value)


async def run_agent(body):
    target_url = str(body.get("targetUrl") or "").strip()
    objective = str(body.get("objective") or "").strip()
    persona = str(body.get("persona") or "").strip()
    if not target_url or not objective:
        raise ValueError("targetUrl and objective are required")

    run_id = str(body.get("runId") or body.get("auditId") or uuid.uuid4())
    model = str(body.get("model") or os.environ.get("VERIFIAI_CUA_MODEL") or "openai/gpt-5.4-mini")
    provider = str(body.get("provider") or os.environ.get("VERIFIAI_CUA_PROVIDER") or "docker")
    try:
        budget_usd = max(0.01, min(float(body.get("budgetUsd") or 0.25), 1.0))
    except (TypeError, ValueError):
        budget_usd = 0.25
    container_name = f"verifiai-cua-{run_id[:24]}".replace("_", "-")
    trajectory_dir = ARTIFACT_ROOT / run_id
    trajectory_dir.mkdir(parents=True, exist_ok=True)

    computer_kwargs = {
        "os_type": "linux",
        "provider_type": provider,
        "name": container_name,
    }
    cua_api_key = os.environ.get("CUA_API_KEY")
    if provider == "cloud" and cua_api_key:
        computer_kwargs["api_key"] = cua_api_key

    agent_kwargs = {
        "model": model,
        "tools": [],
        "max_retries": 2,
        "trajectory_dir": str(trajectory_dir),
        "verbosity": 30,
        "max_trajectory_budget": {"max_budget": budget_usd, "raise_error": False, "reset_after_each_run": True},
    }
    model_api_key = os.environ.get("VERIFIAI_CUA_MODEL_API_KEY")
    model_api_base = os.environ.get("VERIFIAI_CUA_MODEL_API_BASE")
    if model_api_key:
        agent_kwargs["api_key"] = model_api_key
    if model_api_base:
        agent_kwargs["api_base"] = model_api_base

    responses = []
    screenshot_refs = []
    started = time.time()

    async with Computer(**computer_kwargs) as computer:
        agent_kwargs["tools"] = [computer]
        agent = ComputerAgent(**agent_kwargs)
        prompt = (
            f"Target application: {target_url}\n"
            f"Persona: {persona or 'normal user'}\n"
            f"Objective: {objective}\n"
            "Use the real browser/desktop. Do not claim an action unless you performed it."
        )
        messages = [{"role": "user", "content": prompt}]
        async for item in agent.run(messages):
            for output_item in item.get("output", [item]):
                responses.append(compact(output_item))
                if len(responses) >= 100:
                    break
            if len(responses) >= 100:
                break
        try:
            image = await computer.interface.screenshot()
            shot = trajectory_dir / "final.png"
            shot.write_bytes(image)
            screenshot_refs.append(str(shot))
        except Exception as error:
            responses.append({"screenshot_error": str(error)})

    final_response = None
    completed = False
    for output_item in reversed(responses):
        if not isinstance(output_item, dict):
            continue
        if output_item.get("role") == "assistant":
            completed = True
        if output_item.get("type") != "message":
            continue
        content = output_item.get("content", [])
        if isinstance(content, str):
            text = content.strip()
            if text:
                final_response = text[:5000]
                if output_item.get("role") == "assistant":
                    break
        elif isinstance(content, list):
            texts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("text")]
            if texts:
                final_response = "\n".join(texts)[:5000]
                if output_item.get("role") == "assistant":
                    break
    return {
        "ok": True,
        "completed": completed,
        "engine": "Cua",
        "upstreamRepo": UPSTREAM_REPO,
        "upstreamCommit": UPSTREAM_COMMIT,
        "model": model,
        "provider": provider,
        "targetUrl": target_url,
        "objective": objective,
        "persona": persona or None,
        "durationMs": round((time.time() - started) * 1000),
        "actions": responses,
        "trajectory": responses,
        "screenshotRefs": screenshot_refs,
        "trajectoryRef": str(trajectory_dir),
        "finalResponse": final_response,
        "summary": f"Cua ComputerAgent completed {len(responses)} streamed response item(s).",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "verifiai-cua/1"

    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {
                "ok": True,
                "engine": "Cua",
                "upstreamRepo": UPSTREAM_REPO,
                "upstreamCommit": UPSTREAM_COMMIT,
                "version": UPSTREAM_COMMIT[:12],
            })
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/run", "/execute"):
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 256 * 1024:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            result = asyncio.run(run_agent(body))
            self.send_json(200, result)
        except Exception as error:
            self.send_json(500, {"ok": False, "error": str(error)})

    def log_message(self, fmt, *args):
        print(json.dumps({"service": "verifiai-cua", "message": fmt % args}))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8791"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
