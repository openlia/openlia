package cli

import (
	"fmt"
	"io/fs"
	"strings"
)

func commandFeatures(options Options, args []string, _ fs.FS) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "features requires list, show, install, import, package, or remove", nil)
	}
	action := args[0]
	rest := args[1:]

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	opArgs := []string{action}
	opArgs = append(opArgs, rest...)
	if !contains(opArgs, "--json") {
		opArgs = append(opArgs, "--json")
	}

	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := newDeployment(config).operation(ctx, "features", nil, opArgs...)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, fmt.Sprintf("openlia features %s: completed", strings.TrimSpace(action)))
}
