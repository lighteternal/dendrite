#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for svc in mcp-opentargets mcp-reactome mcp-string mcp-chembl; do
  echo "==> Installing and building services/${svc}"
  (cd "${ROOT_DIR}/services/${svc}" && npm install && npm run build)
done

echo "==> Installing biomcp-python locally (optional if using Docker)"
python3 -m pip install --user biomcp-python || true

echo "Bootstrap complete."
