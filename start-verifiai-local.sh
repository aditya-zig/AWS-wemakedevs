#!/bin/bash
# VERIFIAI local restart - API + Web; audits use the real Strands worker process
# Respects 7GB RAM machine. Does NOT start heavy external engines.
set -e
cd "$(dirname "$0")"
set -a; source .env; set +a
export GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-local-github-client}"
export GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-local-github-secret}"
export GITHUB_CALLBACK_URL="${GITHUB_CALLBACK_URL:-http://localhost:8787/api/auth/github/callback}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-local-google-client}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-local-google-secret}"
export GOOGLE_CALLBACK_URL="${GOOGLE_CALLBACK_URL:-http://localhost:8787/api/auth/google/callback}"
export VERIFIAI_STATE_SECRET="${VERIFIAI_STATE_SECRET:-local-verifiai-state-secret}"
export VERIFIAI_LOCAL_WORKER_MODE="${VERIFIAI_LOCAL_WORKER_MODE:-process}"
mkdir -p data logs
pkill -f "dist/apps/api/index.js" 2>/dev/null || true
pkill -f "scripts/serve-web.mjs" 2>/dev/null || true
sleep 1
nohup node dist/apps/api/index.js > logs/api.log 2>&1 &
echo "API pid $! - http://localhost:8787/health"
nohup node scripts/serve-web.mjs > logs/web.log 2>&1 &
echo "WEB pid $! - http://localhost:4173"
sleep 2
curl -s http://localhost:8787/health || echo "API not ready yet, check logs/api.log"
curl -s -o /dev/null -w "WEB %{http_code}\n" http://localhost:4173/
echo "Done. Real-agent audit example:"
echo "curl -X POST http://localhost:8787/api/audits -H 'content-type: application/json' -d '{\"repository\":{\"provider\":\"github\",\"fullName\":\"aditya-zig/AWS-wemakedevs\",\"url\":\"https://github.com/aditya-zig/AWS-wemakedevs\",\"branch\":\"main\"},\"target\":{\"id\":\"local-web\",\"url\":\"http://localhost:4173\",\"environment\":\"shared-observation\",\"immutable\":true}}'"
echo "Note: isolated Docker workers need Docker daemon running. Without it they report Incomplete truthfully."
