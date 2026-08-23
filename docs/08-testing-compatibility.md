# Testing and compatibility

## 1. 検証方針

build successだけでは、private protocol adapterの正しさを保証できません。検証は次の三層をすべて必要とします。

1. 公開ACP contractへの適合
2. ZCode private contractへの適合
3. 実際のZCode runtime、provider、ACP clientを通したend-to-end behavior

課金やworkspace変更を伴うtestは明示的なE2E suiteへ分離し、通常unit testで実行しません。

## 2. 現在のcompatibility snapshot

| Component | Version/platform | Evidence | Status |
| --- | --- | --- | --- |
| ZCode app | 3.8.1 build 3.8.1.5310 / macOS arm64 | exact host hashes、official/modified CLI integrity、実model/tool/permission/input/cancel/resume E2E | supported |
| ZCode CLI | 0.16.3 / darwin-arm64 | bundled runtime version/doctor、host E2E | supported |
| ZCode app | 3.3.6 build 3.3.6.3198 / macOS arm64 | metadata/hash、official host、実model/tool/cancel E2E | supported |
| ZCode CLI | 0.15.2 / darwin-arm64 | bundled runtime version/doctor、host E2E | supported |
| ZCode Linux package | 3.3.6-3198 / linux-x64 | official `.deb`、displayなしUbuntu container E2E | supported |
| ZCode official host | 3.3.6 / darwin-arm64 + linux-x64 | provider registry、stream、permission、cancel | supported subset |
| ACP | protocol v1、schema-v1.19.0 | SDK wire test、real process probe | MVP pass |
| ACP v2 | protocol v2 draft | stable baseline schemaと公式migration文書 | unsupported |
| Toad | 0.6.20 / macOS arm64 | 実process log、initialize/session/new/prompt stream/end_turn | baseline pass |
| acpx | 0.12.0 / macOS arm64 | strict JSON output、initialize/session/new/tool/text/end_turn | baseline pass |
| Paseo OpenCode facade | Paseo `c60fa098a` / `@opencode-ai/sdk` 1.14.46 | standalone binary + real SDK/model、GLM-only catalog、SSE/tool/history/restart-resume/delete | pass |
| Paseo daemon | 0.5.1 / macOS arm64 | isolated daemon、provider models、agent create/read、same-agent send/resume、stop/cancel | pass |

support matrixはapp/build/platform、`zcode.cjs version`が返すCLI version、metadata hashでhost contract候補を選び、host index/host RPC module SHA-256とrequired exportを完全一致で検証します。3.8.1の公式CLI SHA-256 `9318f60f…e4274`はintegrity比較値であり、異なる場合は`modified`と診断します。metadataは`3cb76cfe…4660`、host indexは`d0f82503…9c3f`、host RPCは`46959e5a…9fc3`です。

## 3. Test layers

### 3.1 Schema and mapper unit tests

対象:

- ACP initialize/session requests
- private RPC envelope
- event-to-update mapping
- StopReason mapping
- permission option mapping
- error redaction
- path canonicalization
- version/hash support matrix

必須negative cases:

- unknown event type
- missing requiredfield
- duplicate tool call ID with incompatible shape
- late native response
- permission option ID mismatch
- unknown terminal reason
- malformed JSON/UTF-8
- stdout nonprotocol text

### 3.2 Fake ZCode server integration tests

実ZCodeを起動せず、固定NDJSONを話すfake childで次を検証します。

- child spawn args/env/cwd
- request ID correlation
- subscribe-before-send ordering
- backlog/live deduplication
- streaming update order
- reverse request round trip
- native timeout
- child crash
- graceful stdin closeとforce cleanup

fakeが実装都合の理想的protocolにならないよう、実ZCodeから得たredacted golden tracesを入力fixtureにします。

### 3.3 ACP conformance integration tests

official SDK/client harnessを使い、次をwire levelで検証します。

- initialize前method拒否
- protocol version negotiation
- capability honesty
- session/new validation
- v1 prompt response timing
- update schemas
- permission client request
- cancellation semantics
- JSON-RPC errors
- stdout isolation

### 3.4 Real ZCode smoke tests

課金なし・read-only:

- version
- doctor
- official host spawn
- initialize/readWorkspaceState
- create/close session
- clean shutdown

状態変更を伴う可能性があるmethodは専用temporary user/homeとworkspaceで実行します。

### 3.5 Paid/stateful E2E tests

明示的credentialとbudgetを使い、次を確認します。

- session create
- simple text response
- multi-chunk streaming
- read-only tool + permission
- write tool allow/deny
- user-input requestの明示的unsupported処理
- cancel during model streaming
- cancel during tool execution
- provider runtime headers対象provider
- persisted session resume/load

workspaceは使い捨てGit repoとし、実行前後のdiffをassertします。

### 3.6 Generic client tests

| Client class | Candidate | Purpose |
| --- | --- | --- |
| Human TUI | Toad | 実際のpermission、stream、cancel UX |
| Headless/script | acpx | deterministic scenario、CI、JSON output |
| Desktop agent client | Paseo | OpenCode-compatible provider、structured question、permission、resume |

### 3.7 Paseo OpenCode compatibility tests

`tests/paseo/opencode-server.test.ts`はPaseoが固定している`@opencode-ai/sdk` 1.14.46を実クライアントとして使用します。対象はprovider/model、dynamic mode、session create/status/messages/delete、SSE stream、tool lifecycleとusage、MCP、複数question、multi-select、重複header、カンマを含むlabel、native permission、reply/reject/disconnectのexactly-once完了、cancel、persisted session resume/history、unsupported rewindです。

