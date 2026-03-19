CONTAINER_NAME=alpine-v86
IMAGE_NAME=i386/alpine-v86

TAR_EXPORT=build/alpine-rootfs.tar
FS_EXPORT=public/rootfs.json
FS_DIR=public/rootfs

all: $(FS_EXPORT)

$(TAR_EXPORT): scripts/Containerfile
	mkdir -p build
	podman build -f "$<" --platform linux/386 --rm --tag "$(IMAGE_NAME)"
	podman rm "$(CONTAINER_NAME)" || true
	podman create --platform linux/386 -it --name "$(CONTAINER_NAME)" "$(IMAGE_NAME)"
	podman export "$(CONTAINER_NAME)" -o "$@"
	tar -f "$OUT_ROOTFS_TAR" --delete ".dockerenv" || true

$(FS_EXPORT): $(TAR_EXPORT)
	mkdir -p "$(FS_DIR)"
	v86/tools/fs2json.py --out "$@" "$<"
	v86/tools/copy-to-sha256.py "$<" "$(FS_DIR)"
