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

func collectBackupWriterCredentialBundle(config Config) ([]bundleFile, []string, error) {
	var files []bundleFile
	var removals []string
	for _, destination := range config.BackupDestinations {
		if destination.Type != "s3" {
			continue
		}
		relTarget := filepath.ToSlash(filepath.Join("runtime", "backup-credentials", destination.Name, "credentials"))
		if destination.WriterCredentialsFile == "" {
			removals = append(removals, relTarget)
			continue
		}
		source := resolveBackupCredentialPath(destination.WriterCredentialsFile)
		if err := validateBackupCredentialFile(source, "writer credentials for destination "+destination.Name); err != nil {
			return nil, nil, err
		}
		profile := destination.WriterAWSProfile
		if profile == "" {
			profile = "default"
		}
		contents, err := filteredAWSProfile(source, profile)
		if err != nil {
			return nil, nil, fmt.Errorf("prepare writer credentials for destination %s: %w", destination.Name, err)
		}
		files = append(files, bundleFile{
			RelativePath: relTarget,
			Data:         contents,
			Mode:         0o600,
		})
	}
	return files, removals, nil
}

func syncBackupWriterCredentials(ctx context.Context, deployment deployment, config Config) error {
	files, removals, err := collectBackupWriterCredentialBundle(config)
	if err != nil {
		return err
	}
	return deployment.syncBundle(ctx, files, removals)
}

func filteredAWSProfile(path, profile string) ([]byte, error) {
	if _, err := awscredentials.Read(path, profile); err != nil {
		return nil, fmt.Errorf("profile %q is invalid: %w", profile, err)
	}
	return awscredentials.Filter(path, profile)
}
