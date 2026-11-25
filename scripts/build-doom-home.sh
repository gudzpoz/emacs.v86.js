#!/usr/bin/env bash
# Build a portable Doom Emacs home directory EROFS image (containing .emacs.d,
# .config/doom, and README.org) by running `doom install` natively inside an
# Alpine edge container (podman or docker), then packing the resulting
# directory with scripts/mk-home-erofs.sh.
#
# Usage: scripts/build-doom-home.sh [OUT_EROFS]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_EROFS="${1:-$REPO_ROOT/build/unkernel-home/doom.erofs}"

DOOM_REPO="${DOOM_REPO:-https://github.com/doomemacs/doomemacs}"
STAGE="$REPO_ROOT/build/unkernel-home/doom-root"

if [ -n "${CONTAINER_RT:-}" ]; then
	rt="$CONTAINER_RT"
elif command -v podman >/dev/null; then
	rt=podman
elif command -v docker >/dev/null; then
	rt=docker
else
	echo "error: need podman or docker to build doom.erofs (or set CONTAINER_RT)" >&2
	exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$REPO_ROOT/README.org" "$STAGE/README.org"

echo "Installing Doom Emacs using $rt (docker.io/alpine:edge)..."
"$rt" run --rm -e DOOM_REPO="$DOOM_REPO" -v "$STAGE:/home/user" docker.io/alpine:edge sh -eu -c '
	owner=$(stat -c "%u:%g" /home/user)
	grep -q "/community" /etc/apk/repositories || echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories
	apk add --no-cache emacs-nox git ripgrep
	export HOME=/home/user
	git clone --depth 1 "$DOOM_REPO" /home/user/.emacs.d
	/home/user/.emacs.d/bin/doom install --force --no-env \
		|| /home/user/.emacs.d/bin/doom sync --force \
		|| /home/user/.emacs.d/bin/doom sync --force
	find /home/user/.emacs.d -name .git -type d -prune -exec rm -rf {} +
	chown -R "$owner" /home/user
'

"$REPO_ROOT/scripts/mk-home-erofs.sh" "$STAGE" "$OUT_EROFS" kwdoom
