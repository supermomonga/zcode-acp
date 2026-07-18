# Implementation plan

> 2026-07-19: Phase 0-5のうちZCode 3.3.6 hostが提供するsurfaceは実装済みです。本文は実装順序とrelease時の再検証checklistとして保持します。現在値と外部blockerは[Implementation status](10-implementation-status.md)を参照してください。

## 1. 推奨技術選定

### 1.1 Language/runtime

第一候補はTypeScriptです。

理由:

- 公式 `@agentclientprotocol/sdk` を直接利用できる
- ZCode側のJSON schema validationをZod等で記述しやすい
- `agentclientprotocol/codex-acp` が同種のapp-server adapter構造を実証している
- Node/Bun系でstdio、child process、NDJSON処理の実装実績が豊富
- Bun compile等でLinux単一binary配布を検討できる

これは実装開始時の推奨であり、SDKのcurrent APIとlicenseを再確認して最終決定します。ZCode CLIをシステムNodeで実行することとは別問題です。adapter自身がNode/Bunで動いても、ZCode childは必ず公式Electron runtimeで起動します。

### 1.2 Dependencies

候補:

- `@agentclientprotocol/sdk`: ACP wire types/server
- `zod`: private ZCode protocol runtime validation
- `vscode-jsonrpc` または公式SDK内transport: ACP JSON-RPC
- `vitest`: unit/integration tests
- `esbuild` / Bun build: distribution

implementation sessionでexact versionを選び、lockfileを作成します。不要な汎用agent harnessを追加せず、`zcode-acp` の役割をprotocol adapterに限定します。

## 2. Phase 0: Contract spike

目的は、production architectureを作る前にprivate contractの三大blockerを解消することです。

### Work items

1. isolated workspace/user stateを用意
2. app-server frame recorderを作成
3. `workspace/readState`、`session/create`、`session/subscribe`、`session/send`、`session/stop` のexact schema取得
4. assistant/tool/plan/usage/terminal eventのgolden traces
5. permission allow/deny/cancel trace
6. user-input request trace
7. provider runtime headers requestとGUI適用経路のtrace
8. Linux x64でversion/doctor/app-server smoke
9. Toad/acpxのACP v1対応method/capability確認

### Exit criteria

- MVP native typesを推測なしで定義できる
- `session/create -> subscribe -> send -> terminal` のvertical sliceが実モデルで通る
- provider headersを正しく適用できる設計が一つ確定
- user-inputを標準ACPへ写像できるか、非対応とするかを決定
- LinuxのGUI依存有無が実証される

blockerが解けない場合、production codeへ進まず、ZCode側に必要な正式headless APIを要求する判断を行います。

## 3. Phase 1: Protocol foundations

### Deliverables

- repository/package setup
- ACP v1 stdio transport
- private NDJSON transport
- ZCode runtime discovery
- compatibility manifest
- typed error model
- stderr logger/redaction
- fake ZCode server test harness

### Tests

- JSON framing/partial chunks/CRLF
- request correlation/timeout/late response
- stdout contamination
- unsupported version/hash
- fixed spawn args/env/cwd

### Exit criteria

fake serverを相手にinitializeとsession/newまでwire testが通り、実ZCodeを起動せずfailure pathを再現できること。

## 4. Phase 2: Session and streaming MVP

### Deliverables

- workspace process manager
- session coordinator
- `initialize`
- `session/new`
- `session/prompt`
- `session/update` mapper
- native subscription/replay boundary
- normal StopReason mapping
- clean shutdown

### Tests

- same/different workspace concurrency
- subscribe-before-send
- text stream ordering
- tool create/update
- unknown event fail-closed
- child crash/no automatic resend

### Exit criteria

macOS development environmentで、text promptとread-only toolをACP test clientから完走できること。

## 5. Phase 3: Interaction safety

### Deliverables

- permission bridge
- `session/cancel`
- pending reverse request lifecycle
- provider runtime headers bridge
- unauthenticated/user-action errors
- user-input方針の実装

### Tests

- permission allow/deny/cancel/timeout/disconnect
- cancel during stream/tool/permission
- duplicate/late callback response
- headers applied/failed/redacted
- no implicit yolo

