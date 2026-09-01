# zcode-acp | Unofficial ZCode ACP Agent

`zcode-acp` is a TypeScript/Bun adapter that exposes an installed ZCode runtime as an ACP v1 stdio agent. It launches ZCode's desktop host service headlessly without copying ZCode credentials or model-provider configuration.

> [!NOTE]
> This project is an unofficial tool and is not officially released, endorsed, or maintained by ZCode or Z.ai.

> [!WARNING]
> zcode-acp uses ZCode’s undocumented headless mode. It does not modify the ZCode application itself or include any implementation that bypasses its communications. However, there is no guarantee that it will not be interpreted as violating the [Terms of Service](https://zcode.z.ai/en/terms)￼. Therefore, please use it at your own risk.

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
- Fail-closed host compatibility checks with separate CLI integrity reporting

`additionalDirectories` is not advertised because the current ZCode host does not provide the required API. `session/list` requires a working directory to match the ZCode host protocol and returns invalid params when it is omitted. If structured input is required but the ACP client does not support form elicitation, the adapter declines the native request and explicitly stops the turn.

## Supported runtime

Only the latest verified ZCode release is supported. Updating the manifest replaces the previous release instead of adding a compatibility branch.

| ZCode | CLI | Host artifact | Host protocol |
| --- | --- | --- | --- |
| 3.10.2 | 0.16.5 | `zcode-host-3.10.2` | `zcode-task-v1` |

The same ZCode version resolves to this single artifact and protocol on macOS, Linux, and Windows. Operating-system-specific code is limited to locating the installed files and requiring the metadata platform to exactly match the running OS and architecture.

Compatibility requires the known metadata semantics, an exact process/metadata platform match, the current app and CLI versions, exact host index and RPC-module hashes, and the required RPC exports. The app build and raw metadata SHA-256 remain diagnostic fields only. A different `zcode.cjs` hash is reported as `cliIntegrity: "modified"` but does not invalidate an otherwise verified host artifact. Run `doctor --json` to inspect `hostArtifact`, `hostProtocol`, and both decisions.

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

Run the Version Bump workflow to create a `release/vX.Y.Z` pull request. Merging the generated PR runs the same verification and build in GitHub Actions, tags the merge as `vX.Y.Z`, and publishes five platform binaries, checksums, and the SBOM to a GitHub Release.

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

On Linux, install the official package normally and sign in to ZCode as the Linux user that will run the adapter. When migrating state from another operating system, credentials can only be decrypted if ZCode's `ZCODE_CREDENTIAL_SECRET` has the same value on the source and destination systems. `zcode-acp` does not copy, decrypt, or transform credentials.

## Privacy and terms

The installed ZCode runtime handles model/provider communication, telemetry, and authentication, so ZCode's privacy policy and terms apply. By default, `zcode-acp` does not persist prompt content, credentials, or provider runtime headers in logs. Review the logging policy of the ACP client you use separately.

ZCode itself is not included in this project or its release artifacts. Users must obtain and install ZCode separately from its official distribution source.

See [`docs/`](docs/README.md) for the design, private-contract notes, and verification evidence.
