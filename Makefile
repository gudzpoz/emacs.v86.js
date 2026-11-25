ALPINE_EROFS=build/unkernel-distro/alpine.erofs
SPACEMACS_EROFS=build/unkernel-home/spacemacs.erofs
DOOM_EROFS=build/unkernel-home/doom.erofs
README_EROFS=build/unkernel-home/readme.erofs

ALPINE_MANIFEST=src/alpine.erofs.json
SPACEMACS_MANIFEST=src/spacemacs.erofs.json
DOOM_MANIFEST=src/doom.erofs.json
README_MANIFEST=src/readme.erofs.json

all: $(ALPINE_MANIFEST) $(SPACEMACS_MANIFEST) $(DOOM_MANIFEST) $(README_MANIFEST)

$(ALPINE_EROFS): scripts/build-unkernel-alpine.sh
	scripts/build-unkernel-alpine.sh

$(SPACEMACS_EROFS): scripts/build-spacemacs-home.sh scripts/mk-home-erofs.sh README.org
	scripts/build-spacemacs-home.sh "$@"

$(DOOM_EROFS): scripts/build-doom-home.sh scripts/mk-home-erofs.sh README.org
	scripts/build-doom-home.sh "$@"

$(README_EROFS): README.org scripts/mk-home-erofs.sh
	rm -rf build/unkernel-home/readme-root
	mkdir -p build/unkernel-home/readme-root
	cp README.org build/unkernel-home/readme-root/README.org
	scripts/mk-home-erofs.sh build/unkernel-home/readme-root "$@" kwreadme

src/alpine.erofs.json: $(ALPINE_EROFS) scripts/chunk-unkernel.mjs
	node scripts/chunk-unkernel.mjs "$<" "$@" public/unkernel

src/spacemacs.erofs.json: $(SPACEMACS_EROFS) scripts/chunk-unkernel.mjs
	node scripts/chunk-unkernel.mjs "$<" "$@" public/unkernel

src/doom.erofs.json: $(DOOM_EROFS) scripts/chunk-unkernel.mjs
	node scripts/chunk-unkernel.mjs "$<" "$@" public/unkernel

src/readme.erofs.json: $(README_EROFS) scripts/chunk-unkernel.mjs
	node scripts/chunk-unkernel.mjs "$<" "$@" public/unkernel

clean:
	rm -rf build/unkernel-distro build/unkernel-home public/unkernel src/*.erofs.json

.PHONY: all clean
