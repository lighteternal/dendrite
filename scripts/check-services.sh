#!/usr/bin/env bash
set -euo pipefail

check_http() {
  local name="$1"
  local url="$2"
  shift 2
  local expected=("$@")
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || true)"

  for want in "${expected[@]}"; do
    if [[ "$code" == "$want" ]]; then
      echo "[ok]  $name -> $url (HTTP $code)"
      return
    fi
  done

  echo "[err] $name -> $url (HTTP $code)"
}

check_http "OpenTargets MCP" "http://localhost:7010/ping" 200
check_http "Reactome MCP" "http://localhost:7020/ping" 200
check_http "STRING MCP" "http://localhost:7030/ping" 200
check_http "ChEMBL MCP" "http://localhost:7040/ping" 200
check_http "PubMed MCP" "http://localhost:7050/ping" 200
check_http "Medical MCP" "http://localhost:7060/mcp" 400 404 405 406

# BioMCP streamable HTTP endpoint returns 406 unless Accept: text/event-stream.
check_http "BioMCP" "http://localhost:8000/mcp" 200 406
