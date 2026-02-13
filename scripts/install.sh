#!/usr/bin/env bash
set -euo pipefail

# Wilson installer
# Usage: curl -fsSL https://github.com/shetty4l/wilson/releases/latest/download/install.sh | bash

REPO="shetty4l/wilson"
INSTALL_BASE="${HOME}/srv/wilson"
BIN_DIR="${HOME}/.local/bin"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
MAX_VERSIONS=5

# --- helpers ---

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }
die()   { err "$@"; exit 1; }

check_prereqs() {
  local missing=()
  for cmd in bun curl tar jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required tools: ${missing[*]}"
  fi
}

# --- fetch latest release ---

fetch_latest_release() {
  info "Fetching latest release from GitHub..."
  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")

  RELEASE_TAG=$(echo "$release_json" | jq -r '.tag_name')
  TARBALL_URL=$(echo "$release_json" | jq -r '.assets[] | select(.name | startswith("wilson-")) | .browser_download_url')

  if [ -z "$RELEASE_TAG" ] || [ "$RELEASE_TAG" = "null" ]; then
    die "No releases found for ${REPO}"
  fi
  if [ -z "$TARBALL_URL" ] || [ "$TARBALL_URL" = "null" ]; then
    die "No tarball asset found in release ${RELEASE_TAG}"
  fi

  info "Latest release: ${RELEASE_TAG}"
}

# --- download and extract ---

download_and_extract() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"

  if [ -d "$version_dir" ]; then
    warn "Version ${RELEASE_TAG} already exists at ${version_dir}, reinstalling..."
    rm -rf "$version_dir"
  fi

  mkdir -p "$version_dir"

  info "Downloading ${RELEASE_TAG}..."
  local tmpfile
  tmpfile=$(mktemp)
  curl -fsSL -o "$tmpfile" "$TARBALL_URL"

  info "Extracting to ${version_dir}..."
  tar xzf "$tmpfile" -C "$version_dir"
  rm -f "$tmpfile"

  info "Installing dependencies..."
  (cd "$version_dir" && bun install --frozen-lockfile)

  info "Creating CLI wrapper..."
  cat > "$version_dir/wilson" <<'WRAPPER'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$(readlink "$0" || echo "$0")")" && pwd)"
exec bun run "$SCRIPT_DIR/src/cli.ts" "$@"
WRAPPER
  chmod +x "$version_dir/wilson"

  # Make deploy scripts executable
  chmod +x "$version_dir/deploy/wilson-update.sh"

  ok "Installed ${RELEASE_TAG} to ${version_dir}"
}

# --- symlink management ---

update_symlink() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"
  local latest_link="${INSTALL_BASE}/latest"

  # Atomic symlink swap (ln -sfn avoids a window where the link is missing)
  ln -sfn "$version_dir" "$latest_link"
  echo "$RELEASE_TAG" > "${INSTALL_BASE}/current-version"

  ok "Symlinked latest -> ${RELEASE_TAG}"
}

# --- prune old versions ---

prune_versions() {
  local versions=()
  for d in "${INSTALL_BASE}"/v*; do
    [ -d "$d" ] && versions+=("$(basename "$d")")
  done

  if [ ${#versions[@]} -eq 0 ]; then
    return
  fi

  IFS=$'\n' sorted=($(printf '%s\n' "${versions[@]}" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/'))
  unset IFS

  local count=${#sorted[@]}
  if [ "$count" -gt "$MAX_VERSIONS" ]; then
    local remove_count=$((count - MAX_VERSIONS))
    for ((i = 0; i < remove_count; i++)); do
      local old_version="${sorted[$i]}"
      info "Removing old version: ${old_version}"
      rm -rf "${INSTALL_BASE}/${old_version}"
    done
  fi
}

# --- CLI binary ---

install_cli() {
  mkdir -p "$BIN_DIR"
  ln -sf "${INSTALL_BASE}/latest/wilson" "${BIN_DIR}/wilson"
  ok "CLI linked: ${BIN_DIR}/wilson"

  if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
    warn "~/.local/bin is not in your PATH. Add it to your shell profile:"
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
}

# --- LaunchAgent ---

install_launch_agent() {
  mkdir -p "$LAUNCH_AGENTS_DIR"

  local plist_template="${INSTALL_BASE}/latest/deploy/plists/com.suyash.wilson-updater.plist"
  local plist_dest="${LAUNCH_AGENTS_DIR}/com.suyash.wilson-updater.plist"

  if [ -f "$plist_template" ]; then
    sed "s|\${HOME}|${HOME}|g" "$plist_template" > "$plist_dest"
    ok "LaunchAgent installed: ${plist_dest}"

    # Load the agent (unload first if already loaded)
    local uid
    uid=$(id -u)
    launchctl bootout "gui/${uid}/com.suyash.wilson-updater" 2>/dev/null || true
    launchctl bootstrap "gui/${uid}" "$plist_dest" 2>/dev/null || {
      warn "Could not load LaunchAgent. Load it manually:"
      warn "  launchctl bootstrap gui/${uid} ${plist_dest}"
    }
    ok "LaunchAgent loaded (updates every 60s)"
  else
    warn "LaunchAgent plist not found in release, skipping"
  fi
}

# --- status ---

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
  update_symlink
  prune_versions
  install_cli
  install_launch_agent
  print_status
}

main "$@"
