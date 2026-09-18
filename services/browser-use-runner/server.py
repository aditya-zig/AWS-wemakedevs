import asyncio
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from browser_use import Agent, Browser, ChatOpenAI

UPSTREAM_REPO = "browser-use/browser-use"
UPSTREAM_COMMIT = "d8110c5ff87ccba887aaa726cdb780f2f84bef8d"


async def run_browser(body):
    target_url = str(body.get("targetUrl") or "").strip()
    objective = str(body.get("objective") or "").strip()
    persona = str(body.get("persona") or "").strip()
    if not target_url or not objective:
        raise ValueError("targetUrl and objective are required")

    model = str(body.get("model") or os.environ.get("VERIFIAI_BROWSER_USE_MODEL") or "gpt-5-mini")
    base_url = str(body.get("baseUrl") or os.environ.get("VERIFIAI_BROWSER_USE_MODEL_BASE_URL") or "https://openrouter.ai/api/v1")
    api_key = str(body.get("apiKey") or os.environ.get("VERIFIAI_BROWSER_USE_MODEL_API_KEY") or "")
    if not api_key:
        raise ValueError("VERIFIAI_BROWSER_USE_MODEL_API_KEY is required")

    max_steps = max(1, min(int(body.get("maxSteps") or 20), 60))
    llm = ChatOpenAI(model=model, base_url=base_url, api_key=api_key)
    browser = Browser(headless=True, chromium_sandbox=False)
    task = (
        f"Open this target first: {target_url}\n"
        f"Act as persona: {persona or 'normal user'}\n"
        f"Objective: {objective}\n"
        "Use the real website. Do not claim clicks, navigation, forms, or results unless you actually performed/observed them."
    )
    started = time.time()
    try:
        agent = Agent(task=task, llm=llm, browser=browser)
        history = await agent.run(max_steps=max_steps)
        return {
            "ok": True,
            "engine": "Browser Use",
            "upstreamRepo": UPSTREAM_REPO,
            "upstreamCommit": UPSTREAM_COMMIT,
            "targetUrl": target_url,
            "objective": objective,
            "persona": persona or None,
            "model": model,
            "durationMs": round((time.time() - started) * 1000),
            "urls": [url for url in history.urls() if url],
            "actions": history.action_names(),
            "screenshotRefs": [path for path in history.screenshot_paths() if path],
            "errors": [str(error) for error in history.errors() if error],
            "finalResult": history.final_result(),
            "done": history.is_done(),
            "successful": history.is_successful(),
            "steps": history.number_of_steps(),
        }
    finally:
        try:
            await browser.stop()
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "verifiai-browser-use/1"

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
                "engine": "Browser Use",
                "upstreamRepo": UPSTREAM_REPO,
                "upstreamCommit": UPSTREAM_COMMIT,
            })
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 256 * 1024:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            self.send_json(200, asyncio.run(run_browser(body)))
        except Exception as error:
            self.send_json(500, {"ok": False, "error": str(error)})

    def log_message(self, fmt, *args):
        print(json.dumps({"service": "verifiai-browser-use", "message": fmt % args}))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8792"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
