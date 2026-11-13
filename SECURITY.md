# Security Policy

OpenLia is a self-hosted deployment and connectivity control plane on top of
[Hermes Agent](https://hermes-agent.nousresearch.com/). This policy covers
vulnerabilities in OpenLia's source code, including its CLI, target operator,
`openlia-browser` Playwright MCP relay, Docker build files, release metadata,
profile seeding, and generated runtime configuration.

## Supported Versions

OpenLia is pre-1.0. Security fixes are prioritized for the latest release and
the default branch. Older releases should be treated as unsupported unless a
release note explicitly says otherwise. Users should update to the latest
release before reporting an issue when possible.

## Reporting a Vulnerability

Report suspected vulnerabilities privately through [GitHub's private
vulnerability reporting form](https://github.com/openlia/openlia/security/advisories/new).
Include:

- A short description of the vulnerability and its potential impact.
- The affected OpenLia version, commit, or release manifest.
- Reproduction steps or a minimal proof of concept.
- Relevant configuration, deployment mode, and host/container details.
- Any proposed mitigation or patch, if available.

Do not include live credentials, personal workspace data, private deployment
identifiers, or unredacted logs. OpenLia's secret-handling rules are documented
in the [Operator Guide](docs/operator-guide.md), and reports should follow the
same redaction standard.

Please do not disclose a suspected vulnerability through a public issue, pull
request, discussion, or social-media post until a coordinated disclosure plan
has been agreed.

If you accidentally expose a credential while investigating, revoke or rotate
it immediately and report only the minimum sanitized details needed to identify
the exposure.

## Scope and Upstream Issues

The following are in scope when the security boundary is controlled by
OpenLia:

- Secret ingestion (`docker/secret-source.sh`), redaction, rotation (`openlia auth`),
  and credential propagation (`runtime/secrets/hermes.env` & `api-server.env`).
- Hermes Dashboard (`:9119` Basic Auth & OIDC) and Hermes API (`:8642` Bearer `API_SERVER_KEY`)
  provisioning and private Locho exposure (`locho-host`).
- `openlia-browser` Playwright MCP tool allowlisting, FIFO lease fencing, and
  mutating-call idempotency.
- CLI validation, remote-operation boundaries, and generated Compose files.
- Backup and restore behavior, including client-side Age encryption and path/archive validation.
- Container isolation, exposed listeners, and generated service configuration.
- Release integrity, provenance, and checksum verification.

Durable backup archives use client-side Age encryption. The target receives
only the public recipient; the private recovery identity stays on the operator
machine and should be backed up separately. S3 and rsync destinations receive
ciphertext. Operation-scoped rollback snapshots are local-only, protected by
filesystem permissions, and are not covered by durable-backup encryption.

Report vulnerabilities in Hermes Agent, Locho, Debian, Docker, Go, Python,
Bun, uv, or another upstream dependency to that project's maintainers as well.
Notify OpenLia through the private GitHub report form when the issue affects
OpenLia's integration, configuration, packaging, or documented security boundary.

The following are not OpenLia vulnerabilities by themselves:

- Provider outages, service abuse, rate limits, or provider-side account
  compromise.
- Vulnerabilities in a user's host, Docker installation, SSH configuration, or
  external service that OpenLia does not control.
- Model behavior or prompt-injection concerns that do not bypass an OpenLia
  security boundary or cause unauthorized access or execution.

## Disclosure Process

OpenLia will work with the reporter to validate the issue, assess affected
versions, prepare a fix or mitigation, and coordinate public disclosure. A
reporter will be credited in release notes or the security advisory when they
request credit and it is safe to do so.

Security fixes should preserve the repository's existing safeguards, including
protected out-of-repository secrets (`0600`), private-by-default listeners,
read-only container filesystems, restricted capabilities, and manual approval
boundaries.

See the [contribution guidelines](CONTRIBUTING.md) for additional requirements.
