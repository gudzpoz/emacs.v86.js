UNKERNEL_EROFS=build/unkernel-distro/alpine.erofs
UNKERNEL_MANIFEST=public/unkernel/alpine.erofs.json

all: $(UNKERNEL_MANIFEST)

$(UNKERNEL_EROFS): scripts/build-unkernel-alpine.sh
	scripts/build-unkernel-alpine.sh

$(UNKERNEL_MANIFEST): $(UNKERNEL_EROFS) scripts/chunk-unkernel.mjs
	node scripts/chunk-unkernel.mjs

clean:
	rm -rf build/unkernel-distro public/unkernel

.PHONY: all clean
