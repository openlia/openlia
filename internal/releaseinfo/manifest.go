package releaseinfo

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"sync"
)

type Manifest struct {
	Schema  int      `json:"schema"`
	OpenLia string   `json:"openlia"`
	Hermes  ImagePin `json:"hermes"`
	Locho   LochoPin `json:"locho"`
	Bun     BunPin   `json:"bun"`
}

type ImagePin struct {
	Image   string `json:"image"`
	Channel string `json:"channel"`
	Tag     string `json:"tag"`
	Digest  string `json:"digest"`
}

type LochoPin struct {
	Version       string `json:"version"`
	LinuxX8664SHA string `json:"linux_x86_64_sha256"`
	LinuxARM64SHA string `json:"linux_aarch64_sha256"`
}

type BunPin struct {
	Version       string `json:"version"`
	LinuxX64SHA   string `json:"linux_x64_sha256"`
	LinuxARM64SHA string `json:"linux_aarch64_sha256"`
}

var (
	manifestOnce sync.Once
	manifestData Manifest
	manifestErr  error
)

func SetEmbeddedAssets(assets fs.FS) {
	manifestOnce.Do(func() {
		raw, err := fs.ReadFile(assets, "release/manifest.json")
		if err != nil {
			manifestErr = fmt.Errorf("read embedded release/manifest.json: %w", err)
			return
		}
		if err := json.Unmarshal(raw, &manifestData); err != nil {
			manifestErr = fmt.Errorf("parse embedded release/manifest.json: %w", err)
			return
		}
		Default = manifestData
	})
}

func Pinned() Manifest {
	if manifestErr != nil {
		panic(manifestErr)
	}
	if manifestData.OpenLia == "" {
		return Default
	}
	return manifestData
}

func InternalImage(name, version string) string {
	return name + ":" + version
}
