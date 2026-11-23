package main

import "testing"

func TestValidateRequiresStableImmutableImagePins(t *testing.T) {
	valid := manifest{
		Schema:  1,
		OpenLia: "0.2.0",
		Hermes: image{
			Image:   "nousresearch/hermes-agent",
			Channel: "stable",
			Tag:     "v2026.9.14",
			Digest:  "sha256:" + repeatedHex('a'),
		},
		Locho: locho{
			Version:       "1.3.1",
			LinuxX8664SHA: repeatedHex('c'),
			LinuxARM64SHA: repeatedHex('d'),
		},
		Bun: bun{
			Version:       "1.2.22",
			LinuxX64SHA:   repeatedHex('e'),
			LinuxARM64SHA: repeatedHex('f'),
		},
	}
	if err := validate(valid); err != nil {
		t.Fatalf("valid stable manifest rejected: %v", err)
	}

	for name, edit := range map[string]func(*manifest){
		"prerelease":      func(value *manifest) { value.Hermes.Tag = "v0.23.0-rc.1" },
		"floating":        func(value *manifest) { value.Hermes.Tag = "latest" },
		"missing channel": func(value *manifest) { value.Hermes.Channel = "" },
		"unpinned locho":  func(value *manifest) { value.Locho.LinuxX8664SHA = "" },
		"unpinned bun":    func(value *manifest) { value.Bun.LinuxX64SHA = "" },
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
