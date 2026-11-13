SHELL := /bin/bash

RCLONE_VERSION ?= 1.76.0
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_M),x86_64)
  RCLONE_ARCH := amd64
else ifeq ($(UNAME_M),aarch64)
  RCLONE_ARCH := arm64
else
  $(error Unsupported architecture: $(UNAME_M))
endif

TOOLS_DIR := tools
RCLONE := $(TOOLS_DIR)/rclone

.PHONY: all setup test doctor run extension deb install uninstall clean

all: test

setup: $(RCLONE)

$(RCLONE):
	mkdir -p $(TOOLS_DIR)
	curl -fL --retry 3 -o $(TOOLS_DIR)/rclone.zip \
		https://downloads.rclone.org/v$(RCLONE_VERSION)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH).zip
	cd $(TOOLS_DIR) && unzip -q -o rclone.zip
	mv $(TOOLS_DIR)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH)/rclone $(RCLONE)
	chmod +x $(RCLONE)
	rm -rf $(TOOLS_DIR)/rclone.zip $(TOOLS_DIR)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH)

test: setup
	sh -n scripts/install.sh
	sh -n scripts/uninstall.sh
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m tests/run.js

doctor: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m bin/saveme.js doctor

run: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m bin/saveme.js $(ARGS)

extension:
	mkdir -p dist
	gnome-extensions pack extension -f -o dist --extra-source=icons

deb: extension $(RCLONE)
	./scripts/build-deb.sh

install: deb
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

clean:
	rm -rf build dist
