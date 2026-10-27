# OpenLia Browser

`openlia-browser` supervises a host-local Playwright MCP process and exposes its
Streamable HTTP endpoint through one loopback listener. It is setup and relay
infrastructure, not an OpenLia browser workflow or crawler.

## Where It Runs

Run the `openlia browser` commands on the operator machine. With `--local`,
the browser service runs on that same machine. With `--target`, the CLI uses
SSH to install and control `openlia-browser` on a separate browser machine.
That machine does not need the full `openlia` CLI or an OpenLia repository
checkout.

```text
Operator machine
  openlia browser
      |
      | SSH
      v
Browser machine
  openlia-browser
  Playwright MCP
  Browser + authenticated profile
```

The remote install uploads the bundled `server.js` and a launcher script. The
browser machine must already provide Node.js with `npx`, the browser
installation, the Playwright extension/token setup, and the configured token
file. `openlia browser install` does not install the operating system, Node.js,
Playwright, or the browser application. The `--root` and
`--extension-token-file` paths refer to paths on the selected browser machine.

Build the Node-compatible bundle from the repository root:

```sh
bun run build:openlia-browser
```

Run it on the browser host:

```sh
OPENLIA_BROWSER_PLAYWRIGHT_TOKEN_FILE="<path_to_extension_token_file>" \
  OPENLIA_BROWSER_MCP_URL=http://127.0.0.1:8931/mcp \
  OPENLIA_BROWSER_PORT=8932 \
  OPENLIA_BROWSER_SUPERVISE_PLAYWRIGHT=1 \
  OPENLIA_BROWSER_PLAYWRIGHT_PORT=8931 \
  OPENLIA_BROWSER_DATA_ROOT="<path_to_openlia_browser_root>/data" \
  node "<path_to_openlia_browser_root>/server.js"
```

The host service should be supervised as the logged-in browser user and bound
to loopback. Export port `8932` through Locho as the `openlia-browser` service;
OpenLia then registers the attached `/mcp` endpoint with Hermes.

The relay supports Streamable HTTP at `/mcp`. Legacy `/sse` and `/messages`
requests return `410 Gone`. The service does not expose OpenLia browser jobs,
provider-specific chat automation, Maps workflows, or result storage.

Hermes receives direct, eager browser tools from an explicit conservative
allowlist. Tool search is disabled for this managed MCP server. The relay
filters `tools/list` and rejects calls outside the allowlist before forwarding;
the default list excludes evaluation/code execution, upload/drop, network
request or inspection, console, and other opt-in or dangerous Playwright tools.
`OPENLIA_BROWSER_ALLOWED_TOOLS` may replace the list for a deliberate deployment
override. Control tools are always available. This relay policy is not a
security boundary for external clients that bypass the relay and reach raw
Playwright directly.

Raw Playwright MCP remains loopback-only. External skills and MCP clients that
are explicitly given access to the attached endpoint control the browser and
are responsible for their own actions, destinations, and compliance.

## Browser Workflow Leases

The attached browser uses one shared authenticated Vivaldi profile. A browser
workflow must reserve the profile before using Playwright. The MCP endpoint
provides these control tools:

- `openlia_browser_session_request`: request a lease without blocking; poll
  status while queued.
- `openlia_browser_session_status`: inspect the current session's queue or lease.
- `openlia_browser_session_touch`: renew the lease during model reasoning or a
  human handoff.
- `openlia_browser_session_release`: release the profile after the workflow.
- `openlia_browser_session_cancel`: cancel a queued request or active lease.

Every downstream Playwright tool requires the active `lease` value. The relay
removes that value before forwarding the request to Playwright. Calls without a
valid current lease are rejected, and queued workflows are granted in FIFO
order. A lease is fenced after expiry or release so stale workflow calls cannot
continue using the shared browser.

Mutating tools (`browser_click`, `browser_type`, `browser_fill_form`,
`browser_press_key`, `browser_select_option`, `browser_handle_dialog`, and
`browser_close`) also require a caller-supplied string `operation_id`. The relay
strips it before forwarding, replays an exact duplicate from a bounded cache
when the first call succeeded, and rejects duplicates after an uncertain error
with a reconcile/no-retry message. The cache is per active lease and is cleared
when the lease is released or expires.

The default lease TTL is five minutes and the maximum task duration is thirty
minutes. Configure them with `OPENLIA_BROWSER_LEASE_TTL_MS`,
`OPENLIA_BROWSER_LEASE_MAX_MS`, and
`OPENLIA_BROWSER_QUEUE_TTL_MS` when the deployment needs different
limits. A lease does not isolate browser state; it provides exclusive workflow
ownership for the shared authenticated profile.

The supported OpenLia lifecycle is configuration-driven:

```sh
# Run these commands on the operator machine.
openlia browser configure \
  --target "user@browser-host" \
  --ssh-port 22 \
  --root "<path_to_openlia_browser_root>" \
  --extension-token-file "<path_to_extension_token_file>"

openlia browser install
openlia browser start
openlia browser status
```

Use `--local` instead of `--target` when the browser host is the same machine.
The service is detached from the invoking shell but does not automatically
restart after a reboot when no operating-system service manager is installed.
The operator config records the browser target, so later `install`, `start`,
`stop`, `restart`, `status`, `logs`, and `uninstall` commands continue to use
the operator machine's SSH connection.

## Connect With Locho

On the browser machine, expose only `openlia-browser` through Locho. Hermes
does not connect to raw Playwright directly:

```toml
[[services]]
name = "openlia-browser"
type = "tcp"
endpoint = "127.0.0.1:8932"
```

Raw Playwright MCP remains private on `127.0.0.1:8931` and must not be shared
with OpenLia.

The resulting path is:

```text
Agent machine: Hermes
        |
        | Locho attachment
        v
Browser machine: openlia-browser:8932
        |
        v
Browser machine: Playwright MCP:8931 -> browser
```

Generate the openlia-browser capability using Locho, then place it in the OpenLia
attachment file:

```toml
host_id = "<locho_host_id>"
listen_host = "0.0.0.0"

[[services]]
capability = "openlia-browser:tcp:<capability>"
listen_port = 8932
```

Map the attached service to its OpenLia role:

```sh
openlia attachments map <host> openlia-browser --role openlia-browser
openlia deploy
```

Keep capability values outside Git and ordinary command arguments. See
[Locho Host Attachments](../../examples/locho/hosts/example/README.md) for capability
creation, protected attachment files, rotation, and service-role mapping.