この契約はversion negotiationで推測せず、SDK versionとPaseo commitを固定します。Paseo更新時はこのtestを新しいSDKへ更新して通過させてからcompatibility targetを変更します。
| IDE | Zedなど | 標準ACP interoperabilityの追加確認 |

client固有設定やextensionを使わずにbaseline scenarioを通すtestと、optional capability testを分けます。

2026-07-19のbaseline結果:

- Toad 0.6.20: 外部commandとしてrelease binaryを起動し、`initialize`、`session/new`、複数の`agent_message_chunk`、`end_turn`を確認。最終textは`TOAD_OK`
- acpx 0.12.0: strict JSON modeで同じrelease binaryを起動し、read toolのcreated/completed、複数text chunk、`end_turn`を確認

permission選択画面やcancel操作のclient固有UXは、adapterのwire/runtime検証とは分離して継続確認します。

## 4. Golden trace acquisition

ZCode private event schemaの正本を作る手順:

1. isolated test user/homeとtemporary workspaceを用意
2. 対象ZCode app/build/CLI versionとCLI integrity/metadata/host index/host RPC hashを記録
3. app-serverとの送受信をframe単位でcapture
4. session ID、trace ID、path、prompt、token、headerをdeterministic placeholderへ置換
5. request/response/event orderingを保持
6. fixtureをschema validation
7. 同じscenarioをfake server testへ追加

redaction前のtraceをrepositoryへ保存しません。header requestを含むtraceは値をcaptureしないinstrumentationを優先します。

必要scenario:

- empty/simple assistant response
- plan + thought + assistant text
- tool start/progress/completion
- permission allow/deny/cancel
- native error
- user input
- provider headers
- session stop
- reconnect/resume
- subscription snapshot/backlog/live boundary

## 5. Contract tests by lifecycle

### Initialization

- v1 requestにv1 response
- v2-only clientにはv1を選択してclient判断を促す、または規定error
- unimplemented capabilityがない
- agentInfoが正しい

### Session creation

- relative cwdを拒否
- nonexistent/non-directory cwdを拒否
- same workspaceのconcurrent createでchild spawnが一つ
- different workspaceでchildを分離
- native failure時にACP sessionを発行しない

### Prompt

- subscribe完了前にsendしない
- event順を維持
- prompt responseはterminal state後
- unknown terminal reasonをend_turnにしない
- second active promptをreject

### Permission

- 全optionのround trip
- allow/deny/cancel
- client disconnect
- timeout
- duplicate response
- response after session cancel

### Cancel

- notificationにJSON-RPC responseを返さない
- native stopは一回
- in-flight updatesをterminal boundaryまで処理
- original prompt responseはcancelled

### Shutdown

- stdin EOF
- SIGTERM
- child ignoring stdin close
- child descendants cleanup
- no orphan process

## 6. Linux headless matrix

最低matrix:

| OS image | Arch | Display | Install | Auth | Prompt | Permission | Cancel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ubuntu 24.04 | x64 | none | 3.3.6-3198 `.deb` | migrated test state with official cipher secret | pass | allow/deny pass | pass |
| Debian stable | x64 | none | `.deb` | native user login | not run | not run | not run |

Linux arm64はartifact内容と実行環境を確認後に行を追加します。未実行セルをpassとして埋めません。

## 7. Performance and resource tests

- first child startup latency
- warm session/new latency
- update throughputとbackpressure
- large tool output時のmemory
- multiple workspace childのmemory
- idle child cleanup policy
- prompt cancel latency
- child shutdown latency

performance optimizationでevent orderingやschema validationを省略しません。

## 8. Update procedure for a new ZCode version

1. 公式artifactを取得しsignature/checksumを記録
2. app/build/platform、CLI version/integrity、metadata/host hashを採取
3. launch smoke
4. protocol method inventoryをdiff
5. schema/golden tracesをdiff
6. reverse request variantsをdiff
7. full fake/conformance suite
8. real macOS smoke
9. Linux headless E2E
10. client matrix
11. support matrixとdocsを更新

help outputだけが変わらなくてもprivate schemaが変わる可能性があります。version stringだけで互換判定しません。

## 9. Release gates

### Gate A: Contract known

- MVP native request/result/event schemaがfixture化済み
- reverse request全variantを確認
- provider headers bridge設計が実証済み

### Gate B: Adapter correct

- unit/fake/conformance test pass
- negative/failure path pass
- no unsupported capability advertisement

### Gate C: Runtime works

- macOS development E2E pass
- Linux x64 no-display E2E pass
- auth/model/tool/cancel pass

### Gate D: Safe distribution

- real ACP wire harness pass
- secret redaction/stdout isolation pass
- SHA-256 checksumsとSPDX SBOM生成

ZCode 3.3.6はmacOS arm64とLinux x64、ZCode 3.8.1 build 3.8.1.5310はmacOS arm64でGate A-Dを通過済みです。加えてToad 0.6.20とacpx 0.12.0のbaseline接続を通過済みです。permission画面やcancel操作などclient固有UXの追加検証結果を、adapter capabilityへ混ぜません。

## 10. Evidence record format

互換性結果には次を残します。

```yaml
tested_at: 2026-07-19T00:00:00Z
platform: linux-x64
os_image: ubuntu-<version>
zcode_app_version: 3.3.6
zcode_build: 3.3.6.3198
zcode_cli_version: 0.15.2
zcode_cli_sha256: <sha256>
zcode_acp_version: <version>
acp_protocol: 1
acp_schema: 1.19.0
client: <name/version>
scenarios:
  initialize: pass
  session_new: pass
  prompt_stream: pass
  permission: pass
  cancel: pass
  provider_headers: pass
```

secret、session transcript、credential pathはrecordへ含めません。
