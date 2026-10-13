package operator

import (
	"context"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"openlia/internal/awscredentials"
)

func validateAWSProfile(profile string) error {
	return awscredentials.ValidateProfile(profile)
}

func loadS3BackupConfig(ctx context.Context, destination BackupDestination) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(destination.Region)}
	if destination.CredentialsFile != "" {
		info, err := os.Lstat(destination.CredentialsFile)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
			return aws.Config{}, fmt.Errorf("S3 credentials file is missing, not regular, or not protected with mode 0600")
		}
		profile := destination.CredentialsProfile
		if profile == "" {
			profile = "default"
		}
		values, err := awscredentials.Read(destination.CredentialsFile, profile)
		if err != nil {
			return aws.Config{}, fmt.Errorf("load target S3 credentials: %w", err)
		}
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(values.AccessKeyID, values.SecretAccessKey, values.SessionToken)))
	} else if destination.CredentialsProfile != "" {
		options = append(options, awsconfig.WithSharedConfigProfile(destination.CredentialsProfile))
	}
	loaded, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("load target S3 credentials: %w", err)
	}
	return loaded, nil
}
