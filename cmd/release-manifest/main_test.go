package main

import "testing"

func TestValidateRequiresStableImmutableImagePins(t *testing.T) {
	valid := manifest{
		Schema:  1,
		OpenLia: "0.1.0",
		Hermes: image{
			Image:   "nousresearch/hermes-agent",
			Channel: "stable",
			Tag:     "v0.22.4",
			Digest:  "sha256:" + repeatedHex('a'),
		},
		Locho: locho{
			Version:       "1.3.0-beta.2",
			LinuxX8664SHA: repeatedHex('c'),
			LinuxARM64SHA: repeatedHex('d'),
		},
	}
	if err := validate(valid); err != nil {
		t.Fatalf("valid stable manifest rejected: %v", err)
	}

	for name, edit := range map[string]func(*manifest){
		"prerelease": func(value *manifest) { value.Hermes.Tag = "v0.23.0-rc.1" },
		"floating":   func(value *manifest) { value.Hermes.Tag = "latest" },
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
