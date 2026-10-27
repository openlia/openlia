package main

import (
	"embed"
	"io/fs"
	"os"

	"openlia/cli"
)

// The release payload is embedded so the operator can bootstrap a target
// without cloning this repository on the operator or remote machine.
//
//go:embed all:docker all:profile all:workspace-template all:features all:examples/locho all:release all:packages/openlia-browser/dist all:packages/workspace-ui/dist
var releaseAssets embed.FS

func main() {
	assets, err := fs.Sub(releaseAssets, ".")
	if err != nil {
		os.Exit(cli.ExitInternal)
	}
	os.Exit(cli.Run(os.Args[1:], assets))
}
