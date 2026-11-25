#!/usr/bin/env bash
# Build a portable Spacemacs home directory EROFS image (containing .emacs.d,
# .spacemacs, and README.org) by running Emacs 31.1 batch package installation
# natively inside an Alpine edge container (podman or docker), then packing the
# resulting directory with scripts/mk-home-erofs.sh.
#
# Usage: scripts/build-spacemacs-home.sh [OUT_EROFS]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_EROFS="${1:-$REPO_ROOT/build/unkernel-home/spacemacs.erofs}"

SPACEMACS_URL="${SPACEMACS_URL:-https://github.com/syl20bnr/spacemacs/archive/refs/heads/develop.zip}"
SPACEMACS_ZIP="$REPO_ROOT/build/spacemacs.zip"
SPACEMACS_DIR="$REPO_ROOT/build/spacemacs-develop"
STAGE="$REPO_ROOT/build/unkernel-home/spacemacs-root"

if [ -n "${CONTAINER_RT:-}" ]; then
	rt="$CONTAINER_RT"
elif command -v podman >/dev/null; then
	rt=podman
elif command -v docker >/dev/null; then
	rt=docker
else
	echo "error: need podman or docker to build spacemacs.erofs (or set CONTAINER_RT)" >&2
	exit 1
fi

mkdir -p "$REPO_ROOT/build"
if [ ! -f "$SPACEMACS_ZIP" ]; then
	echo "Downloading $SPACEMACS_URL -> $SPACEMACS_ZIP"
	curl -fL --retry 3 -o "$SPACEMACS_ZIP.part" "$SPACEMACS_URL"
	mv "$SPACEMACS_ZIP.part" "$SPACEMACS_ZIP"
fi

rm -rf "$SPACEMACS_DIR"
unzip -q -o "$SPACEMACS_ZIP" -d "$REPO_ROOT/build"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a "$SPACEMACS_DIR" "$STAGE/.emacs.d"
cp "$SPACEMACS_DIR/core/templates/dotspacemacs-template.el" "$STAGE/.spacemacs"
cp "$REPO_ROOT/README.org" "$STAGE/README.org"

echo "Installing Spacemacs packages using $rt (docker.io/alpine:edge)..."
"$rt" run --rm -v "$STAGE:/home/user" docker.io/alpine:edge sh -eu -c '
	owner=$(stat -c "%u:%g" /home/user)
	grep -q "/community" /etc/apk/repositories || echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories
	apk add --no-cache emacs-nox git
	export HOME=/home/user
	/usr/bin/emacs --batch -l /home/user/.emacs.d/early-init.el -l /home/user/.emacs.d/init.el \
		|| /usr/bin/emacs --batch -l /home/user/.emacs.d/early-init.el -l /home/user/.emacs.d/init.el \
		|| /usr/bin/emacs --batch -l /home/user/.emacs.d/early-init.el -l /home/user/.emacs.d/init.el
	rm -rf /home/user/.emacs.d/.git
	chown -R "$owner" /home/user
'

"$REPO_ROOT/scripts/mk-home-erofs.sh" "$STAGE" "$OUT_EROFS" kwspacemacs
