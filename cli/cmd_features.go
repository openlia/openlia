package cli

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func commandFeatures(options Options, args []string, _ fs.FS) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "features requires list, show, status, sync, install, update, import, package, or remove", nil)
	}
	action := args[0]
	rest := append([]string(nil), args[1:]...)

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	ctx, cancel := remoteContext()
	defer cancel()
	dep := newDeployment(config)

	if action == "import" {
		for i, arg := range rest {
			if strings.HasPrefix(arg, "-") {
				continue
			}
			absPath, absErr := filepath.Abs(arg)
			if absErr != nil {
				break
			}
			info, statErr := os.Lstat(absPath)
			if statErr != nil {
				break
			}
			if config.Mode == "local" {
				rest[i] = absPath
			} else {
				uploadSrc := absPath
				if info.IsDir() {
					tmpZip, zipErr := zipDirectoryToTempFile(absPath)
					if zipErr != nil {
						return fail(options, ExitFailure, "package local feature directory: "+zipErr.Error(), nil)
					}
					defer os.Remove(tmpZip)
					uploadSrc = tmpZip
				}
				remoteTmp := dep.rootPath("runtime", "meta", fmt.Sprintf("feature-import-%d.zip", time.Now().UnixNano()))
				if upErr := dep.uploadFile(ctx, uploadSrc, remoteTmp, 0o600); upErr != nil {
					return fail(options, ExitFailure, "upload feature archive: "+upErr.Error(), nil)
				}
				defer func() {
					_ = dep.removeFile(ctx, remoteTmp)
				}()
				rest[i] = remoteTmp
			}
			break
		}
	}

	opArgs := []string{action}
	opArgs = append(opArgs, rest...)
	if !contains(opArgs, "--json") {
		opArgs = append(opArgs, "--json")
	}

	raw, err := dep.operation(ctx, "features", nil, opArgs...)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}

	if action == "install" || action == "import" {
		var parsed struct {
			InstalledSkills []string `json:"installed_skills"`
		}
		if json.Unmarshal(raw, &parsed) == nil && len(parsed.InstalledSkills) > 0 {
			changed := false
			for _, sk := range parsed.InstalledSkills {
				if !contains(config.EnabledSkills, sk) {
					config.EnabledSkills = setSkill(config.EnabledSkills, sk, true)
					changed = true
				}
			}
			if changed {
				_ = saveConfig(config)
			}
		}
	}

	return renderRemote(options, raw, fmt.Sprintf("openlia features %s: completed", strings.TrimSpace(action)))
}

func zipDirectoryToTempFile(srcDir string) (string, error) {
	tmpFile, err := os.CreateTemp("", "openlia-feature-upload-*.zip")
	if err != nil {
		return "", err
	}
	tmpPath := tmpFile.Name()
	zw := zip.NewWriter(tmpFile)
	walkErr := filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && p != srcDir {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlinks are not permitted in feature packages: %s", p)
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		w, err := zw.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	})
	closeZipErr := zw.Close()
	closeFileErr := tmpFile.Close()
	if walkErr != nil || closeZipErr != nil || closeFileErr != nil {
		_ = os.Remove(tmpPath)
		if walkErr != nil {
			return "", walkErr
		}
		if closeZipErr != nil {
			return "", closeZipErr
		}
		return "", closeFileErr
	}
	return tmpPath, nil
}
