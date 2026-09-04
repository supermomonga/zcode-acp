# Implementation status

最終更新: 2026-09-04

設計判断は[ADR一覧](adr/README.md)、current contractと検証手順は[Testing and compatibility](08-testing-compatibility.md)を参照してください。この文書は実装済み機能と実行済み検証だけを記録します。

## Current compatibility target

| Field | Value |
| --- | --- |
| ZCode app | `3.11.2` |
| Observed macOS build | `3.11.2.6792`（diagnostic only） |
| CLI | `0.16.5` |
| Host artifact | `zcode-host-3.11.2` |
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
- macOS/Linux/Windows install layout
- 5 target standalone build
- Linux-only GitHub Actions CI

## Verification completed

2026-09-04にlocal macOS arm64 / ZCode 3.11.2で次を確認しました。

- `bun install --frozen-lockfile`
- `bun run check`: 57 tests pass
- `doctor --json`: `hostArtifact`、`hostProtocol`、`supported`、CLI verified、runtime smoke pass
- `bun run build`
- `bun run release`: macOS arm64/x64、Linux arm64/x64、Windows x64、checksums、SBOM
- official host initialize、workspace state、session create/list/read/resume
- official host経由の実model応答とread tool event
- ACP wireのread toolと`end_turn`
- write permission allow/denyと一時fileの作成/非作成
- streaming中のcancelと`cancelled` terminal
- form elicitationによるstructured input

実model probeは固定fixtureだけを持つ一時workspaceへ隔離しました。リポジトリ内容やcredential内容は表示・コピーせず、一時workspaceはprobe終了時に削除しています。
