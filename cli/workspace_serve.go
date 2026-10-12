package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func commandWorkspaceServe(options Options, args []string, assets fs.FS) int {
	set := newFlagSet("workspace serve")
	port := set.Int("port", 8089, "port to listen on")
	bind := set.String("bind", "127.0.0.1", "interface address to bind to")
	openBrowser := set.Bool("open", false, "open browser on start")
	skillsPath := set.String("skills", "", "path to skills directory")

	var flagArgs []string
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "-") {
			flagArgs = append(flagArgs, arg)
			if (arg == "--port" || arg == "-port" || arg == "--bind" || arg == "-bind" || arg == "--skills" || arg == "-skills") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
				flagArgs = append(flagArgs, args[i])
			}
		} else {
			positional = append(positional, arg)
		}
	}

	if err := set.Parse(flagArgs); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(positional) > 1 {
		return fail(options, ExitUsage, "workspace serve accepts at most one folder path", nil)
	}

	targetPath := "."
	if len(positional) == 1 {
		targetPath = positional[0]
	} else {
		if info, err := os.Stat("workspace"); err == nil && info.IsDir() {
			targetPath = "workspace"
		}
	}

	// Reject zip files with explicit unpack instructions
	if strings.HasSuffix(strings.ToLower(targetPath), ".zip") {
		return fail(options, ExitUsage, fmt.Sprintf("%s is a zip archive. Please unpack it first (e.g. `unzip %s -d ./my-workspace`) and run `openlia workspace serve <unpacked-folder>`", targetPath, targetPath), nil)
	}

	absPath, err := filepath.Abs(targetPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid workspace path: "+err.Error(), nil)
	}
	info, err := os.Stat(absPath)
	if err != nil || !info.IsDir() {
		return fail(options, ExitUsage, fmt.Sprintf("%s is not an existing directory", targetPath), nil)
	}

	workspaceRoot, skillsRoot, memoriesRoot := detectWorkspaceServeRoots(absPath, *skillsPath)

	bunPath, bunErr := findBunExecutable()
	dockerPath, dockerErr := findDockerExecutable()

	if bunErr != nil && dockerErr != nil {
		return fail(options, ExitPrereq, "openlia workspace serve requires Bun (recommended) or Docker to run.\nTo install Bun: curl -fsSL https://bun.sh/install | bash", nil)
	}

	var cmd *exec.Cmd
	uiURL := fmt.Sprintf("http://%s:%d", *bind, *port)

	if bunErr == nil {
		distDir, err := extractWorkspaceUIBundle(assets)
		if err != nil {
			return fail(options, ExitInternal, "prepare workspace-ui bundle: "+err.Error(), nil)
		}

		serverScript := filepath.Join(distDir, "server.js")
		cmd = exec.Command(bunPath, serverScript)
		env := append(os.Environ(),
			"OPENLIA_WORKSPACE_ROOT="+workspaceRoot,
			"OPENLIA_WORKSPACE_UI_BIND="+*bind,
			"OPENLIA_WORKSPACE_UI_PORT="+strconv.Itoa(*port),
			"OPENLIA_WORKSPACE_UI_AUTH_REQUIRED=false",
		)
		if skillsRoot != "" {
			env = append(env, "OPENLIA_SKILLS_ROOT="+skillsRoot)
		}
		if memoriesRoot != "" {
			env = append(env, "OPENLIA_MEMORIES_ROOT="+memoriesRoot)
		}
		cmd.Env = env
		cmd.Dir = distDir
	} else {
		// Fallback to Docker
		dockerArgs := []string{
			"run", "--rm",
			"-p", fmt.Sprintf("%s:%d:%d", *bind, *port, *port),
			"-v", fmt.Sprintf("%s:/workspace", workspaceRoot),
			"-e", fmt.Sprintf("OPENLIA_WORKSPACE_UI_PORT=%d", *port),
			"-e", "OPENLIA_WORKSPACE_UI_AUTH_REQUIRED=false",
		}
		if skillsRoot != "" {
			dockerArgs = append(dockerArgs, "-v", fmt.Sprintf("%s:/skills", skillsRoot), "-e", "OPENLIA_SKILLS_ROOT=/skills")
		}
		if memoriesRoot != "" {
			dockerArgs = append(dockerArgs, "-v", fmt.Sprintf("%s:/memories", memoriesRoot), "-e", "OPENLIA_MEMORIES_ROOT=/memories")
		}
		dockerArgs = append(dockerArgs, "ghcr.io/openlia/workspace-ui:latest")
		cmd = exec.Command(dockerPath, dockerArgs...)
	}

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fail(options, ExitFailure, "start workspace-ui server: "+err.Error(), nil)
	}

	// Trap termination signals to kill the child process cleanly
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigChan)

	// Poll health check in background
	healthURL := fmt.Sprintf("http://%s:%d/health", *bind, *port)
	healthy := false
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		resp, err := http.Get(healthURL)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				healthy = true
				break
			}
		}
	}

	if !healthy {
		_ = cmd.Process.Kill()
		return fail(options, ExitFailure, fmt.Sprintf("workspace-ui failed to start on %s:%d", *bind, *port), nil)
	}

	fmt.Printf("\nWorkspace UI is ready!\n")
	fmt.Printf("  Workspace: %s\n", workspaceRoot)
	if skillsRoot != "" {
		fmt.Printf("  Skills:    %s\n", skillsRoot)
	}
	if memoriesRoot != "" {
		fmt.Printf("  Memories:  %s\n", memoriesRoot)
	}
	fmt.Printf("  URL:       %s\n\n", uiURL)
	fmt.Println("Press Ctrl+C to stop.")

	if *openBrowser {
		openInBrowser(uiURL)
	}

	doneChan := make(chan error, 1)
	go func() {
		doneChan <- cmd.Wait()
	}()

	select {
	case sig := <-sigChan:
		_ = cmd.Process.Signal(sig)
		select {
		case <-doneChan:
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
		}
		fmt.Println("\nWorkspace UI stopped.")
		return ExitOK
	case err := <-doneChan:
		if err != nil {
			return fail(options, ExitFailure, "workspace-ui exited with error: "+err.Error(), nil)
		}
		return ExitOK
	}
}

