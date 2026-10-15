package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
)

func TestPushBackupS3UploadsCiphertextAndMetadata(t *testing.T) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	backupRoot := filepath.Join(root, "backups")
	metaRoot := filepath.Join(root, "meta")
	if err := os.MkdirAll(backupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(metaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	plainPath := filepath.Join(root, "source.tar.gz")
	if err := os.WriteFile(plainPath, []byte("private workspace data"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(backupRoot, "openlia-20261001T042000Z-test.tar.gz.age")
	if err := encryptBackupArchive(plainPath, archive, identity.Recipient().String()); err != nil {
		t.Fatal(err)
	}
	ciphertext, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(ciphertext)
	metadata := backupMetadata{Schema: 2, Kind: "durable", Archive: filepath.Base(archive), SHA256: hex.EncodeToString(digest[:]), Encrypted: true, Secrets: "excluded"}
	metadataData, _ := json.Marshal(metadata)
	if err := AtomicWriteFile(archive+".json", append(metadataData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var methods []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		methods = append(methods, request.Method+" "+request.URL.Path)
		mu.Unlock()
		if request.Method == http.MethodGet && request.URL.Query().Get("list-type") == "2" {
			writer.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(writer, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>openlia-backups</Name><IsTruncated>false</IsTruncated></ListBucketResult>`)
			return
		}
		if request.Method != http.MethodPut {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.Copy(io.Discard, request.Body)
		writer.Header().Set("ETag", `"test-etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	caPath := filepath.Join(root, "s3-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_CA_BUNDLE", caPath)
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	config := Config{ProjectName: "test-project", BackupRoot: backupRoot, InstallRoot: filepath.Join(root, "install"), MetaRoot: metaRoot, BackupRemoteRetentionDays: 30, BackupDestinations: []BackupDestination{{Name: "s3", Type: "s3", Endpoint: server.URL, Bucket: "openlia-backups", Prefix: "unit", Region: "us-east-1", PathStyle: true}}}
	results, err := PushBackup(context.Background(), config, BackupResult{OK: true, Archive: archive}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].OK {
		t.Fatalf("destination results = %+v", results)
	}
	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(methods, "\n")
	prefix := "PUT /openlia-backups/unit/test-project-" + backupNamespace(config) + "/"
	metadataIndex := strings.Index(joined, prefix+filepath.Base(archive)+".json")
	archiveIndex := strings.Index(joined, prefix+filepath.Base(archive))
	listIndex := strings.Index(joined, "GET /openlia-backups")
	if metadataIndex < 0 || archiveIndex < 0 || listIndex < 0 || metadataIndex > archiveIndex || archiveIndex > listIndex {
		t.Fatalf("S3 upload sequence = %s", joined)
	}
}

func TestPushS3BackupPreservesNewestExpiredArchive(t *testing.T) {
	root := t.TempDir()
	backupRoot := filepath.Join(root, "backups")
	metaRoot := filepath.Join(root, "meta")
	if err := os.MkdirAll(backupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(metaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(backupRoot, "openlia-20261001T042000Z-newest.tar.gz.age")
	writeTestDurableArchive(t, archive, []byte("ciphertext"), time.Date(2026, 10, 1, 4, 20, 0, 0, time.UTC))
	config := Config{ProjectName: "test-project", BackupRoot: backupRoot, InstallRoot: filepath.Join(root, "install"), MetaRoot: metaRoot, BackupRemoteRetentionDays: 30}
	prefix := "unit/" + config.ProjectName + "-" + backupNamespace(config) + "/"
	oldName := "openlia-20260901T042000Z-old.tar.gz.age"
	newName := filepath.Base(archive)
	var deleted []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Query().Get("list-type") == "2" {
			writer.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(writer, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>openlia-backups</Name><IsTruncated>false</IsTruncated><Contents><Key>`+prefix+newName+`</Key><LastModified>2026-10-01T04:20:00.000Z</LastModified></Contents><Contents><Key>`+prefix+oldName+`</Key><LastModified>2026-09-01T04:20:00.000Z</LastModified></Contents></ListBucketResult>`)
			return
		}
		if request.Method == http.MethodDelete {
			deleted = append(deleted, request.URL.Path)
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method != http.MethodPut {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.Copy(io.Discard, request.Body)
		writer.Header().Set("ETag", `"test-etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	caPath := filepath.Join(root, "s3-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_CA_BUNDLE", caPath)
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	now := time.Date(2026, 10, 15, 4, 20, 0, 0, time.UTC)
	if err := pushS3BackupAt(context.Background(), config, BackupDestination{Type: "s3", Endpoint: server.URL, Bucket: "openlia-backups", Prefix: "unit", Region: "us-east-1", PathStyle: true}, archive, now); err != nil {
		t.Fatal(err)
	}
	oldKey := "/openlia-backups/" + prefix + oldName
	newKey := "/openlia-backups/" + prefix + newName
	if !containsString(deleted, oldKey) || !containsString(deleted, oldKey+".json") {
		t.Fatalf("expired S3 archive was not fully removed: %v", deleted)
	}
	if containsString(deleted, newKey) || containsString(deleted, newKey+".json") {
		t.Fatalf("newest S3 archive was removed: %v", deleted)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestLoadS3BackupConfigUsesExplicitProfile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials")
	contents := "[reader]\naws_access_key_id = reader-key\naws_secret_access_key = reader-secret\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "ambient-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	config, err := loadS3BackupConfig(context.Background(), BackupDestination{
		Name: "archive", Type: "s3", Region: "us-east-1", CredentialsFile: path, CredentialsProfile: "reader",
	})
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := config.Credentials.Retrieve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if credentials.AccessKeyID != "reader-key" || credentials.SecretAccessKey != "reader-secret" {
		t.Fatalf("credentials = %#v, want reader profile", credentials)
	}
}

func TestRsyncBackupListCommandIsPortableAndFilenameOrdered(t *testing.T) {
	command := rsyncBackupListCommand("/srv/openlia/backups")
	if strings.Contains(command, "-printf") || strings.Contains(command, "-maxdepth") {
		t.Fatalf("rsync list command uses non-portable find options: %s", command)
	}
	for _, required := range []string{"find", "-type f", "basename", "sort -r", "openlia-*.tar.gz.age"} {
		if !strings.Contains(command, required) {
			t.Fatalf("rsync list command missing %q: %s", required, command)
		}
	}
}

func TestBackupRemoteRetentionUsesArchiveAge(t *testing.T) {
	now := time.Date(2026, 10, 1, 4, 20, 0, 0, time.UTC)
	if !backupExpired("openlia-20260831T042000Z-old.tar.gz.age", now, now, 30) {
		t.Fatal("backup older than 30 days was not expired")
	}
	if backupExpired("openlia-20260915T042000Z-new.tar.gz.age", now.Add(-365*24*time.Hour), now, 30) {
		t.Fatal("backup within 30 days was expired")
	}
	if backupExpired("openlia-not-a-timestamp.tar.gz.age", time.Time{}, now, 30) {
		t.Fatal("backup without a usable age was expired")
	}
}

func TestPushBackupRsyncUsesDeploymentNamespaceAndMetadataFirst(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "calls.log")
	sshScript := "#!/bin/sh\nprintf 'ssh %s\\n' \"$*\" >> \"$CALL_LOG\"\ncase \"$*\" in *find*) printf 'openlia-20261001T042000Z-1.tar.gz.age\\nopenlia-20260901T042000Z-1.tar.gz.age\\n' ;; esac\n"
	rsyncScript := "#!/bin/sh\nprintf 'rsync %s\\n' \"$*\" >> \"$CALL_LOG\"\n"
	for name, script := range map[string]string{"ssh": sshScript, "rsync": rsyncScript} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CALL_LOG", logPath)
	backupRoot := filepath.Join(root, "backups")
	metaRoot := filepath.Join(root, "meta")
	if err := os.MkdirAll(backupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(metaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(backupRoot, "openlia-20261001T042000Z-1.tar.gz.age")
	if err := os.WriteFile(archive, []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("ciphertext"))
	metadata, _ := json.Marshal(backupMetadata{Schema: 2, Kind: "durable", Archive: filepath.Base(archive), SHA256: hex.EncodeToString(digest[:]), Encrypted: true})
	if err := os.WriteFile(archive+".json", append(metadata, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{ProjectName: "project", InstallRoot: filepath.Join(root, "install-a"), BackupRoot: backupRoot, MetaRoot: metaRoot, BackupRemoteRetentionDays: 30}
	destination := BackupDestination{Name: "nas", Type: "rsync", RsyncTarget: "backup@nas.example:/srv/openlia"}
	now := time.Date(2026, 10, 15, 4, 20, 0, 0, time.UTC)
	if err := pushRsyncBackupAt(context.Background(), config, destination, archive, 30, now); err != nil {
		t.Fatal(err)
	}
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(log)
	namespace := "project-" + backupNamespace(config)
	if !strings.Contains(text, "/srv/openlia/"+namespace) {
		t.Fatalf("rsync calls lack deployment namespace %q: %s", namespace, text)
	}
	metadataCall := strings.Index(text, filepath.Base(archive)+".json")
	archiveCall := strings.Index(text, filepath.Base(archive))
	if metadataCall < 0 || archiveCall < 0 || metadataCall > archiveCall {
		t.Fatalf("rsync metadata was not uploaded before archive: %s", text)
	}
	oldRemotePath := filepath.Join("/srv/openlia", namespace, "openlia-20260901T042000Z-1.tar.gz.age")
	if !strings.Contains(text, "rm -f -- '"+oldRemotePath+"'") || !strings.Contains(text, "rm -f -- '"+oldRemotePath+".json'") {
		t.Fatalf("expired rsync backup was not fully removed: %s", text)
	}
	newRemotePath := filepath.Join("/srv/openlia", namespace, "openlia-20261001T042000Z-1.tar.gz.age")
	if strings.Contains(text, "rm -f -- '"+newRemotePath+"'") {
		t.Fatalf("newest rsync backup was removed: %s", text)
	}
}
