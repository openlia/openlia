package operator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type BackupArchiveInfo struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
	CreatedAt string `json:"created_at,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Encrypted bool   `json:"encrypted"`
	SHA256    string `json:"sha256,omitempty"`
}

type BackupStatus struct {
	OK                  bool                      `json:"ok"`
	Schedule            string                    `json:"schedule"`
	ScheduleEnabled     bool                      `json:"schedule_enabled"`
	ScheduleInstalled   bool                      `json:"schedule_installed"`
	Timezone            string                    `json:"timezone"`
	NextRun             string                    `json:"next_run,omitempty"`
	LatestLocal         *BackupArchiveInfo        `json:"latest_local,omitempty"`
	LocalArchives       []BackupArchiveInfo       `json:"local_archives"`
	LocalRetention      int                       `json:"local_retention"`
	LocalMaxBytes       int64                     `json:"local_max_bytes"`
	LocalMaxSize        string                    `json:"local_max_size"`
	LocalBytes          int64                     `json:"local_bytes"`
	LocalUsage          string                    `json:"local_usage"`
	LocalBudgetExceeded bool                      `json:"local_budget_exceeded"`
	RetentionError      string                    `json:"retention_error,omitempty"`
	Destinations        []BackupDestinationResult `json:"destinations"`
	RemoteRetentionDays int                       `json:"remote_retention_days"`
}

func ReadBackupStatus(config Config) (BackupStatus, error) {
	if err := config.ValidatePaths(); err != nil {
		return BackupStatus{}, err
	}
	status := BackupStatus{
		OK:                  true,
		Schedule:            config.BackupSchedule,
		ScheduleEnabled:     config.BackupScheduleEnabled,
		ScheduleInstalled:   backupScheduleInstalled(config),
		Timezone:            config.Timezone,
		LocalArchives:       []BackupArchiveInfo{},
		Destinations:        []BackupDestinationResult{},
		LocalRetention:      config.BackupRetention,
		LocalMaxBytes:       config.BackupMaxBytes,
		RemoteRetentionDays: remoteRetentionDays(config),
	}
	if status.LocalRetention <= 0 {
		status.LocalRetention = defaultBackupRetention
	}
	if status.LocalMaxBytes <= 0 {
		status.LocalMaxBytes = defaultBackupMaxBytes
	}
	if status.Timezone == "" {
		status.Timezone = "Asia/Ho_Chi_Minh"
	}
	if status.ScheduleEnabled {
		if next, err := nextBackupSchedule(config.BackupSchedule, status.Timezone, time.Now()); err == nil {
			status.NextRun = next.Format(time.RFC3339)
		}
	}
	entries, err := os.ReadDir(config.BackupRoot)
	if err != nil && !os.IsNotExist(err) {
		return BackupStatus{}, err
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), "openlia-") && strings.HasSuffix(entry.Name(), ".tar.gz.age.json") {
			archivePath := filepath.Join(config.BackupRoot, strings.TrimSuffix(entry.Name(), ".json"))
			if _, statErr := os.Lstat(archivePath); os.IsNotExist(statErr) {
				if info, infoErr := entry.Info(); infoErr == nil {
					status.LocalBytes += info.Size()
				}
			}
			continue
		}
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "openlia-") || !strings.HasSuffix(entry.Name(), ".tar.gz.age") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		archive := BackupArchiveInfo{Name: entry.Name(), SizeBytes: info.Size(), Encrypted: strings.HasSuffix(entry.Name(), ".age")}
		metadataData, readErr := os.ReadFile(filepath.Join(config.BackupRoot, entry.Name()+".json"))
		if readErr == nil {
			var metadata backupMetadata
			if json.Unmarshal(metadataData, &metadata) == nil {
				archive.CreatedAt = metadata.CreatedAt
				archive.Reason = metadata.Reason
				archive.SHA256 = metadata.SHA256
				archive.Encrypted = metadata.Encrypted
			}
		}
		if archive.CreatedAt == "" {
			archive.CreatedAt = info.ModTime().UTC().Format(time.RFC3339)
		}
		status.LocalArchives = append(status.LocalArchives, archive)
		status.LocalBytes += info.Size()
		if metadataInfo, statErr := os.Stat(filepath.Join(config.BackupRoot, entry.Name()+".json")); statErr == nil {
			status.LocalBytes += metadataInfo.Size()
		}
	}
	status.LocalBudgetExceeded = status.LocalBytes > status.LocalMaxBytes
	status.LocalMaxSize = formatBackupSize(status.LocalMaxBytes)
	status.LocalUsage = formatBackupSize(status.LocalBytes)
	sort.Slice(status.LocalArchives, func(i, j int) bool { return status.LocalArchives[i].CreatedAt > status.LocalArchives[j].CreatedAt })
	if len(status.LocalArchives) > 0 {
		latest := status.LocalArchives[0]
		status.LatestLocal = &latest
	}
	destinationState, err := readBackupDestinationState(config)
	if err != nil {
		return BackupStatus{}, err
	}
	status.Destinations = destinationState.LastCompleted
	retentionState, err := readBackupRetentionState(config)
	if err != nil {
		return BackupStatus{}, err
	}
	status.RetentionError = retentionState.LastError
	return status, nil
}

func latestEncryptedBackup(config Config) (string, error) {
	entries, err := os.ReadDir(config.BackupRoot)
	if err != nil {
		return "", err
	}
	var selected string
	var latest time.Time
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "openlia-") || !strings.HasSuffix(entry.Name(), ".tar.gz.age") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if selected == "" || info.ModTime().After(latest) {
			selected = filepath.Join(config.BackupRoot, entry.Name())
			latest = info.ModTime()
		}
	}
	if selected == "" {
		return "", fmt.Errorf("no encrypted durable backup is available")
	}
	return selected, nil
}

func FormatBackupStatus(status BackupStatus) string {
	state := "enabled"
	if !status.ScheduleEnabled {
		state = "disabled"
	}
	installed := "not installed"
	if status.ScheduleInstalled {
		installed = "installed"
	}
	line := fmt.Sprintf("Backup schedule %s (%s): %s (%s)", state, installed, status.Schedule, status.Timezone)
	line += fmt.Sprintf("\nLocal durable retention: %d archives, %s / %s", status.LocalRetention, formatBackupSize(status.LocalBytes), formatBackupSize(status.LocalMaxBytes))
	line += fmt.Sprintf("\nRemote retention: %d days", status.RemoteRetentionDays)
	if status.LocalBudgetExceeded {
		line += " (budget exceeded; newest verified backup is preserved)"
	}
	if status.RetentionError != "" {
		line += "\nRetention cleanup error: " + status.RetentionError
	}
	if status.NextRun != "" {
		line += "\nNext run: " + status.NextRun
	}
	if status.LatestLocal != nil {
		line += fmt.Sprintf("\nLatest local archive: %s (%s)", status.LatestLocal.Name, status.LatestLocal.CreatedAt)
	} else {
		line += "\nLatest local archive: none"
	}
	for _, destination := range status.Destinations {
		state := "failed"
		if destination.OK {
			state = "uploaded"
		}
		line += fmt.Sprintf("\n%s (%s): %s %s", destination.Name, destination.Type, state, destination.Object)
		if destination.Error != "" {
			line += " — " + destination.Error
		}
	}
	if len(status.Destinations) == 0 {
		line += "\nRemote destinations: no successful upload recorded"
	}
	return line
}

func formatBackupSize(bytes int64) string {
	units := []struct {
		name   string
		factor int64
	}{
		{"TiB", 1 << 40},
		{"GiB", 1 << 30},
		{"MiB", 1 << 20},
		{"KiB", 1 << 10},
	}
	for _, unit := range units {
		if bytes >= unit.factor {
			value := float64(bytes) / float64(unit.factor)
			if bytes%unit.factor == 0 {
				return fmt.Sprintf("%d %s", bytes/unit.factor, unit.name)
			}
			return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", value), "0"), ".") + " " + unit.name
		}
	}
	return fmt.Sprintf("%d B", bytes)
}
