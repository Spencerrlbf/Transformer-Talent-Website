#!/bin/bash
# Establishes the ACTUAL runtime of the hosted deployment and the Actions workers,
# read-only, during hosted validation (not run under the 2026-10-05 instruction).
# Needs: VERCEL_TOKEN (or `vercel login`), the project id/name, and `gh` for Actions.
#   bash scripts/person-release/hosted-runtime-check.sh <vercel-project> <deployment-url>
set -euo pipefail
PROJECT="${1:?vercel project id or name}"; DEPLOYMENT="${2:?deployment url or id}"
TOKEN="${VERCEL_TOKEN:-$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/com.vercel.cli/auth.json')))['token'])" 2>/dev/null || true)}"
: "${TOKEN:?VERCEL_TOKEN required}"
api(){ curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.vercel.com$1"; }
echo "project nodeVersion (setting; package.json#engines overrides it at build):"
api "/v9/projects/$PROJECT" | python3 -c "import json,sys;p=json.load(sys.stdin);print(' ',p.get('nodeVersion'),'| framework',p.get('framework'))"
echo "deployment build log lines naming the Node.js version (the version that built and runs the server):"
DEP_ID=$(api "/v13/deployments/$DEPLOYMENT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['id']);print(' meta engines:',d.get('meta',{}).get('nodeVersion'),file=sys.stderr)")
api "/v3/deployments/$DEP_ID/events?builds=1&limit=2000" | python3 -c "import json,sys
for e in json.load(sys.stdin):
  t=(e.get('payload') or {}).get('text') or ''
  if 'Node.js' in t or 'node-version' in t or 'engines' in t: print(' ',t.strip()[:160])"
echo "Actions workers: the setup-node version of the latest run of each normalized workflow:"
for wf in review-queue.yml refresh-queue.yml sync-candidates.yml derivative-worker.yml; do
  RUN=$(gh run list --workflow "$wf" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  [ -n "$RUN" ] && echo "  $wf run $RUN: $(gh run view "$RUN" --log 2>/dev/null | grep -m1 -o 'node-version: [0-9.]*\|Found in cache @ [^ ]*\|Node.js v[0-9.]*' || echo 'no version line')" || echo "  $wf: no run yet"
done
echo "Expected everywhere: Node 24.x (package.json#engines, .nvmrc, workflows)."
