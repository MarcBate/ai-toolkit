#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# Start AI Toolkit in WSL
# - optional git pull
# - optional pip install -r requirements.txt if repo updated
# - optional npm install if missing
# - optional python environment checks
# - start UI
# - wait for http://localhost:8675
# - open in Windows browser
# ------------------------------------------------------------

# -----------------------------
# Settings
# -----------------------------
ROOT="/mnt/c/Data/git/AIToolkitWSL"
REPO_DIR="${ROOT}/ai-toolkit"
VENV_DIR="${REPO_DIR}/venv"
UI_DIR="${REPO_DIR}/ui"

UI_PORT="8675"
UI_URL="http://localhost:${UI_PORT}"
LOG_FILE="${ROOT}/ai-toolkit-ui.log"

DO_GIT_PULL="1"
DO_PIP_INSTALL_ON_UPDATE="1"
DO_NPM_INSTALL_IF_MISSING="1"
DO_NPM_INSTALL_ON_UPDATE="0"

# Set to 1 to run Python environment checks before launch.
# Default is 0 to skip them.
RUN_ENV_CHECKS="0"

# Hugging Face cache on Windows NTFS
export HF_HOME="/mnt/c/Users/marc.bate/.cache/huggingface"
export HUGGINGFACE_HUB_CACHE="/mnt/c/Users/marc.bate/.cache/huggingface/hub"
export TRANSFORMERS_CACHE="/mnt/c/Users/marc.bate/.cache/huggingface/hub"

# Optional stability knobs
export GIT_LFS_SKIP_SMUDGE=1
export PYTHONUNBUFFERED=1

# -----------------------------
# Helpers
# -----------------------------
die() {
  echo
  echo "ERROR: $*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

wait_for_url() {
  local url="$1"
  local max_sec="$2"
  local start now
  start="$(date +%s)"

  while true; do
    if have_cmd curl; then
      if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      if python - <<PY >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("${url}", timeout=2).read(1)
PY
      then
        return 0
      fi
    fi

    sleep 2
    now="$(date +%s)"
    if (( now - start > max_sec )); then
      return 1
    fi
  done
}

open_in_windows() {
  local url="$1"

  if have_cmd powershell.exe; then
    powershell.exe -NoProfile -Command "Start-Process '${url}'" >/dev/null 2>&1 || true
  elif have_cmd cmd.exe; then
    cmd.exe /c start "$url" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local exit_code=$?

  if [[ -n "${UI_PID:-}" ]]; then
    if kill -0 "$UI_PID" >/dev/null 2>&1; then
      echo
      echo "Stopping AI Toolkit UI..."
      kill "$UI_PID" >/dev/null 2>&1 || true
      wait "$UI_PID" >/dev/null 2>&1 || true
    fi
  fi

  exit "$exit_code"
}

# -----------------------------
# Main
# -----------------------------
trap cleanup EXIT INT TERM

echo
echo "========== AI Toolkit (WSL) =========="
echo "Repo: ${REPO_DIR}"
echo "Venv: ${VENV_DIR}"
echo "UI:   ${UI_URL}"
echo "Log:  ${LOG_FILE}"
echo

have_cmd git || die "git not found. Run: sudo apt-get update && sudo apt-get install -y git"
have_cmd python3 || die "python3 not found in WSL."
have_cmd npm || die "npm not found in WSL. Run: sudo apt-get update && sudo apt-get install -y nodejs npm"
have_cmd ffmpeg || die "ffmpeg not found in WSL. Run: sudo apt-get update && sudo apt-get install -y ffmpeg"

[[ -d "${REPO_DIR}/.git" ]] || die "Repo not found at ${REPO_DIR}"
[[ -f "${VENV_DIR}/bin/activate" ]] || die "venv not found at ${VENV_DIR}. Create/fix it first."

cd "${REPO_DIR}"

UPDATED="0"

if [[ "${DO_GIT_PULL}" == "1" ]]; then
  echo "---- Checking for updates from origin/main..."
  git fetch origin main

  LOCAL_HASH="$(git rev-parse HEAD)"
  REMOTE_HASH="$(git rev-parse origin/main)"
  BASE_HASH="$(git merge-base HEAD origin/main)"

  if [[ "${LOCAL_HASH}" == "${REMOTE_HASH}" ]]; then
    echo "---- Already up to date with origin/main."
  elif [[ "${BASE_HASH}" == "${REMOTE_HASH}" ]]; then
    echo "---- Your local branch is ahead of origin/main. No updates to pull."
  else
    # origin/main has new commits not yet in this branch
    NEW_COUNT="$(git rev-list HEAD..origin/main --count)"
    echo
    echo "---- ${NEW_COUNT} update(s) available from origin/main:"
    git log --oneline HEAD..origin/main
    echo
    read -r -p "Fetch and merge updates now? [y/N] " _answer
    case "${_answer}" in
      [Yy]|[Yy][Ee][Ss])
        echo "---- Merging updates from origin/main..."
        if git merge origin/main -m "Auto-merge from origin/main"; then
          echo "---- Successfully merged updates."
          UPDATED="1"
        else
          echo "---- Merge conflict detected! Please resolve manually."
          git merge --abort 2>/dev/null || true
          exit 1
        fi
        ;;
      *)
        echo "---- Skipping merge. Continuing with current code."
        ;;
    esac
  fi
