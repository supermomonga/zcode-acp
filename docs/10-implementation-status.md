# Implementation status

最終更新: 2026-09-01

## Current compatibility target

| Field | Value |
| --- | --- |
| ZCode app | `3.10.2` |
| Observed macOS build | `3.10.2.6414`（diagnostic only） |
| CLI | `0.16.5` |
| Host artifact | `zcode-host-3.10.2` |
| Host protocol | `zcode-task-v1` |
| Status | `supported` |

過去releaseは対応対象に含めません。同一versionのmacOS、Linux、Windows identityは単一artifact/protocolへ解決されます。

## Implemented

- semantic metadata validationとprocess platform完全一致
- app/CLI current version validation
- exact host index/RPC hashとrequired export validation
- CLI integrityの`verified | modified`診断
- diagnostic-onlyなapp buildとmetadata raw SHA-256
- current task protocolのcancel、structured input、permission変換
- ACP v1 session、stream、tool、permission、input、cancel、config、MCP surface
- Paseo向けOpenCode互換facade
- macOS/Linux/Windows install layout
- 5 target standalone build
- Linux-only GitHub Actions CI

## Verification completed

2026-09-01にlocal macOS arm64 / ZCode 3.10.2で次を確認しました。

- `bun install --frozen-lockfile`
- `bun run check`: 52 tests pass
- `doctor --json`: `hostArtifact`、`hostProtocol`、`supported`、CLI verified、runtime smoke pass
- `bun run build`
- `bun run release`: macOS arm64/x64、Linux arm64/x64、Windows x64、checksums、SBOM
- official host initialize、workspace state、session create/list/read/resume/close
- official host経由の実model応答とread tool event
- ACP wireのread toolと`end_turn`
- write permission allow/denyと一時fileの作成/非作成
- streaming中のcancelと`cancelled` terminal
- form elicitationによるstructured input
- Paseo/OpenCode facadeのmodel catalog、SSE、read tool、history resume/delete

実model probeは固定fixtureだけを持つ一時workspaceへ隔離しました。リポジトリ内容やcredential内容は表示・コピーせず、一時workspaceはprobe終了時に削除しています。
