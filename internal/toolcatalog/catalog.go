package toolcatalog

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

const DefaultDebianSnapshot = "20260801T000000Z"
const RequiredIngestionRevision = "ingestion-v1"

// ManagedHermesImage returns a project-specific image reference so separate
// deployments on one Docker host cannot overwrite each other's tool images.
func ManagedHermesImage(project, baseTag, baseDigest, debianSnapshot string) string {
	identity := strings.Join([]string{project, baseTag, baseDigest, debianSnapshot, RequiredIngestionRevision}, "\x00")
	digest := sha256.Sum256([]byte(identity))
	displayProject := project
	if len(displayProject) > 80 {
		displayProject = displayProject[:80]
	}
	return fmt.Sprintf("openlia-hermes:%s-tools-%x", displayProject, digest[:8])
}
