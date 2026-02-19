#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_DIR="${ROOT_DIR}/services"

ensure_repo() {
  local name="$1"
  local repo_url="$2"
  local target_dir="${SERVICES_DIR}/${name}"

  if [[ -d "${target_dir}/.git" ]]; then
    echo "==> ${name}: repo already present"
    return
  fi

  if [[ -d "${target_dir}" ]] && [[ -n "$(ls -A "${target_dir}" 2>/dev/null)" ]]; then
    echo "==> ${name}: using existing non-git directory at ${target_dir}"
    return
  fi

  rm -rf "${target_dir}"
  echo "==> Cloning ${name} from ${repo_url}"
  git clone --depth 1 "${repo_url}" "${target_dir}"
}

ensure_repo "mcp-opentargets" "https://github.com/Augmented-Nature/OpenTargets-MCP-Server.git"
ensure_repo "mcp-reactome" "https://github.com/Augmented-Nature/Reactome-MCP-Server.git"
ensure_repo "mcp-string" "https://github.com/Augmented-Nature/STRING-db-MCP-Server.git"
ensure_repo "mcp-chembl" "https://github.com/Augmented-Nature/ChEMBL-MCP-Server.git"
ensure_repo "mcp-medical" "https://github.com/jamesanz/medical-mcp.git"
ensure_repo "biomcp" "https://github.com/genomoncology/biomcp.git"

for svc in mcp-opentargets mcp-reactome mcp-string mcp-chembl mcp-pubmed mcp-medical; do
  if [[ -f "${SERVICES_DIR}/${svc}/package.json" ]]; then
    echo "==> Installing and building services/${svc}"
    (cd "${SERVICES_DIR}/${svc}" && npm install && npm run build)
  else
    echo "==> Skipping services/${svc} (package.json not found)"
  fi
done

echo "==> Installing biomcp-python locally (optional if using Docker)"
python3 -m pip install --user biomcp-python || true

echo "Bootstrap complete."
