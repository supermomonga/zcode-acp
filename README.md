# zcode-acp

`zcode-acp` is a TypeScript/Bun adapter that exposes an installed ZCode runtime as an ACP v1 stdio agent. It launches ZCode's desktop host service headlessly without copying ZCode credentials or model-provider configuration.

## Capabilities

- ACP v1 `initialize`, `authenticate`, and `logout`
- `session/new`, `load`, `resume`, `list`, `close`, `prompt`, and `cancel`
- Text, resource-link, image, audio, and embedded-resource prompts
- Assistant and reasoning streams
- Per-session model, thought-level, and mode configuration
- Slash commands, plans, session information, and context-usage updates
- Native forwarding of stdio, HTTP, and SSE MCP server configuration
- Structured user input through ACP form elicitation
- Tool-call creation, progress, completion, and failure notifications
- One-to-one mapping of native permissions to ACP allow-once, allow-always, deny-once, and deny-always options
- Session cancellation and granular `$/cancel_request` handling
- Use of ZCode's provider registry, credentials, and runtime-header path
- Single-file executables for macOS arm64/x64, Linux arm64/x64, and Windows x64
- Fail-closed compatibility checks using exact artifact hashes

`additionalDirectories` and session deletion are not advertised because the ZCode 3.3.6 host does not provide the required APIs. `session/list` requires a working directory to match the ZCode host contract and returns invalid params when it is omitted. If structured input is required but the ACP client does not support form elicitation, the adapter declines the native request and explicitly stops the turn.

## Supported runtime

| Platform | ZCode | CLI | Status |
| --- | --- | --- | --- |
| macOS arm64 | 3.3.6 build 3.3.6.3198 | 0.15.2 | Supported |
| Linux x64 | 3.3.6-3198 official `.deb` | 0.15.2 | Supported |

Artifacts with the same version string but a different hash are rejected. Run `doctor --json` to inspect the detected versions, hashes, and compatibility decision.

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run build
```

Generate release artifacts, SHA-256 checksums, and an SPDX 2.3 SBOM:

```bash
bun run release
```

Pushing a `v*` tag runs the same verification and build in GitHub Actions, then publishes five platform binaries, checksums, and the SBOM to a GitHub Release.

## CLI

```bash
./dist/zcode-acp doctor --json
./dist/zcode-acp version
./dist/zcode-acp login
./dist/zcode-acp logout
./dist/zcode-acp
```

Without a subcommand, stdout is reserved for ACP JSON-RPC frames and diagnostics are written to stderr. Use `--zcode-install /absolute/path` or `ZCODE_ACP_ZCODE_INSTALL` to select a non-standard installation directory.

## ACP clients

ACP v1 initialization, session creation, text streaming, and `end_turn` have been tested with Toad 0.6.20 and acpx 0.12.0.

Toad:

```bash
uvx --from batrachian-toad toad acp \
  "/absolute/path/to/zcode-acp-darwin-arm64" \
  --project-dir "/absolute/path/to/project"
```

acpx:

```bash
npx acpx@latest \
  --cwd "/absolute/path/to/project" \
  --agent "/absolute/path/to/zcode-acp-darwin-arm64" \
  sessions new

npx acpx@latest \
  --cwd "/absolute/path/to/project" \
  --agent "/absolute/path/to/zcode-acp-darwin-arm64" \
  "Reply with exactly OK"
```

On Linux, install the official `.deb` normally and sign in to ZCode as the Linux user that will run the adapter. When migrating state from another operating system, credentials can only be decrypted if ZCode's `ZCODE_CREDENTIAL_SECRET` has the same value on the source and destination systems. `zcode-acp` does not copy, decrypt, or transform credentials.

## Privacy and terms

The installed ZCode runtime handles model/provider communication, telemetry, and authentication, so ZCode's privacy policy and terms apply. By default, `zcode-acp` does not persist prompt content, credentials, or provider runtime headers in logs. Review the logging policy of the ACP client you use separately.

ZCode itself is not included in this project or its release artifacts. Users must obtain and install ZCode separately from its official distribution source.

See [`docs/`](docs/README.md) for the design, private-contract notes, and verification evidence.
