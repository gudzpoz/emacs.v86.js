#!/usr/bin/env bash
# Build an Alpine Linux edge (aarch64) EROFS image for unkernel with emacs-nox
# (Emacs 31.1) and emacs-doc pre-installed, reusing unkernel's guest build
# library without modifying the unkernel/ git submodule.
#
# Outputs (under KW_DISTRO_OUT, default build/unkernel-distro):
#   alpine.erofs    compressed, boot-ordered EROFS image with KWDISTRO header
#   alpine.id       content-addressed image id
#   distros.json    unkernel distro index matching the base bundle
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNKERNEL_DIR="$REPO_ROOT/unkernel"

export KW_BASE_OUT="${KW_BASE_OUT:-$REPO_ROOT/build/unkernel-base}"
export KW_DISTRO_OUT="${KW_DISTRO_OUT:-$REPO_ROOT/build/unkernel-distro}"
export KW_DISTRO_FORMATS="${KW_DISTRO_FORMATS:-erofs}"
export KW_DISTRO_DIR="$UNKERNEL_DIR/guest/distro/alpine"

ALPINE_EXTRA_PKGS="${ALPINE_EXTRA_PKGS:-emacs-nox emacs-doc git ripgrep}"
KW_VM_MEM="${KW_VM_MEM:-1536}"
KW_VM_TIMEOUT="${KW_VM_TIMEOUT:-900}"

# --- fetch prebuilt unkernel.wasm matching the submodule tag -----------------
mkdir -p "$KW_BASE_OUT"
base_wasm="$KW_BASE_OUT/unkernel.wasm"
if [ ! -f "$base_wasm" ]; then
	UNKERNEL_TAG="${UNKERNEL_TAG:-$(git -C "$UNKERNEL_DIR" describe --tags --exact-match 2>/dev/null || true)}"
	if [ -z "$UNKERNEL_TAG" ]; then
		echo "error: unkernel submodule is not on an exact release tag; set UNKERNEL_TAG=<tag>" >&2
		exit 1
	fi
	wasm_url="https://github.com/pithings/unkernel/releases/download/$UNKERNEL_TAG/unkernel.wasm"
	echo "Fetching $wasm_url -> $base_wasm"
	curl -fL --retry 3 -o "$base_wasm.part" "$wasm_url"
	magic="$(head -c 4 "$base_wasm.part" | od -An -tx1 | tr -d ' \n')"
	if [ "$magic" != "0061736d" ]; then
		rm -f "$base_wasm.part"
		echo "error: downloaded $wasm_url is not a WebAssembly binary (magic: $magic)" >&2
		exit 1
	fi
	mv "$base_wasm.part" "$base_wasm"
fi

# --- load unkernel guest build library & Alpine pins -------------------------
# shellcheck source=../unkernel/guest/lib/env.sh
. "$UNKERNEL_DIR/guest/lib/env.sh"
# shellcheck source=../unkernel/guest/lib/stage.sh
. "$UNKERNEL_DIR/guest/lib/stage.sh"
# shellcheck source=../unkernel/guest/lib/image.sh
. "$UNKERNEL_DIR/guest/lib/image.sh"
# shellcheck source=../unkernel/guest/distro/alpine/pins.sh
. "$UNKERNEL_DIR/guest/distro/alpine/pins.sh"

umask 022
need_zig
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
	echo "error: Node.js >= 24 is required for unkernel guest/tools/vm-run.ts" >&2
	exit 1
fi
[ -f "$base_bundle" ] || { echo "error: missing base bundle $base_bundle" >&2; exit 1; }

here="$guest/distro/alpine"

# --- stage upstream Alpine minirootfs & switch repositories to edge ----------
distro_unpack alpine ALPINE

r="$stage/etc/apk/repositories"
grep '/community$' "$r" > "$stage/etc/kw-apk-lazy" || { echo "alpine: no community line in $r" >&2; exit 1; }
grep -v '/community$' "$r" > "$r.kw" && cat "$r.kw" > "$r" && rm "$r.kw"
sed -i 's|/v[^/]*/|/edge/|g' "$r" "$stage/etc/kw-apk-lazy"
grep -q '/edge/main$' "$r" || { echo "alpine: failed to switch $r to edge/main" >&2; exit 1; }
grep -q '/edge/community$' "$stage/etc/kw-apk-lazy" || { echo "alpine: failed to switch kw-apk-lazy to edge/community" >&2; exit 1; }

