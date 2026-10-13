BUILD_DIR ?= dist
GO ?= go
VENV ?= .venv
PYTHON ?= $(shell if [ -f "$(VENV)/bin/python3" ]; then echo "$(VENV)/bin/python3"; else echo "python3"; fi)

.PHONY: help build build-host build-cli build-operator build-operator-linux-amd64 build-operator-linux-arm64 test test-go lint lint-go format-go compose-config venv bun-install bun-check bun-build skills-test skills-verify workspace-templates-test clean-logs smoke smoke-local smoke-local-live

help:
	@printf '%s\n' \
		'build              Build the host CLI and Linux operator artifacts' \
		'build-host         Build the host openlia CLI' \
		'build-cli          Alias for build-host' \
		'build-operator     Build Linux amd64 and arm64 operator artifacts' \
		'build-operator-linux-amd64  Build the Linux amd64 operator artifact' \
		'build-operator-linux-arm64  Build the Linux arm64 operator artifact' \
		'test               Run Go, Python, skill, and operator tests' \
		'test-go            Run Go unit and integration tests with race detector' \
		'format-go          Format all Go source files' \
		'lint-go            Run go vet and formatting checks on Go source files' \
		'venv               Create local virtualenv and install dependencies from requirements-dev.txt' \
		'skills-test        Run offline skill self-tests' \
		'workspace-templates-test  Validate bundled workspace and skill templates' \
		'skills-verify      Run bundled skill and browser relay tests' \
		'clean-logs         Purge local .playwright-mcp and verification test logs' \
		'deploy-dev         Verify skills and deploy to local dev stack' \
		'deploy-prod        Verify skills and promote to production stack' \
		'lint               Run formatting and shell checks' \
		'compose-config     Validate the base Compose file' \
		'smoke              Run provider-free static smoke checks' \
		'smoke-local        Deploy and remove a provider-free local stack' \
		'smoke-local-live   Deploy a credential-backed local stack; cleanup is opt-in'

build:
	$(MAKE) bun-install bun-build build-host build-operator

build-host build-cli: bun-install bun-build
	$(GO) build -o openlia .

build-operator: build-operator-linux-amd64 build-operator-linux-arm64

build-operator-linux-amd64:
	mkdir -p "$(BUILD_DIR)" "operator/linux-amd64"
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -o "$(BUILD_DIR)/openlia-operator-linux-amd64" ./cmd/operator
	cp "$(BUILD_DIR)/openlia-operator-linux-amd64" "operator/linux-amd64/openlia-operator"

build-operator-linux-arm64:
	mkdir -p "$(BUILD_DIR)" "operator/linux-arm64"
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -o "$(BUILD_DIR)/openlia-operator-linux-arm64" ./cmd/operator
	cp "$(BUILD_DIR)/openlia-operator-linux-arm64" "operator/linux-arm64/openlia-operator"

venv:
	@if command -v uv >/dev/null 2>&1; then \
		echo "Creating virtual environment using uv in $(VENV)..."; \
		uv venv $(VENV) && uv pip install --python $(VENV)/bin/python -r requirements-dev.txt; \
	else \
		echo "Creating virtual environment using python3 -m venv in $(VENV)..."; \
		python3 -m venv $(VENV) && $(VENV)/bin/pip install -r requirements-dev.txt; \
	fi
	@echo "Virtual environment ready in $(VENV)."

test:
	$(MAKE) workspace-templates-test
	$(MAKE) bun-install bun-check bun-build
	$(MAKE) test-go
	$(PYTHON) -m py_compile tests/smoke.py
	$(PYTHON) -m unittest tests.test_openlia_policy_plugin
	$(PYTHON) -m unittest tests.test_openlia_ingestion
	for script in profile/skills/*/scripts/*.py; do $(PYTHON) "$$script" --self-test; done

test-go:
	$(GO) test -race ./...
	$(GO) vet ./...

format-go:
	gofmt -s -w main.go cli operator cmd internal

lint-go:
	gofmt -d main.go cli operator cmd internal
	$(GO) vet ./...

bun-install:
	bun install --frozen-lockfile --ignore-scripts

bun-check:
	bun run check
	bun run typecheck
	bun run test

bun-build:
	bun run build

lint:
	bun run format:check
	bun run lint
	gofmt -d main.go cli operator cmd internal
	bash -n docker/*.sh
	shellcheck docker/*.sh

compose-config:
	OPENLIA_DATA_ROOT=/tmp/openlia-compose-check/runtime/hermes \
	OPENLIA_SYSTEM_SKILLS_ROOT=/tmp/openlia-compose-check/runtime/system-skills \
	OPENLIA_META_ROOT=/tmp/openlia-compose-check/runtime/meta \
	OPENLIA_BACKUP_ROOT=/tmp/openlia-compose-check/runtime/backups \
	OPENLIA_RUNTIME_UID=$$(id -u) \
	OPENLIA_RUNTIME_GID=$$(id -g) \
	OPENLIA_OPERATION_LOCK=/tmp/openlia-compose-check.operation.lock \
	OPENLIA_SECRET_DIR=/tmp/openlia-compose-check/runtime/secrets \
	OPENLIA_NETWORK_NAME=openlia-compose-check-private \
	docker compose -f docker/compose.yaml config --quiet

skills-test:
	$(PYTHON) tests/verify_skills.py --offline

workspace-templates-test:
	$(PYTHON) tests/validate_workspace_templates.py --self-test
	$(PYTHON) tests/validate_workspace_templates.py

skills-verify:
	$(PYTHON) tests/verify_skills.py --offline
	bun test packages/openlia-browser

clean-logs:
	rm -rf .playwright-mcp/ /tmp/openlia_verify/

deploy-dev: skills-test
	OPENLIA_CONFIG=$$HOME/.config/openlia/dev/config.toml ./openlia deploy

deploy-prod: skills-test
	OPENLIA_CONFIG=$$HOME/.config/openlia/config.toml ./openlia update openlia

smoke:
	python3 tests/smoke.py --mode cli

smoke-local:
	python3 tests/smoke.py --mode local

smoke-local-live:
	@test -n "$(OPENLIA_SMOKE_ENV_FILE)" || (printf '%s\n' 'OPENLIA_SMOKE_ENV_FILE is required' >&2; exit 2)
	@test -n "$(OPENLIA_SMOKE_ATTACHMENTS_FILE)" || (printf '%s\n' 'OPENLIA_SMOKE_ATTACHMENTS_FILE is required' >&2; exit 2)
	@test -n "$(OPENLIA_SMOKE_LOCHO_HOST)" || (printf '%s\n' 'OPENLIA_SMOKE_LOCHO_HOST is required' >&2; exit 2)
	python3 tests/smoke.py --mode live --local \
		--project "$(or $(OPENLIA_SMOKE_PROJECT),openlia_smoke)" \
		--root "$(or $(OPENLIA_SMOKE_ROOT),/tmp/openlia_smoke)" \
		--env-file "$(OPENLIA_SMOKE_ENV_FILE)" \
		--attachments-file "$(OPENLIA_SMOKE_ATTACHMENTS_FILE)" \
		--locho-host "$(OPENLIA_SMOKE_LOCHO_HOST)"
