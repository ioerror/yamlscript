ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
IMAGE := ys-www-dev
RUN := podman run --rm --init --userns=keep-id \
  --security-opt label=disable \
  --volume $(ROOT):$(ROOT) --workdir $(ROOT)/www \
  --env HOME=/tmp $(IMAGE)

image:
	podman build --tag $(IMAGE) --file $(ROOT)/dev/Containerfile $(ROOT)/dev

test: image
	$(RUN) make deps test

offline-test: image
	$(RUN) bash $(ROOT)/dev/offline-test.sh

.PHONY: image test offline-test
