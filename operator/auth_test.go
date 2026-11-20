package operator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProviderInventoryIncludesGateway(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hermes.env")
	if err := os.WriteFile(path, []byte("COPILOT_GITHUB_TOKEN=gho_test\nOPENAI_GATEWAY_API_KEY=gateway-test\nOPENAI_API_KEY=official-test\nOPENAI_API_KEY_2=official-test-2\nOPENAI_BASE_URL=https://example.test/v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	openAISlots, copilot, gateway, baseURL, err := providerInventory(path)
	if err != nil {
		t.Fatal(err)
	}
	if openAISlots != 2 || !copilot || !gateway || !baseURL {
		t.Fatalf("inventory = (%d, %t, %t, %t), want (2, true, true, true)", openAISlots, copilot, gateway, baseURL)
	}
}

func TestValidateSecretFileAcceptsGatewayKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hermes.env")
	if err := os.WriteFile(path, []byte("OPENAI_GATEWAY_API_KEY=gateway-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateSecretFile(path); err != nil {
		t.Fatalf("gateway credential was rejected: %v", err)
	}
}

func TestValidateSecretFileAcceptsTelegramDiscordAndSkipsEmptyOptionalKeys(t *testing.T) {
	dir := t.TempDir()

	for _, tc := range []struct {
		name    string
		content string
		wantErr bool
	}{
		{
			name: "telegram-only-with-empty-discord",
			content: "COPILOT_GITHUB_TOKEN=ghu_test\n" +
				"TELEGRAM_BOT_TOKEN=123456:ABCdef\n" +
				"TELEGRAM_ALLOWED_USERS=123456\n" +
				"DISCORD_BOT_TOKEN=\n" +
				"DISCORD_ALLOWED_USERS=\n",
		},
		{
			name: "discord-only-with-empty-telegram",
			content: "COPILOT_GITHUB_TOKEN=ghu_test\n" +
				"TELEGRAM_BOT_TOKEN=\n" +
				"TELEGRAM_ALLOWED_USERS=\n" +
				"DISCORD_BOT_TOKEN=discord_test_bot_token\n" +
				"DISCORD_ALLOWED_USERS=123456789012345678\n" +
				"DISCORD_HOME_CHANNEL=987654321098765432\n" +
				"DISCORD_HOME_CHANNEL_NAME=\"openlia-home\"\n",
		},
		{
			name: "both-telegram-and-discord",
			content: "COPILOT_GITHUB_TOKEN=ghu_test\n" +
				"TELEGRAM_BOT_TOKEN=123456:ABCdef\n" +
				"TELEGRAM_ALLOWED_USERS=123456\n" +
				"TELEGRAM_HOME_CHANNEL=-1001234567890\n" +
				"TELEGRAM_HOME_CHANNEL_NAME=\"OpenLia Home\"\n" +
				"DISCORD_BOT_TOKEN=discord_test_bot_token\n" +
				"DISCORD_ALLOWED_USERS=123456789012345678\n" +
				"DISCORD_HOME_CHANNEL=987654321098765432\n" +
				"DISCORD_HOME_CHANNEL_NAME=\"openlia-home\"\n",
		},
		{
			name:    "all-empty-values-rejected",
			content: "TELEGRAM_BOT_TOKEN=\nDISCORD_BOT_TOKEN=\n",
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".env")
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
			err := validateSecretFile(path)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %s, got nil", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for %s: %v", tc.name, err)
			}
		})
	}
}

func TestHasGatewayProvider(t *testing.T) {
	if !hasGatewayProvider([]FallbackProviderConfig{{Provider: "custom", Model: "gateway", BaseURL: "http://gateway.test/v1"}}) {
		t.Fatal("custom gateway provider was not detected")
	}
	if hasGatewayProvider([]FallbackProviderConfig{{Provider: "openai-api", Model: "official"}}) {
		t.Fatal("official provider was detected as a custom gateway")
	}
}
