# ZCode private host contract

## 1. Scope

対象はZCode 3.3.6 / CLI 0.15.2の`app.asar/out/host`に含まれる公式local host serviceです。公開APIではないため、app/CLI/metadata hashが一致するartifactにだけ適用します。

`zcode.cjs app-server --stdio`の直接protocolも調査しましたが、desktopのmodel-provider registryを持たないためproduction経路には採用していません。

## 2. Launch and bridge

1. インストール済みZCodeのElectron executableを`ELECTRON_RUN_AS_NODE=1`で起動
2. `worker_threads.Worker`内で公式`out/host/index.js`をimport
3. Electron utility-processの`process.parentPort` event shapeをNode `MessagePort`へadapter
4. 公式RPC moduleの`zcode-agent` service channelへ接続
5. allowlist済みservice methodだけを内部NDJSON bridgeへ公開

bridgeのsuccess responseは、公式methodが`undefined`を返す場合も`result: null`を明示します。field省略はrequest相関を壊すため禁止です。公式hostのstdout/stderrはadapterのACP stdoutへ流しません。

## 3. Internal envelope

```json
{"id":1,"method":"initialize","params":{"workspacePath":"/workspace"}}
{"id":1,"result":{"available":true}}
{"method":"event","params":{"subscriptionId":"...","event":{"type":"session.event"}}}
```

- UTF-8、1 JSON object/line
- `jsonrpc` fieldなし
- bounded frame size
- request ID correlation、method別timeout
- malformed/unknown responseはfail closed
- late responseはpending requestがなければ無視

## 4. Production method allowlist

| Method | Purpose |
| --- | --- |
| `initialize` | workspaceとprovider readiness |
| `readWorkspaceState` | current modelとcatalog確認 |
| `createSession` | immediate native session作成 |
| `sendPrompt` | prompt acknowledgement |
| `stopSession` | ACP cancel |
| `closeSession` | session cleanup |
| `respondPermission` | native permission response |
| `respondUserInput` | unsupported workflowのdecline |
| `respondProviderRuntimeHeaders` | interactive recovery failure response |
| `disposeWorkspace` | workspace cleanup |
| internal `__subscribe` / `__unsubscribe` | dynamic session event subscription |

このlist以外のprivate methodはRPC経由で呼べません。

## 5. Dynamic event schema

top-level eventは次のdiscriminated unionだけを受理します。

- `snapshot`
- `state.updated`
- `permission.request`
- `userInput.request`
- `userInput.response`
- `providerRuntimeHeaders.request`
- `session.event`

`session.event`は`eventId`、`sessionId`、non-negative `seq`、timestamp、delivery kind、type、payloadを必須とします。MVPで処理するtype:

- `model.streaming`
- `tool.updated`
- `turn.completed`
- `turn.failed`
- state-only event: `session.updated`、`session.titleUpdated`、`streamRecovery.updated`、`turn.started`、permission lifecycle

未知typeを成功終了へ丸めません。

### Model stream kinds

- `text_delta`
- `reasoning_delta`
- `tool_input_start`
- `tool_input_delta`
- `tool_input_end`
- `tool_call`

### Tool update kinds

- `scheduled`
- `started`
- `result`
- `error`
- `batch`

tool inputはdeltaを結合してJSON parseを試し、raw input/outputもACP updateへ保持します。

## 6. Reverse interactions

### Permission

native optionの`optionId`、name、responseを保持し、decisionとpersistent updateの有無からACPのallow/reject once/alwaysへ写像します。ACP clientが返したIDが元optionに存在しなければ拒否します。client cancel/error時はnative denyをexactly onceで返します。

### Structured user input

ACP v1 stable coreに同等の汎用client methodがありません。permission APIや空文字で代替せず、nativeへ`action: decline`を返し、turnを`INTERACTION_UNSUPPORTED`で停止します。

### Provider runtime headers

通常のCoding Plan provider headerは、公式host内のmodel-provider serviceがcredentialとprovider registryからruntime modelを構築するため、adapterがheader値を受け取りません。captcha retry等でhostからinteractive requestが上がった場合、headlessで完了できないため`headersApplied: false`を返し、turnを明示的に停止します。

## 7. Terminal mapping

| Native `resultType` | ACP StopReason |
| --- | --- |
| `success` | `end_turn` |
| `max_tokens`, `token_limit` | `max_tokens` |
| `max_turn_requests`, `request_limit` | `max_turn_requests` |
| `refusal` | `refusal` |
| `cancelled`, `interrupted`, `stopped` | `cancelled` |

未知resultは`end_turn`にせずprotocol errorです。cancel後はnative terminal eventを待ち、30秒で届かなければtimeoutにします。

## 8. Compatibility identity

```text
platform + architecture
+ app version/build where available
+ CLI version
+ zcode.cjs SHA-256
+ .node-bundle-meta.json SHA-256
```

未知identityにunsafe bypassやsystem runtime fallbackはありません。