install_tree "$here/rootfs" "$stage"
chmod 400 "$stage/etc/doas.d/kw-user.conf"
install_common "$stage"
echo 'hvc0' >> "$stage/etc/securetty"

# --- upgrade to Alpine edge and install doas + emacs-nox + emacs-doc in VM ---
gen=alpine-apkgen
(KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 \
	distro_images "$gen" "$stage" "$ALPINE_TARBALL" "alpine-edge") >/dev/null

read -r -d '' guest_script <<'EOF' || true
set -e
u=/run/kw-lower/kw/tmp/upper
[ -d "$u" ]
t=$(date +%s)
sleep 1
/etc/kw-apk-enable
apk upgrade --no-cache --available
apk add --no-cache doas doas-sudo-shim __ALPINE_EXTRA_PKGS__
find /etc -name '*.apk-new' -delete
grep -q 'kwbox tty serve' /etc/inittab
emacs --batch -Q --eval '(princ (emacs-version))'
echo
ls /usr/share/info/emacs* >/dev/null
cd "$u"
find . -mindepth 1 ! -path './etc/resolv.conf' ! -path './var/cache/apk*' ! -path './tmp*' ! -path './run*' -type c \
	-exec stat -c '%Z %n' {} + | awk -v t="$t" '$1 > t { sub(/^[0-9]+ /, ""); print }' | sort > /tmp/kw-gone
find . -mindepth 1 ! -path './etc/resolv.conf' ! -path './var/cache/apk*' ! -path './tmp*' ! -path './run*' ! -type c \
	-exec stat -c '%Z %n' {} + | awk -v t="$t" '$1 > t { sub(/^[0-9]+ /, ""); print }' | sort > /tmp/kw-list
tar -cf /tmp/kw-pkgs.tar --no-recursion --numeric-owner -T /tmp/kw-list
EOF
guest_script="${guest_script/__ALPINE_EXTRA_PKGS__/$ALPINE_EXTRA_PKGS}"

echo "Upgrading to Alpine edge and installing doas, doas-sudo-shim, and $ALPINE_EXTRA_PKGS inside unkernel VM..."
node "$guest/tools/vm-run.ts" "$base_bundle" "$distro_out/$gen.erofs" \
	--mem "$KW_VM_MEM" --net --timeout "$KW_VM_TIMEOUT" \
	--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" \
	--get /tmp/kw-gone="$distro_out/$gen.gone" \
	"$guest_script" ||
	{ echo "alpine: upgrading to edge and installing packages in the image failed" >&2; exit 1; }

while IFS= read -r p; do
	[ -n "$p" ] || continue
	rm -rf "${stage:?}/${p#./}"
done < "$distro_out/$gen.gone"
tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner
rm -f "$distro_out/$gen".{erofs,tar,id,pkgs.tar,gone}

# --- create default user & README --------------------------------------------
[ -x "$stage/usr/bin/doas" ] && [ -x "$stage/usr/bin/sudo" ] ||
	{ echo "alpine: doas/sudo missing after package install" >&2; exit 1; }
install_user "$stage" /bin/sh wheel audio video input users
install_readme "$stage" alpine NAME="Alpine Linux" USERLAND="musl, busybox" PKG="apk add" \
	MIRROR="Alpine's" AUTO=KW_AUTO_APK DISTRO=alpine REPO=https://github.com/pithings/unkernel

# --- build final EROFS image & distros.json ----------------------------------
distro_images alpine "$stage" "$ALPINE_TARBALL" "alpine-edge" "${user_owner[@]}"
node "$guest/tools/distros-json.mjs" "$distro_out" --bundle "$base_bundle"

# --- smoke-test final image offline ------------------------------------------
echo "Smoke-testing $distro_out/alpine.erofs..."
node "$guest/tools/vm-run.ts" "$base_bundle" "$distro_out/alpine.erofs" --timeout 180 \
	"su - user -c \"sudo -n true && emacs --batch -Q --eval '(princ (emacs-version))'\" && echo && ls /usr/share/info/emacs* >/dev/null" ||
	{ echo "alpine: smoke test of $distro_out/alpine.erofs failed" >&2; exit 1; }
