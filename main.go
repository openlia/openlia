package main

import (
	"embed"
	"os"

	"openlia/cli"
	"openlia/internal/releaseinfo"
)

//go:embed all:docker all:profile all:examples/locho packages/openlia-browser/dist/server.js release/manifest.json
var releaseAssets embed.FS

func main() {
	releaseinfo.SetEmbeddedAssets(releaseAssets)
	os.Exit(cli.Run(os.Args[1:], releaseAssets))
}
