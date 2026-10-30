package main

import "testing"

func TestValidateRequiresStableImmutableImagePins(t *testing.T) {
	valid := manifest{
		Schema:    1,
		OpenLia:   "0.1.0",
		Templates: templates{Repository: "https://github.com/openlia/templates.git", Revision: "cb0d6e44ee4ce84ef4c05465af224d2e7b266f01"},
		Remind:    sourcePin{Version: "06.03.06", SourceURL: "https://dianne.skoll.ca/projects/remind/download/remind-06.03.06.tar.gz", SourceSHA256: repeatedHex('e')},
		Hermes: image{
			Image:   "nousresearch/hermes-agent",
			Channel: "stable",
			Tag:     "v0.22.5",
			Digest:  "sha256:" + repeatedHex('a'),
		},
		Locho: locho{
			Version:       "1.3.0",
			LinuxX8664SHA: repeatedHex('c'),
			LinuxARM64SHA: repeatedHex('d'),
		},
	}
	if err := validate(valid); err != nil {
		t.Fatalf("valid stable manifest rejected: %v", err)
	}

	for name, edit := range map[string]func(*manifest){
		"prerelease":         func(value *manifest) { value.Hermes.Tag = "v0.23.0-rc.1" },
		"floating":           func(value *manifest) { value.Hermes.Tag = "latest" },
		"floating templates": func(value *manifest) { value.Templates.Revision = "main" },
		"unpinned Remind":    func(value *manifest) { value.Remind.SourceSHA256 = "" },
		"moving Remind URL": func(value *manifest) {
			value.Remind.SourceURL = "https://dianne.skoll.ca/projects/remind/download/latest.tar.gz"
		},
		"short templates SHA":          func(value *manifest) { value.Templates.Revision = "cb0d6e4" },
		"missing templates repository": func(value *manifest) { value.Templates.Repository = "" },
		"missing channel": func(value *manifest) {
			value.Hermes.Channel = ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			edit(&candidate)
			if err := validate(candidate); err == nil {
				t.Fatal("unstable or incomplete manifest was accepted")
			}
		})
	}
}

func repeatedHex(character byte) string {
	result := make([]byte, 64)
	for index := range result {
		result[index] = character
	}
	return string(result)
}
