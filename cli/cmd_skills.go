package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func commandSkills(options Options, args []string, assets fs.FS) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "skills requires list, show, test, status, fork, migrate, enable, or disable", nil)
	}
	action := args[0]
	args = args[1:]
	switch action {
	case "list":
		if len(args) != 0 {
			return fail(options, ExitUsage, "skills list takes no positional arguments", nil)
		}
		config, err := loadConfig()
		if errors.Is(err, os.ErrNotExist) {
			config = defaultConfig()
		} else if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		entries := make([]map[string]any, 0, len(defaultSkills))
		for _, skill := range defaultSkills {
			content, readErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join("profile", "skills", skill, "SKILL.md")))
			if readErr != nil {
				return fail(options, ExitInternal, "missing bundled skill "+skill, nil)
			}
			entries = append(entries, map[string]any{"name": skill, "origin": "bundled", "enabled": contains(config.EnabledSkills, skill), "available": len(content) > 0})
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "skills": entries}, skillListHuman(config))
	case "show":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills show requires a bundled skill name", nil)
		}
		content, err := readBundledOrFeatureSkillFile(assets, args[0], "SKILL.md")
		if err != nil {
			if !contains(defaultSkills, args[0]) {
				return fail(options, ExitUsage, "skills show requires a bundled skill name", nil)
			}
			return fail(options, ExitInternal, err.Error(), nil)
		}
		if options.JSON {
			return writeResult(options, map[string]any{"schema": 1, "ok": true, "name": args[0], "content": string(content)}, "")
		}
		fmt.Fprint(os.Stdout, string(content))
		return ExitOK
	case "status":
		if len(args) > 1 || (len(args) == 1 && !safeComponent(args[0])) {
			return fail(options, ExitUsage, "skills status accepts at most one safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		statusArgs := []string{}
		if len(args) == 1 {
			statusArgs = append(statusArgs, "--skill", args[0])
		}
		if options.JSON {
			statusArgs = append(statusArgs, "--json")
		}
		ctx, cancel := remoteContext()
		defer cancel()
		raw, err := newDeployment(config).operation(ctx, "skill-status", nil, statusArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, "openlia skills status: read-only skill provenance inspection")
	case "fork":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills fork requires an installed safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		ctx, cancel := remoteContext()
		defer cancel()
		raw, err := newDeployment(config).operation(ctx, "skill-fork", nil, args[0], "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, "openlia skills fork: active skill preserved and customization lineage recorded")
	case "migrate":
		return commandSkillMigration(options, args)
	case "test":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills test requires a bundled skill name", nil)
		}
		if _, err := resolveBundledOrFeatureSkillDir(assets, args[0]); err != nil {
			return fail(options, ExitUsage, "skills test requires a bundled skill name", nil)
		}
		return testSkill(options, assets, args[0])
	case "enable", "disable":
		if len(args) != 1 || !safeComponent(args[0]) {
			return fail(options, ExitUsage, "skills enable/disable requires an installed safe skill name", nil)
		}
		config, code := configOrError(options)
		if code != ExitOK {
			return code
		}
		if !(action == "enable" && !config.SkillsConfigured && contains(config.EnabledSkills, args[0])) {
			config.EnabledSkills = setSkill(config.EnabledSkills, args[0], action == "enable")
		}
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if config.Mode == "local" || config.Target != "" {
			ctx, cancel := remoteContext()
			defer cancel()
			if _, err := newDeployment(config).operation(ctx, "profile", nil, "sync", "--json"); err != nil {
				return fail(options, ExitFailure, err.Error(), nil)
			}
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": args[0], "enabled": action == "enable"}, fmt.Sprintf("skill %s: %s", args[0], action+"d"))
	default:
		return fail(options, ExitUsage, "unknown skills action "+action, nil)
	}
}

func commandSkillMigration(options Options, args []string) int {
	if len(args) != 2 || !safeComponent(args[1]) {
		return fail(options, ExitUsage, "skills migrate requires prepare, show, apply, or reject plus a safe name", nil)
	}
	action, identifier := args[0], args[1]
	if action != "prepare" && action != "show" && action != "apply" && action != "reject" {
		return fail(options, ExitUsage, "skills migrate requires prepare, show, apply, or reject", nil)
	}
	if action == "apply" {
		if options.NonInteractive {
			return fail(options, ExitUsage, "migration apply requires interactive confirmation", nil)
		}
		expected := "apply migration " + identifier
		fmt.Fprintf(os.Stderr, "Apply migration proposal %s? Type %q to continue: ", identifier, expected)
		answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil || strings.TrimSpace(answer) != expected {
			return fail(options, ExitFailure, "migration apply cancelled", nil)
		}
	}
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).operation(ctx, "skill-migration", nil, action, identifier, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, "openlia skills migrate: operation completed")
}

