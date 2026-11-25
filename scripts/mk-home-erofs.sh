#!/usr/bin/env bash
# Pack a directory into a deterministic, read-only EROFS home directory image
# (owned by uid/gid 1000, root mode 0700, zstd-15 compressed) using unkernel's
# patched erofs-utils. Intended to be attached as a secondary disk (/dev/wdb)
# and overlaid onto /home/user inside unkernel.
#
# Usage: scripts/mk-home-erofs.sh <SRC_DIR> <OUT_EROFS> [LABEL]
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
	echo "usage: $0 <SRC_DIR> <OUT_EROFS> [LABEL]" >&2
	exit 2
fi

SRC_DIR="$1"
OUT_EROFS="$2"
LABEL="${3:-kwhome}"

case "$LABEL" in
kwroot|kwdata)
	echo "error: label '$LABEL' is reserved by unkernel's /init; choose another label" >&2
	exit 2
	;;
esac

[ -d "$SRC_DIR" ] || { echo "error: source directory '$SRC_DIR' does not exist" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNKERNEL_DIR="$REPO_ROOT/unkernel"
KW_EROFS_COMPRESS="${KW_EROFS_COMPRESS:-zstd,level=15}"
KW_EROFS_OPTS="${KW_EROFS_OPTS:--C131072 -Efragments}"

bin="$("$UNKERNEL_DIR/guest/tools/erofs-utils.sh")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tar_path="$tmp/home.tar"
uuid="$(python3 -I - "$SRC_DIR" "$tar_path" <<'EOF'
import hashlib, os, stat, sys, tarfile

src_root, out_tar = sys.argv[1], sys.argv[2]

def walk(root):
    out = [""]
    def rec(rel):
        full = os.path.join(root, rel) if rel else root
        for name in sorted(os.listdir(full), key=os.fsencode):
            p = f"{rel}/{name}" if rel else name
            out.append(p)
            st = os.lstat(os.path.join(root, p))
            if stat.S_ISDIR(st.st_mode):
                rec(p)
    rec("")
    return out

inodes = {}
with tarfile.open(out_tar, "w", format=tarfile.GNU_FORMAT) as tf:
    for p in walk(src_root):
        full = os.path.join(src_root, p) if p else src_root
        st = os.lstat(full)
        info = tarfile.TarInfo("./" + p if p else ".")
        info.uid = 1000
        info.gid = 1000
        info.uname = ""
        info.gname = ""
        info.mtime = 0
        if stat.S_ISDIR(st.st_mode):
            info.type = tarfile.DIRTYPE
            info.mode = 0o700 if not p else (stat.S_IMODE(st.st_mode) | 0o700)
            tf.addfile(info)
        elif stat.S_ISLNK(st.st_mode):
            info.type = tarfile.SYMTYPE
            info.linkname = os.readlink(full)
            info.mode = 0o777
            tf.addfile(info)
        elif stat.S_ISREG(st.st_mode):
            key = (st.st_dev, st.st_ino)
            info.mode = stat.S_IMODE(st.st_mode)
            if st.st_nlink > 1 and key in inodes:
                info.type = tarfile.LNKTYPE
                info.linkname = "./" + inodes[key]
                tf.addfile(info)
            else:
                inodes[key] = p
                info.type = tarfile.REGTYPE
                info.size = st.st_size
                with open(full, "rb") as f:
                    tf.addfile(info, f)
        else:
            raise SystemExit(f"mk-home-erofs: {p}: unsupported file type {st.st_mode:o}")

h = hashlib.sha256()
with open(out_tar, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
d = h.hexdigest()
print(f"{d[0:8]}-{d[8:12]}-4{d[13:16]}-8{d[17:20]}-{d[20:32]}")
EOF
)"

mkdir -p "$(dirname "$OUT_EROFS")"
z=()
[ "$KW_EROFS_COMPRESS" = none ] || z=("-z$KW_EROFS_COMPRESS" $KW_EROFS_OPTS)
rm -f "$OUT_EROFS.tmp"
"$bin/mkfs.erofs" --quiet --tar=f -L "$LABEL" -U "$uuid" -T 0 --mkfs-time --preserve-mtime "${z[@]}" "$OUT_EROFS.tmp" "$tar_path"
"$bin/fsck.erofs" "$OUT_EROFS.tmp" >/dev/null || { "$bin/fsck.erofs" "$OUT_EROFS.tmp"; exit 1; }
mv "$OUT_EROFS.tmp" "$OUT_EROFS"

size="$(stat -c %s "$OUT_EROFS")"
awk -v f="$OUT_EROFS" -v l="$LABEL" -v s="$size" \
	'BEGIN { printf "Built %s (label=%s, %.2f MiB / %d bytes)\n", f, l, s / 1048576, s }'
