package main

import (
	"embed"
	"os"

	"openlia/cli"
	"openlia/internal/releaseinfo"
)

//go:embed LICENSE THIRD_PARTY_NOTICES.md all:docker all:profile all:examples/locho packages/openlia-browser/dist/server.js packages/workspace-ui/dist/server.js all:packages/workspace-ui/dist/client release/manifest.json
var releaseAssets embed.FS

func main() {
	releaseinfo.SetEmbeddedAssets(releaseAssets)
	os.Exit(cli.Run(os.Args[1:], releaseAssets))
}
