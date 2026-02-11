#!/usr/bin/env bash
set -euo pipefail

check() {
  local name="$1"
  local url="$2"
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "[ok]  $name -> $url"
  else
    echo "[err] $name -> $url"
  fi
}

check "OpenTargets MCP" "http://localhost:7010/ping"
check "Reactome MCP" "http://localhost:7020/ping"
check "STRING MCP" "http://localhost:7030/ping"
check "ChEMBL MCP" "http://localhost:7040/ping"
check "BioMCP" "http://localhost:8000/"
