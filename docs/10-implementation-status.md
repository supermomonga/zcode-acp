# Implementation status

Last updated: 2026-07-19

## Implementation status

MVPと、ZCode 3.3.6 hostが提供するpost-MVP surfaceは実装・runtime検証済みです。

- Bun 1.3.13 / TypeScript 7のstandalone build
- `@agentclientprotocol/sdk` 1.2.1、ACP protocol v1
- 公式ZCode desktop host serviceをElectron Node runtime内で起動するbridge
- initialize、workspace state、session create/load/resume/list/close、history replay
- model / thought level / mode config、slash commands、plan、session info、usage
- text / resource link / image / audio / embedded resource prompt
- stdio / HTTP / SSE MCP config転送
- form elicitationによるstructured user input
- ACP terminal auth、`login` / `logout` CLI
- assistant/reasoning stream、tool lifecycle、terminal stateのstrict schema validation
- permission allow/deny/cancelの往復
- provider runtime headers requestの公式host経路
- model generation cancel、`$/cancel_request`、clean shutdown
- notification handler内のnested native requestをdeadlockさせないordered dispatch queue
- stdout isolation、bounded NDJSON、redaction、timeout、late response処理
- exact app/CLI/metadata hash compatibility gate
- macOS arm64/x64、Linux arm64/x64、Windows x64 standalone artifacts、SHA-256、SPDX 2.3 SBOM
- Toad 0.6.20 / acpx 0.12.0のbaseline client interoperability

## Runtime evidence

### macOS arm64

ZCode 3.3.6 build 3.3.6.3198 / CLI 0.15.2で次を実行済みです。

- bundled version / doctor
- ACP wire initialize、session/new、session/prompt
- 実モデルtext stream
- read toolとpermission allow
- write tool allow-once / deny
- model stream cancel
- clean process shutdown

### Linux x64, displayなし

公式`ZCode-3.3.6-linux-x64.deb`をUbuntu 24.04 amd64 containerへ展開し、`DISPLAY`と`WAYLAND_DISPLAY`を空にして次を実行済みです。

- package-declared runtime dependenciesと`libasound2t64`
- bundled version / doctor
- app.asar package identityとartifact hash gate
- ACP wire initialize、session/new、session/prompt
- 実モデルtext stream、read tool、permission
- write tool allow-once / deny
- model stream cancel
- clean process shutdown

macOS stateを一時containerへ移行する検証では、公式credential cipherの`ZCODE_CREDENTIAL_SECRET`を同一値にして復号可能性を保ちました。アダプター自身はcredentialを読み書きしません。

## Remaining external blockers

- `additionalDirectories`: ZCode 3.3.6 hostのcreate/resume APIにfieldがない
- `session/delete`: ZCode 3.3.6 hostに削除APIがない
- cwd省略の`session/list`: ZCode host wrapperがworkspaceを必須とするため、requestをinvalid paramsで拒否する
- ACP v2: 公式schemaが`Unreleased`で、公式TypeScript SDK 1.2.1はprotocol v1のみ
- Linux arm64、macOS x64、Windows runtime support: adapter binaryは生成するが、公式ZCode artifactのhash gateと実機E2Eが未成立
- headless captcha recoveryは応答不能として明示的error。通常のprovider runtime header適用は公式hostが処理
- Debian native OAuth、advanced client UX、performance matrixは外部環境・人手が必要

これらをprivate storage直編集、permission流用、推測したplatform hash、未リリースschemaのstable扱いで埋めません。

adapter releaseへZCode artifactを含めない境界は維持します。

## Added runtime evidence

macOS arm64 / ZCode 3.3.6で以下を追加検証しました。

- session list、resume、load history replay、close
- native setMode / setModel / setThoughtLevel
- session token usage
- MCP stdio configを含むsession create
- turn中のnotification nested request deadlock修正後の実model/tool/permission E2E

## Verification

```bash
bun run check
bun run release
ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 bun run scripts/probe-acp.ts
ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 bun run scripts/probe-safety.ts
./dist/zcode-acp-darwin-arm64 doctor --json
```

Toad 0.6.20では実process log上でinitialize、session/new、text stream、`TOAD_OK`、`end_turn`を確認済みです。acpx 0.12.0ではstrict JSON出力でread tool lifecycle、text stream、`end_turn`を確認済みです。permission画面やcancel操作などclient固有UXの拡張確認は、ACP wire conformanceとは分離したfollow-upです。
