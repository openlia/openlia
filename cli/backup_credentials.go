package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"openlia/internal/awscredentials"
)

func resolveBackupCredentialPath(path string) string {
	path = expandTilde(path)
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	absoluteConfig, err := filepath.Abs(configPath())
	if err != nil {
		return filepath.Join(filepath.Dir(configPath()), path)
	}
	return filepath.Join(filepath.Dir(absoluteConfig), path)
}

func validateBackupCredentialReferences(destination BackupDestinationConfig) error {
	for _, reference := range []struct {
		path    string
		label   string
		profile string
	}{
		{destination.ReaderCredentialsFile, "reader_credentials_file", destination.ReaderAWSProfile},
		{destination.WriterCredentialsFile, "writer_credentials_file", destination.WriterAWSProfile},
	} {
		if reference.path != "" {
			resolved := resolveBackupCredentialPath(reference.path)
			if err := validateAbsoluteRoot(resolved, "backup destination "+reference.label); err != nil {
				return err
			}
			if isInsideWorkingTree(resolved) {
				return fmt.Errorf("backup destination %s must be outside the OpenLia checkout", reference.label)
			}
		}
		if reference.profile != "" {
			if err := validateAWSProfile(reference.profile); err != nil {
				return fmt.Errorf("backup destination %s: %w", reference.label, err)
			}
		}
	}
	return nil
}

func validateAWSProfile(profile string) error {
	return awscredentials.ValidateProfile(profile)
}

func loadS3AWSConfig(ctx context.Context, region, credentialsFile, profile, label string) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}
	if credentialsFile != "" {
		resolved := resolveBackupCredentialPath(credentialsFile)
		if err := validateBackupCredentialFile(resolved, label+" credentials file"); err != nil {
			return aws.Config{}, err
		}
		if profile == "" {
			profile = "default"
		}
		values, err := awscredentials.Read(resolved, profile)
		if err != nil {
			return aws.Config{}, fmt.Errorf("load %s credentials: %w", label, err)
		}
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(values.AccessKeyID, values.SecretAccessKey, values.SessionToken)))
	} else if profile != "" {
		options = append(options, awsconfig.WithSharedConfigProfile(profile))
	}
	loaded, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("load %s credentials: %w", label, err)
	}
	return loaded, nil
}

func validateBackupCredentialFile(path, label string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular non-symlink file", label)
	}
	return validateProtectedSourcePath(path, label)
}

func writerCredentialTarget(config Config, name string) string {
	return filepath.Join(config.InstallRoot, "runtime", "backup-credentials", name, "credentials")
}

func syncBackupWriterCredentials(ctx context.Context, deployment deployment, config Config) error {
	type upload struct {
		name      string
		temporary string
		target    string
	}
	var uploads []upload
	defer func() {
		for _, item := range uploads {
			_ = os.Remove(item.temporary)
		}
	}()
	for _, destination := range config.BackupDestinations {
		if destination.Type != "s3" {
			continue
		}
		target := writerCredentialTarget(config, destination.Name)
		if destination.WriterCredentialsFile == "" {
			if err := deployment.removeFile(ctx, target); err != nil {
				return fmt.Errorf("remove stale writer credentials for destination %s: %w", destination.Name, err)
			}
			continue
		}
		source := resolveBackupCredentialPath(destination.WriterCredentialsFile)
		if err := validateBackupCredentialFile(source, "writer credentials for destination "+destination.Name); err != nil {
			return err
		}
		profile := destination.WriterAWSProfile
		if profile == "" {
			profile = "default"
		}
		contents, err := filteredAWSProfile(source, profile)
		if err != nil {
			return fmt.Errorf("prepare writer credentials for destination %s: %w", destination.Name, err)
		}
		temporary, err := os.CreateTemp("", ".openlia-writer-credentials-")
		if err != nil {
			return fmt.Errorf("stage writer credentials for destination %s: %w", destination.Name, err)
		}
		temporaryName := temporary.Name()
		if err := temporary.Chmod(0o600); err == nil {
			_, err = temporary.Write(contents)
		}
		closeErr := temporary.Close()
		if err != nil || closeErr != nil {
			_ = os.Remove(temporaryName)
			if err != nil {
				return fmt.Errorf("stage writer credentials for destination %s: %w", destination.Name, err)
			}
			return fmt.Errorf("stage writer credentials for destination %s: %w", destination.Name, closeErr)
		}
		uploads = append(uploads, upload{name: destination.Name, temporary: temporaryName, target: target})
	}
	for _, item := range uploads {
		if err := deployment.uploadFile(ctx, item.temporary, item.target, 0o600); err != nil {
			return fmt.Errorf("deploy writer credentials for destination %s: %w", item.name, err)
		}
	}
	return nil
}

func filteredAWSProfile(path, profile string) ([]byte, error) {
	if _, err := awscredentials.Read(path, profile); err != nil {
		return nil, fmt.Errorf("profile %q is invalid: %w", profile, err)
	}
	return awscredentials.Filter(path, profile)
}
