CONTAINER_NAME=alpine-v86
IMAGE_NAME=i386/alpine-v86

TAR_EXPORT=build/alpine-rootfs.tar
FS_EXPORT=public/rootfs.json
FS_DIR=public/rootfs
STATE_MINI=public/state-mini.bin
STATE_FULL=public/state-full.bin
STATES_GZIP=$(STATE_MINI).gzip $(STATE_FULL).gzip
STATES_BROTLI=$(STATE_MINI).brotli $(STATE_FULL).brotli
STATES=$(STATE_MINI) $(STATE_FULL) $(STATES_GZIP) $(STATES_BROTLI)

SPACEMACS_URL=https://github.com/syl20bnr/spacemacs/archive/refs/heads/develop.zip
SPACEMACS=build/spacemacs.zip
SPACEMACS_DIR=build/spacemacs-develop
DOT_SPACEMACS=build/dotspacemacs-template.el

TERM_ENV=LANG=C.UTF-8 COLORTERM=truecolor
EMACS_ENV=$(TERM_ENV)

all: $(FS_EXPORT) $(STATES)

$(SPACEMACS):
	wget -O "$@" "$(SPACEMACS_URL)"
	unzip -o "$@" -d build/

$(DOT_SPACEMACS): $(SPACEMACS)
	cp "$(SPACEMACS_DIR)/core/templates/dotspacemacs-template.el" "$@"

$(TAR_EXPORT): $(SPACEMACS) $(DOT_SPACEMACS) scripts/Containerfile
	mkdir -p build
	podman build -f scripts/Containerfile . --platform linux/386 --rm --tag "$(IMAGE_NAME)"
	podman rm "$(CONTAINER_NAME)" || true
	podman create --platform linux/386 -it --name "$(CONTAINER_NAME)" "$(IMAGE_NAME)"
	podman export "$(CONTAINER_NAME)" -o "$@"
	tar -f "$(TAR_EXPORT)" --delete ".dockerenv" || true

$(FS_EXPORT): $(TAR_EXPORT)
	mkdir -p "$(FS_DIR)"
	v86/tools/fs2json.py --out "$@" "$<"
	v86/tools/copy-to-sha256.py "$<" "$(FS_DIR)"

$(STATE_MINI): $(FS_EXPORT) scripts/build-state.js
	scripts/build-state.js "$<" "$(FS_DIR)" "$@" \
		"$(EMACS_ENV) emacs -Q --daemon" \
		"$(EMACS_ENV) emacsclient -c --eval \"(run-with-idle-timer 10 nil #'suspend-frame)\""

$(STATE_FULL): $(FS_EXPORT) scripts/build-state.js
	scripts/build-state.js "$<" "$(FS_DIR)" "$@" \
		"$(EMACS_ENV) emacs --daemon" \
		"$(EMACS_ENV) emacsclient -c --eval \"(run-with-idle-timer 10 nil #'suspend-frame)\""

# https://stackoverflow.com/a/76693814/17780636: use .gzip instead of .gz to avoid vite's bug
public/state-%.bin.gzip: public/state-%.bin
	gzip -f -k -S .gzip "$<"

public/state-%.bin.brotli: public/state-%.bin
	brotli -f --best --suffix=.brotli "$<"
