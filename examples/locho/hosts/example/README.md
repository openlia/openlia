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

For private relay infrastructure, configure `relay_config` and, if needed,
`relay_secrets` in a `[locho]` section of the OpenLia operator config. OpenLia
bind-mounts the relay TOML into Locho containers and injects dotenv values as
environment variables. The same relay configuration must be available to the
client, and `token_env` values must be exported in the client environment:
See `examples/locho/relay.toml.example` and `examples/locho/relay.env.example` for templates.

```sh
export LOCHO_RELAY_TOKEN="..."
locho attach --config openlia-attachments.toml --relay-config relay.toml
```

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
