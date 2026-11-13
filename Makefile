SHELL := /bin/bash
GO ?= go
BUN ?= bun
PYTHON ?= python3
VENV_DIR ?= .venv
VENV_PYTHON := $(VENV_DIR)/bin/python
TEST_PYTHON := $(shell if [ -x "$(VENV_PYTHON)" ]; then printf '%s' "$(VENV_PYTHON)"; else command -v $(PYTHON); fi)
SHELLCHECK ?= $(shell command -v shellcheck 2>/dev/null)
PREFIX ?= $(HOME)/.local
BIN_DIR ?= $(PREFIX)/bin
OPENLIA_INSTALL_CONFIG ?= $(HOME)/.config/openlia/config.toml

.PHONY: build build-ui build-cli build-operator install venv lint fmt test smoke deploy-prod clean versions-generate versions-check

build-ui:
	$(BUN) run verify-dist

build-operator: build-ui
	mkdir -p dist
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o dist/openlia-operator-linux-amd64 ./cmd/operator
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o dist/openlia-operator-linux-arm64 ./cmd/operator

build-cli: build-operator
	$(GO) build -trimpath -o openlia .

build: build-cli

install: build
	mkdir -p "$(BIN_DIR)/dist"
	install -m 0755 openlia "$(BIN_DIR)/openlia"
	install -m 0755 dist/openlia-operator-linux-amd64 "$(BIN_DIR)/dist/openlia-operator-linux-amd64"
	install -m 0755 dist/openlia-operator-linux-arm64 "$(BIN_DIR)/dist/openlia-operator-linux-arm64"
	@printf 'Installed openlia to %s/openlia\n' "$(BIN_DIR)"
	@case ":$$PATH:" in \
		*":$(BIN_DIR):"* ) ;; \
		* ) printf 'Note: add %s to your PATH (for example: export PATH="%s:$$PATH")\n' "$(BIN_DIR)" "$(BIN_DIR)" ;; \
	esac

venv:
	$(PYTHON) -m venv $(VENV_DIR)
	$(VENV_DIR)/bin/pip install --upgrade pip

versions-generate:
	$(GO) run ./cmd/release-manifest sync

versions-check:
	$(GO) run ./cmd/release-manifest check

fmt:
	$(BUN) run format
	gofmt -w main.go main_test.go cli cmd internal operator

lint: versions-check
	$(BUN) run check
	test -z "$$(gofmt -l main.go main_test.go cli cmd internal operator)"
	$(GO) vet ./...
	@if [ -n "$(SHELLCHECK)" ]; then \
		"$(SHELLCHECK)" docker/secret-source.sh; \
	else \
		printf 'shellcheck not installed; skipping shell lint\n'; \
	fi

test: build-operator
	$(GO) run ./cmd/release-manifest check
	$(BUN) run test
	$(GO) test ./...

smoke: build
	OPENLIA_BINARY="$$PWD/openlia" $(TEST_PYTHON) tests/smoke.py --mode cli

deploy-prod: build
	./openlia deploy --config "$(OPENLIA_INSTALL_CONFIG)" --release --non-interactive

clean:
	rm -rf openlia dist packages/openlia-browser/dist
