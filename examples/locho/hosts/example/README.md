# Locho Host Attachments

Copy `attachments.toml.example` to the runtime path on the selected deployment:

```text
<install-root>/runtime/locho/<host-name>/attachments.toml
```

The runtime file must contain the host ID, `listen_host = "0.0.0.0"`, and one
or more `[[services]]` entries. Replace capability placeholders out of band;
never commit them or pass them as ordinary command arguments. Use
`openlia attachments rotate <host> --source /path/to/attachments.toml` to
validate and replace one host without restarting unrelated sidecars.

HTTP services may set `http_timeout_secs` per service, from 1 to 300 seconds.
The default is 60 seconds. TCP services must not set this field.

For private relay infrastructure, configure a protected relay TOML in the
OpenLia operator config:

```toml
[locho]
relay_config = "~/.config/openlia/locho/relay.toml"
```

With Locho 1.3.1 or later, an authenticated relay can use an inline token:

```toml
[[relays]]
url = "https://relay.example.com"
token = "<relay access token>"
```

Keep the TOML outside the OpenLia checkout and out of source control. On Unix,
keep both the operator and client copies at mode `0600` and transfer them over a
trusted channel. OpenLia bind-mounts the TOML read-only into Locho containers.
With an inline-only config, omit `relay_secrets` and run the standalone client
without setting a token environment variable:

```sh
locho attach --config openlia-attachments.toml --relay-config ~/.config/openlia/locho/relay.toml
```

To keep the token separate, use `token_env = "LOCHO_RELAY_TOKEN"` instead of
`token` on that relay entry. Set `relay_secrets` to a mode-`0600` copy of
[`relay.env.example`](../../relay.env.example) with the variable populated; on
the standalone client, provide the same variable through its environment.
See [`relay.toml.example`](../../relay.toml.example) for the full TOML template.

Run `openlia` on the operator machine. For a remote deployment, the
`--source` path is read from the operator machine and the validated attachment
file is uploaded to the selected agent runtime. The remote agent machine does
not need the full `openlia` CLI.

## Service Mapping & Roles

Discovered services can be assigned roles using `openlia attachments map`:

```bash
openlia attachments list
openlia attachments map <host> <service> --role openlia-browser
openlia attachments map <host> <service> --role openai-gateway
```

Or directly in the operator machine's `~/.config/openlia/config.toml` using one
`[[services]]` block per host:

```toml
[[services]]
name = "<host>"
"<service>" = "openlia-browser"

[[services]]
name = "<another-host>"
"<service>" = "openai-gateway"
```

Supported roles:

- `openlia-browser`: Host-local Playwright supervisor and MCP proxy. Wires `OPENLIA_BROWSER_MCP_URL`, registers the attached proxy's Streamable HTTP `/mcp` endpoint directly with Hermes, and disables Hermes' native browser toolset. Legacy `/sse` and `/messages` requests are rejected.
- `openai-gateway`: OpenAI-compatible local model/gateway (e.g. Ollama, vLLM, GenAI). Declare its explicit `/v1` URL in the matching `fallback_providers` entry.

All attached services are automatically published into the runtime service registry at `/opt/data/services.json` for Hermes and associated tools.
