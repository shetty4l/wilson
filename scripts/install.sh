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

# --- Wilson-specific: LaunchAgent ---

install_launch_agent() {
  mkdir -p "$LAUNCH_AGENTS_DIR"

  local plist_template="${INSTALL_BASE}/latest/deploy/plists/com.suyash.wilson-updater.plist"
  local plist_dest="${LAUNCH_AGENTS_DIR}/com.suyash.wilson-updater.plist"

  if [ -f "$plist_template" ]; then
    sed "s|\${HOME}|${HOME}|g" "$plist_template" > "$plist_dest"
    ok "LaunchAgent installed: ${plist_dest}"

    if [ "${SKIP_LAUNCHAGENT_RELOAD:-0}" = "1" ]; then
      warn "Skipping LaunchAgent reload (managed by updater)"
    else
      local uid
      uid=$(id -u)
      launchctl bootout "gui/${uid}/com.suyash.wilson-updater" 2>/dev/null || true
      launchctl bootstrap "gui/${uid}" "$plist_dest" 2>/dev/null || {
        warn "Could not load LaunchAgent. Load it manually:"
        warn "  launchctl bootstrap gui/${uid} ${plist_dest}"
      }
      ok "LaunchAgent loaded (updates every 4min)"
    fi
  else
    warn "LaunchAgent plist not found in release, skipping"
  fi
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