### Exit criteria

write toolをallow/denyでき、cancelがsemantic cancelledで終わり、対象providerのheaders適用が実証されること。

## 6. Phase 4: Linux release and interoperability

### Deliverables

- Linux x64 runtime discovery
- standalone adapter artifact
- `doctor` / `doctor --json`
- `version`
- installation and client registration docs
- checksums/SBOM

### Tests

- Ubuntu/Debian no-display E2E
- no-browser login
- Toad UX
- acpx automation
- process tree cleanup
- secret/stdout audit

### Exit criteria

[Product specification](02-product-spec.md#11-mvp受け入れ条件) の全条件を満たし、Linux x64 + ZCode 3.3.6/CLI 0.15.2をsupport matrixへ追加できること。

## 7. Phase 5: Persistence and configuration

2026-07-19に実施済みです。ただしnative APIが存在しない項目は下記のとおり除外しています。

### Session persistence

- `session/load`
- `session/resume`
- history replay
- list/close/deleteのうちnative semanticsが一致するもの

### Configuration

- model
- thought level
- mode
- usage
- slash commands

### Rich content and MCP

- images/resources
- ACP-provided MCP servers
- additional directories（ZCode 3.3.6 host未対応）

session deleteとcwdなしの全workspace listもZCode 3.3.6 host未対応です。private storageを直接編集する代替実装は追加しません。

各機能は個別capabilityとE2E testを持ちます。「methodが存在する」だけでまとめてadvertiseしません。

## 8. Phase 6: ACP v2

ACP v2 protocol surfaceがstableになり、対象clientsとSDKが追随した後に開始します。2026-07-19時点で公式v2 schemaは`Unreleased`で、TypeScript SDK releaseもv1のため、このpreconditionは未成立です。

- v1/v2のwire typesとhandlersを分離
- initialize negotiationで一接続一versionを選択
- shared domain eventsから各version updateへ変換
- v2 state_update/upsert/message ID lifecycleを実装
- v1 compatibility suiteを維持

v2追加を理由にv1を削除しません。削除は別の明示的なbreaking release判断とします。

## 9. Suggested repository layout

実装時の候補構造です。

```text
src/
  cli/
  acp/
    v1/
    transport/
  domain/
    session-coordinator.ts
    events.ts
  zcode/
    discovery/
    host/bridge.ts
    protocol/
    transport.ts
  diagnostics/
tests/
  fixtures/
    zcode-3.3.6-cli-0.15.2/
  unit/
  integration/
  e2e/
docs/
```

private protocol typesにversionを含むdirectory/namespaceを用意し、将来版で既存schemaを上書きしないようにします。

## 10. Decision log to create during implementation

実装sessionでは次のADRを作成します。

1. TypeScript/runtime/build distribution
2. ACP SDK/schema exact version
3. native session ID exposureまたはadapter mapping
4. provider runtime headers bridge
5. user-input bridge/non-support decision
6. environment inheritance policy
7. supported ZCode hash/version policy
8. mode/config option mapping

判断根拠と実トレースを残し、コードだけに暗黙知を閉じ込めません。

## 11. Initial issue breakdown

### P0

- Capture ZCode 3.3.6 protocol fixtures
- Prove provider runtime headers flow
- Decide user-input interoperability
- Prove Linux app-server without display
- Pin ACP v1 SDK/schema

### P1

- Runtime discovery and doctor
- Private protocol transport/client
- ACP v1 server transport
- Workspace process manager
- Session new/prompt/update
- Permission and cancellation
- Linux packaging and client E2E

### P2

- Session load/resume/list/close
- Model/mode/thought config
- MCP and rich content
- More platforms

### P3

- ACP v2
- Optional extensions

## 12. Definition of done

各featureは次を満たしてdoneです。

- public behaviorがdocsに記載
- native behaviorの実機evidenceがある
- ACP capabilityと実装が一致
- positive/negative/cancel testがある
- secret/log/stdout review済み
- supported platformでE2E pass
- compatibility matrix更新済み

「コンパイルできる」「fake serverで通る」「macOSだけで通る」のいずれか単独ではdoneにしません。
