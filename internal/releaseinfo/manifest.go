// Package releaseinfo exposes the component pins shipped by OpenLia.
//
// The canonical values live in release/manifest.json. generated.go is produced
// from that manifest by cmd/release-manifest and must not be edited manually.
//
//go:generate go run ../../cmd/release-manifest --root ../..
package releaseinfo

import "strings"

type ImagePin struct {
	Image   string
	Channel string
	Tag     string
	Digest  string
}

func (pin ImagePin) TagRef() string {
	return pin.Image + ":" + pin.Tag
}

func (pin ImagePin) Ref() string {
	if pin.Digest == "" {
		return pin.TagRef()
	}
	return pin.TagRef() + "@" + pin.Digest
}

type LochoPin struct {
	Version       string
	LinuxX8664SHA string
	LinuxARM64SHA string
}

type Manifest struct {
	Schema    int
	OpenLia   string
	Hermes    ImagePin
	Locho     LochoPin
	Templates TemplatesPin
}

type TemplatesPin struct {
	Repository string
	Revision   string
}

func InternalImage(name, version string) string {
	return name + ":v" + strings.TrimPrefix(version, "v")
}