func detectWorkspaceServeRoots(absPath, configuredSkillsRoot string) (workspaceRoot, skillsRoot, memoriesRoot string) {
	workspaceRoot = absPath
	skillsRoot = configuredSkillsRoot

	// An unpacked export has workspace/, skills/, and optionally memories/ at its root.
	if wsSub, err := os.Stat(filepath.Join(absPath, "workspace")); err == nil && wsSub.IsDir() {
		workspaceRoot = filepath.Join(absPath, "workspace")
		if skillsRoot == "" {
			if skSub, err := os.Stat(filepath.Join(absPath, "skills")); err == nil && skSub.IsDir() {
				skillsRoot = filepath.Join(absPath, "skills")
			}
		}
		if memorySub, err := os.Stat(filepath.Join(absPath, "memories")); err == nil && memorySub.IsDir() {
			memoriesRoot = filepath.Join(absPath, "memories")
		}
		return workspaceRoot, skillsRoot, memoriesRoot
	}

	if skillsRoot == "" {
		siblingSkills := filepath.Join(absPath, "..", "skills")
		if skSub, err := os.Stat(siblingSkills); err == nil && skSub.IsDir() {
			skillsRoot = siblingSkills
		}
	}
	siblingMemories := filepath.Join(absPath, "..", "memories")
	if memorySub, err := os.Stat(siblingMemories); err == nil && memorySub.IsDir() {
		memoriesRoot = siblingMemories
	}
	return workspaceRoot, skillsRoot, memoriesRoot
}

func findBunExecutable() (string, error) {
	if path, err := exec.LookPath("bun"); err == nil {
		return path, nil
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
		filepath.Join(home, ".bun", "bin", "bun"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return c, nil
		}
	}
	return "", errors.New("bun executable not found")
}

func findDockerExecutable() (string, error) {
	return exec.LookPath("docker")
}

func extractWorkspaceUIBundle(assets fs.FS) (string, error) {
	serverBytes, err := fs.ReadFile(assets, "packages/workspace-ui/dist/server.js")
	if err != nil {
		return "", fmt.Errorf("read embedded server.js: %w", err)
	}
	hash := sha256.Sum256(serverBytes)
	hashHex := hex.EncodeToString(hash[:8])

	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	cacheDir := filepath.Join(home, ".openlia", "cache", "workspace-ui", hashHex)

	markerFile := filepath.Join(cacheDir, ".extracted")
	if _, err := os.Stat(markerFile); err == nil {
		return cacheDir, nil
	}

	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return "", fmt.Errorf("create cache dir: %w", err)
	}

	distPrefix := "packages/workspace-ui/dist"
	err = fs.WalkDir(assets, distPrefix, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(distPrefix, path)
		if err != nil || rel == "." {
			return nil
		}
		targetPath := filepath.Join(cacheDir, rel)
		if d.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}
		data, err := fs.ReadFile(assets, path)
		if err != nil {
			return err
		}
		return os.WriteFile(targetPath, data, 0o644)
	})
	if err != nil {
		return "", fmt.Errorf("extract bundle files: %w", err)
	}

	_ = os.WriteFile(markerFile, []byte("ok"), 0o600)
	return cacheDir, nil
}

func openInBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
