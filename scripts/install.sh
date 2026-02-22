#!/usr/bin/env bash
set -euo pipefail

# Wilson installer
# Usage: curl -fsSL https://github.com/shetty4l/wilson/releases/latest/download/install.sh | bash

SERVICE_NAME="wilson"
REPO="shetty4l/wilson"
INSTALL_BASE="${HOME}/srv/wilson"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"

# --- source shared install functions from @shetty4l/core ---

INSTALL_LIB_URL="https://raw.githubusercontent.com/shetty4l/core/main/scripts/install-lib.sh"

install_lib=$(mktemp)
if ! curl -fsSL -o "$install_lib" "$INSTALL_LIB_URL"; then
  printf '\033[1;31m==>\033[0m %s\n' "Failed to download install-lib.sh from ${INSTALL_LIB_URL}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$install_lib"
rm -f "$install_lib"

# --- Wilson-specific: deploy scripts ---

make_deploy_executable() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"
  chmod +x "$version_dir/deploy/wilson-update.sh"
  ok "Deploy scripts marked executable"
}

# --- Wilson-specific: LaunchAgents ---

# Install a single LaunchAgent plist.
# Args: $1 = label (e.g. "com.suyash.wilson"), $2 = description for log
install_single_agent() {
  local label="$1"
  local description="$2"
  local plist_template="${INSTALL_BASE}/latest/deploy/plists/${label}.plist"
  local plist_dest="${LAUNCH_AGENTS_DIR}/${label}.plist"

  if [ ! -f "$plist_template" ]; then
    warn "Plist not found: ${plist_template}, skipping ${description}"
    return 0
  fi

  sed "s|\${HOME}|${HOME}|g" "$plist_template" > "$plist_dest"
  ok "LaunchAgent installed: ${plist_dest}"

  if [ "${SKIP_LAUNCHAGENT_RELOAD:-0}" = "1" ]; then
    warn "Skipping LaunchAgent reload for ${description} (managed by updater)"
    return 0
  fi

  local uid
  uid=$(id -u)
  launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "$plist_dest" 2>/dev/null || {
    warn "Could not load ${description}. Load it manually:"
    warn "  launchctl bootstrap gui/${uid} ${plist_dest}"
  }
  ok "${description} loaded"
}

install_launch_agent() {
  mkdir -p "$LAUNCH_AGENTS_DIR"

  # Updater agent: timer-based, runs wilson-update.sh every 4 minutes
  install_single_agent "com.suyash.wilson-updater" "Updater LaunchAgent (every 4min)"

  # Daemon agent: KeepAlive, runs wilson serve
  install_single_agent "com.suyash.wilson" "Daemon LaunchAgent (KeepAlive)"
}

# --- Wilson-specific: status ---

print_status() {
  echo ""
  echo "=========================================="
  ok "Wilson installed successfully!"
  echo "=========================================="
  echo ""
  echo "  Version:      ${RELEASE_TAG}"
  echo "  Install:      ${INSTALL_BASE}/latest"
  echo "  CLI:          ${BIN_DIR}/wilson"
  echo "  Daemon log:   ~/.config/wilson/wilson.log"
  echo "  Update log:   ~/Library/Logs/wilson-updater.log"
  echo ""
  echo "  Check service status:"
  echo "    wilson status"
  echo ""
  echo "  Check service health:"
  echo "    wilson health"
  echo ""
  echo "  View update logs:"
  echo "    wilson logs updater"
  echo ""
}

# --- main ---

main() {
  info "Wilson installer"
  echo ""

  check_prereqs
  fetch_latest_release
  download_and_extract
  make_deploy_executable
  update_symlink
  prune_versions
  install_cli
  install_launch_agent
  print_status
}

main "$@"