func skillListHuman(config Config) string {
	lines := make([]string, 0, len(defaultSkills))
	for _, skill := range defaultSkills {
		state := "disabled"
		if contains(config.EnabledSkills, skill) {
			state = "enabled"
		}
		lines = append(lines, fmt.Sprintf("%s: %s", skill, state))
	}
	return strings.Join(lines, "\n")
}

func resolveBundledOrFeatureSkillDir(assets fs.FS, name string) (string, error) {
	basePath := filepath.ToSlash(filepath.Join("profile", "skills", name))
	if _, err := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(basePath, "SKILL.md"))); err == nil {
		return basePath, nil
	}
	featPath := filepath.ToSlash(filepath.Join("features", name, "skills", name))
	if _, err := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(featPath, "SKILL.md"))); err == nil {
		return featPath, nil
	}
	return "", fs.ErrNotExist
}

func readBundledOrFeatureSkillFile(assets fs.FS, name, relFile string) ([]byte, error) {
	dir, err := resolveBundledOrFeatureSkillDir(assets, name)
	if err != nil {
		return nil, err
	}
	return fs.ReadFile(assets, filepath.ToSlash(filepath.Join(dir, relFile)))
}

func testSkill(options Options, assets fs.FS, name string) int {
	skillBaseDir, dirErr := resolveBundledOrFeatureSkillDir(assets, name)
	if dirErr != nil {
		skillBaseDir = filepath.ToSlash(filepath.Join("profile", "skills", name))
	}
	directory := filepath.ToSlash(filepath.Join(skillBaseDir, "scripts"))
	entries, err := fs.ReadDir(assets, directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			skillPath := filepath.ToSlash(filepath.Join(skillBaseDir, "SKILL.md"))
			if skillData, readErr := fs.ReadFile(assets, skillPath); readErr == nil && len(skillData) > 0 {
				return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": name, "output": "prompt skill verified: no deterministic helper script required"}, name+": self-test passed")
			}
		}
		return fail(options, ExitInternal, err.Error(), nil)
	}
	temporary, err := os.MkdirTemp("", "openlia-skill-*")
	if err != nil {
		return fail(options, ExitInternal, err.Error(), nil)
	}
	defer os.RemoveAll(temporary)
	systemScriptsDir := filepath.ToSlash(filepath.Join("profile", "system-skills", "workspace-template-customization", "scripts"))
	if sysEntries, sysErr := fs.ReadDir(assets, systemScriptsDir); sysErr == nil {
		for _, sysEntry := range sysEntries {
			if !sysEntry.IsDir() && strings.HasSuffix(sysEntry.Name(), ".py") {
				if sysData, readSysErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(systemScriptsDir, sysEntry.Name()))); readSysErr == nil {
					_ = os.WriteFile(filepath.Join(temporary, sysEntry.Name()), sysData, 0o700)
				}
			}
		}
	}
	var scriptName string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".py") {
			data, readErr := fs.ReadFile(assets, filepath.ToSlash(filepath.Join(directory, entry.Name())))
			if readErr != nil {
				return fail(options, ExitInternal, readErr.Error(), nil)
			}
			path := filepath.Join(temporary, entry.Name())
			if writeErr := os.WriteFile(path, data, 0o700); writeErr != nil {
				return fail(options, ExitInternal, writeErr.Error(), nil)
			}
			if scriptName == "" {
				scriptName = path
			}
		}
	}
	if scriptName == "" {
		return fail(options, ExitInternal, "skill has no deterministic helper", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pythonBin := "python3"
	if venv := os.Getenv("VIRTUAL_ENV"); venv != "" {
		candidate := filepath.Join(venv, "bin", "python3")
		if _, statErr := os.Stat(candidate); statErr == nil {
			pythonBin = candidate
		}
	} else if _, statErr := os.Stat(".venv/bin/python3"); statErr == nil {
		pythonBin = ".venv/bin/python3"
	}
	output, err := runLocalCommand(ctx, pythonBin, scriptName, "--self-test")
	if err != nil {
		return fail(options, ExitFailure, "skill test failed: "+err.Error(), map[string]any{"skill": name})
	}
	return writeResult(options, map[string]any{"schema": 1, "ok": true, "skill": name, "output": redact(string(output))}, name+": self-test passed")
}

func setSkill(skills []string, target string, enabled bool) []string {
	result := make([]string, 0, len(skills)+1)
	for _, skill := range skills {
		if skill != target && !contains(result, skill) {
			result = append(result, skill)
		}
	}
	if enabled {
		result = append(result, target)
	}
	return result
}
