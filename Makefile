SHELL := /bin/bash

RCLONE_VERSION ?= 1.76.0
EXTENSION_UUID := saveme@chrismaille.github.io
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
VENV := .venv
PRE_COMMIT ?= $(VENV)/bin/pre-commit
PYTHON ?= python3

.PHONY: all setup setup-lint setup-hooks test tests coverage e2e e2e-extension e2e-app lint verify doctor run extension extension-zip deb ppa-source install uninstall clean

all: test

setup: $(RCLONE)

setup-lint:
	@if [ ! -x "$(PRE_COMMIT)" ]; then \
		$(PYTHON) -m venv $(VENV); \
		$(VENV)/bin/pip install --upgrade pip; \
		$(VENV)/bin/pip install -r requirements-dev.txt; \
	fi
	@if [ ! -x node_modules/.bin/eslint ]; then \
		if [ -f package-lock.json ]; then npm ci; else npm install; fi; \
	fi

setup-hooks: setup-lint
	$(PRE_COMMIT) install --hook-type pre-commit --hook-type commit-msg

lint: setup-lint
	git ls-files --cached --others --exclude-standard -z | \
		while IFS= read -r -d '' file; do \
			[ -e "$$file" ] && printf '%s\0' "$$file"; \
		done | \
		xargs -0 -r $(PRE_COMMIT) run --show-diff-on-failure --files

test: setup
	sh -n scripts/install.sh
	sh -n scripts/uninstall.sh
	sh -n scripts/install-dev.sh
	sh tests/shell/installer-dry-run.sh
	sh tests/shell/install-dev-dry-run.sh
	$(PYTHON) -m unittest discover -s tests/python -p 'test_*.py'
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m tests/run.js

tests: test e2e e2e-extension e2e-app

verify: lint tests

$(RCLONE):
	mkdir -p $(TOOLS_DIR)
	curl -fL --retry 3 -o $(TOOLS_DIR)/rclone.zip \
		https://downloads.rclone.org/v$(RCLONE_VERSION)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH).zip
	cd $(TOOLS_DIR) && unzip -q -o rclone.zip
	mv $(TOOLS_DIR)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH)/rclone $(RCLONE)
	chmod +x $(RCLONE)
	rm -rf $(TOOLS_DIR)/rclone.zip $(TOOLS_DIR)/rclone-v$(RCLONE_VERSION)-linux-$(RCLONE_ARCH)

coverage: setup
	rm -rf build/coverage
	mkdir -p build/coverage
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs \
		--coverage-prefix="file://$(CURDIR)" \
		--coverage-output="$(CURDIR)/build/coverage" \
		-m tests/run.js
	python3 scripts/coverage.py build/coverage/coverage.lcov \
		--root "$(CURDIR)" --strip-prefix build/coverage \
		--include src --exclude tests
	python3 scripts/coverage.py build/coverage/coverage.lcov \
		--root "$(CURDIR)" --strip-prefix build/coverage \
		--include src/domain --min-lines 95 --min-branches 95 --min-functions 95
	python3 scripts/coverage.py build/coverage/coverage.lcov \
		--root "$(CURDIR)" --strip-prefix build/coverage \
		--include src/application --min-lines 95 --min-branches 85 --min-functions 95
	python3 scripts/coverage.py build/coverage/coverage.lcov \
		--root "$(CURDIR)" --strip-prefix build/coverage \
		--include src/adapters --exclude src/adapters/rclone \
		--min-lines 90 --min-branches 85 --min-functions 90
	python3 scripts/coverage.py build/coverage/coverage.lcov \
		--root "$(CURDIR)" --strip-prefix build/coverage \
		--include src/adapters/dbus --min-lines 90 --min-branches 85 --min-functions 90

e2e: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) sh scripts/run-e2e.sh

e2e-extension: extension setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) sh scripts/e2e-extension.sh

e2e-app: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) sh scripts/e2e-app.sh

doctor: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m bin/saveme.js doctor

run: setup
	SAVEME_RCLONE=$(abspath $(RCLONE)) gjs -m bin/saveme.js $(ARGS)

extension: extension/i18n.js
	mkdir -p dist
	gnome-extensions pack extension -f -o dist --extra-source=icons \
		--extra-source=daemon-client.js --extra-source=presentation.js \
		--extra-source=system-launcher.js --extra-source=ui \
		--extra-source=i18n.js

extension-zip: extension/i18n.js
	mkdir -p dist
	rm -f dist/$(EXTENSION_UUID).shell-extension.zip
	(cd extension && zip -qr ../dist/$(EXTENSION_UUID).shell-extension.zip .)

extension/i18n.js: src/i18n.js
	printf '%s\n' '// Generated from src/i18n.js by make extension. Do not edit.' > $@
	cat src/i18n.js >> $@

deb: extension $(RCLONE)
	./scripts/build-deb.sh

ppa-source:
	./scripts/build-ppa-source.sh -sa

install: deb
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

clean:
	rm -rf build dist
