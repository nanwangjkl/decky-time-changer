#!/usr/bin/env bash
# Build & deploy the plugin to a Steam Deck over SSH.
#
# Configuration (environment variables, or a .deploy.env file in repo root):
#   DECK_IP    - Deck hostname or IP          (required, e.g. 192.168.1.10)
#   DECK_USER  - SSH user                     (default: deck)
#   DECK_PORT  - SSH port                     (default: 22)
#   DECK_KEY   - path to SSH private key      (optional; if unset and sshpass
#                is installed, password auth from DECK_PASS is used)
#   DECK_PASS  - password for sudo/ssh        (optional, only with sshpass)
#
# Usage:
#   ./deploy.sh          # build + rsync + restart plugin_loader
#   ./deploy.sh zip      # build + package a store-style zip into out/
#   ./deploy.sh restart  # restart plugin_loader only
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .deploy.env ]]; then
  # shellcheck disable=SC1091
  source .deploy.env
fi

DECK_USER="${DECK_USER:-deck}"
DECK_PORT="${DECK_PORT:-22}"
PLUGIN_DIR_NAME="decky-time-changer"
REMOTE_PLUGINS_DIR="\$HOME/homebrew/plugins"

SSH_ARGS=(-p "$DECK_PORT")
if [[ -n "${DECK_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$DECK_KEY")
elif command -v sshpass >/dev/null 2>&1 && [[ -n "${DECK_PASS:-}" ]]; then
  SSH_ARGS+=( -o PreferredAuthentications=password)
else
  SSH_ARGS+=()
fi

remote() {
  if [[ -n "${DECK_KEY:-}" ]]; then
    ssh "${SSH_ARGS[@]}" "$DECK_USER@$DECK_IP" "$@"
  elif command -v sshpass >/dev/null 2>&1 && [[ -n "${DECK_PASS:-}" ]]; then
    sshpass -p "$DECK_PASS" ssh "${SSH_ARGS[@]}" "$DECK_USER@$DECK_IP" "$@"
  else
    ssh "${SSH_ARGS[@]}" "$DECK_USER@$DECK_IP" "$@"
  fi
}

remote_sudo() {
  # run a command as root on the Deck (needs DECK_PASS, or NOPASSWD sudo)
  if [[ -n "${DECK_PASS:-}" ]]; then
    remote "printf '%s\n' '$DECK_PASS' | sudo -S -p '' $*"
  else
    remote "sudo -n $*"
  fi
}

build() {
  echo "==> Building frontend"
  pnpm install --silent
  pnpm run build
}

deploy() {
  build
  echo "==> Deploying to $DECK_USER@$DECK_IP"
  RSYNC_RSH="$(printf '%q ' ssh "${SSH_ARGS[@]}")"
  export RSYNC_RSH
  rsync -azp --delete \
    plugin.json package.json main.py README.md LICENSE dist py_modules \
    --rsync-path="mkdir -p $REMOTE_PLUGINS_DIR/$PLUGIN_DIR_NAME" \
    "$DECK_USER@$DECK_IP:$REMOTE_PLUGINS_DIR/$PLUGIN_DIR_NAME/"
  echo "==> Restarting plugin_loader"
  remote_sudo "systemctl restart plugin_loader"
  echo "==> Done. Plugin installed at ~/homebrew/plugins/$PLUGIN_DIR_NAME"
}

package_zip() {
  build
  local version
  version=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
  local stage="out/stage"
  rm -rf "$stage" "out/$PLUGIN_DIR_NAME-v$version.zip"
  mkdir -p "$stage/$PLUGIN_DIR_NAME"
  cp -R plugin.json package.json main.py README.md LICENSE dist py_modules "$stage/$PLUGIN_DIR_NAME/"
  (cd "$stage" && zip -qr "../$PLUGIN_DIR_NAME-v$version.zip" "$PLUGIN_DIR_NAME")
  rm -rf "$stage"
  echo "==> Wrote out/$PLUGIN_DIR_NAME-v$version.zip"
}

restart_only() {
  echo "==> Restarting plugin_loader"
  remote_sudo "systemctl restart plugin_loader"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  zip) package_zip ;;
  restart) restart_only ;;
  *)
    echo "Usage: $0 [deploy|zip|restart]" >&2
    exit 1
    ;;
esac