else
  echo "---- Skipping git fetch/pull"
fi

echo
echo "---- Activating venv..."
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

python -c "import sys; print('python', sys.executable)" || die "python failed after activating venv"

if [[ "${RUN_ENV_CHECKS}" == "1" ]]; then
  echo
  echo "---- Verifying Python environment..."
  python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" || die "torch import failed"

  python - <<'PY' || die "torchaudio import failed"
import torchaudio
print("torchaudio", torchaudio.__version__)
PY

  python - <<'PY' || die "torchcodec import failed"
import torchcodec
print("torchcodec import ok")
PY

  python - <<'PY' || die "LTX-2.3 vocoder import failed"
import diffusers.pipelines.ltx2.vocoder as v
ok = "LTX2VocoderWithBWE" in dir(v)
print("LTX2VocoderWithBWE:", ok)
if not ok:
    raise SystemExit(1)
PY
else
  echo
  echo "---- Skipping Python environment checks (RUN_ENV_CHECKS=0)"
fi

if [[ "${DO_PIP_INSTALL_ON_UPDATE}" == "1" && "${UPDATED}" == "1" ]]; then
  echo
  echo "---- Repo updated. Syncing Python requirements..."
  python -m pip install --upgrade pip setuptools wheel
  python -m pip install --no-cache-dir -r requirements.txt
fi

echo
echo "---- Checking Node/npm dependencies..."
if [[ "${DO_NPM_INSTALL_IF_MISSING}" == "1" && ! -e "${UI_DIR}/node_modules" ]]; then
  echo "---- node_modules missing. Running npm install..."
  cd "${UI_DIR}"
  npm install
  cd "${REPO_DIR}"
elif [[ "${DO_NPM_INSTALL_ON_UPDATE}" == "1" && "${UPDATED}" == "1" ]]; then
  echo "---- Repo updated. Running npm install..."
  cd "${UI_DIR}"
  npm install
  cd "${REPO_DIR}"
fi

if wait_for_url "${UI_URL}" 2; then
  echo
  echo "UI already responding at ${UI_URL}"
  open_in_windows "${UI_URL}"
  exit 0
fi

echo
echo "---- Starting UI server..."
echo "Logs will also be appended to: ${LOG_FILE}"
echo

mkdir -p "$(dirname "${LOG_FILE}")"

cd "${UI_DIR}"

# If the repo was updated (or no prior build exists) run the full build+start.
# Otherwise skip the rebuild and go straight to start — saves 3+ minutes.
if [[ "${UPDATED}" == "1" || ! -d "${UI_DIR}/.next" ]]; then
  echo "---- Running full build (repo updated or no prior build found)..."
  UI_CMD="npm run build_and_start"
else
  echo "---- Skipping rebuild (no upstream changes). Running npm run start..."
  UI_CMD="npm run start"
fi

(
  ${UI_CMD} 2>&1 | tee -a "${LOG_FILE}"
) &
UI_PID=$!

echo "UI PID: ${UI_PID}"
echo "Waiting for ${UI_URL} ..."

if wait_for_url "${UI_URL}" 600; then
  echo "UI is up: ${UI_URL}"
  open_in_windows "${UI_URL}"
else
  echo
  echo "UI did not come up within 600 seconds."
  echo "Check the log: ${LOG_FILE}"
  exit 1
fi

wait "${UI_PID}"
