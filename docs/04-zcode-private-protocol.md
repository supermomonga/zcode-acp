# ZCode private host contract

## 1. Scope

対象はcompatibility manifestに登録されたZCode 3.3.6 / CLI 0.15.2、ZCode 3.8.1 / CLI 0.16.3、およびZCode 3.9.1 / CLI 0.16.5の`app.asar/out/host`に含まれる公式local host serviceです。公開APIではないため、app/build/platform、CLI version、metadata hashとhost hash/exportが一致するartifactにだけ適用します。CLI本文のSHA-256はintegrity診断であり、host contractの選択条件ではありません。

`zcode.cjs app-server --stdio`の直接protocolも調査しましたが、desktopのmodel-provider registryを持たないためproduction経路には採用していません。

## 2. Launch and bridge

1. インストール済みZCodeのElectron executableを`ELECTRON_RUN_AS_NODE=1`で起動
2. `worker_threads.Worker`内で公式`out/host/index.js`をimport
3. Electron utility-processの`process.parentPort` event shapeをNode `MessagePort`へadapter
4. manifestのhost contract descriptorが指定するRPC module/exportとservice channelへ接続
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

## 4. Versioned host contracts

| Semantic operation | 3.3.6 contract | 3.8.1 / 3.9.1 contract |
| --- | --- | --- |
| service channel | `zcode-agent` | common: `zcode-agent`; task interaction: `zcode-task` |
| cancel | `stopSession({sessionId})` | `stopGeneration({taskId})` |
| structured input | `respondUserInput({sessionId, requestId, response})` | `respondElicitation({taskId, requestId, action, content})` |
| permission | `respondPermission({sessionId, requestId, response})` | `respondPermission({taskId, requestId, optionId})` |

`initialize`、`readWorkspaceState`、`createSession`、`sendPrompt`、`closeSession`、`respondProviderRuntimeHeaders`、`disposeWorkspace`とsubscriptionは共通agent serviceで扱います。このlistおよびdescriptorで宣言したtask操作以外のprivate methodはRPC経由で呼べません。

3.8.1 descriptorはhost index `out/host/index.js`とRPC module `out/host/chunk-LVLFJXEE.js`、3.9.1 descriptorは同じhost indexとRPC module `out/host/chunk-KGXW6KHC.js`を固定し、artifactごとのSHA-256と必要な`g/i/j` exportをworker起動前に検証します。pathがinstall rootを逸脱する場合もfail closedです。

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
- `progress`
- `result`
- `error`
- `batch`

tool inputはdeltaを結合してJSON parseを試し、raw input/outputもACP updateへ保持します。
`progress`は実行中状態への非終端更新として扱い、ACP `tool_call_update`の
`status: "in_progress"`へ変換します。`stdoutTail`、`stderrTail`、PID、経過時間、
バイト数は途中時点のZCode固有メタデータであり、ACPの`content`、`rawOutput`、`_meta`には転送しません。

## 6. Reverse interactions

### Permission

native optionの`optionId`、name、意味上のresponseを保持し、decisionとpersistent updateの有無からACPのallow/reject once/alwaysへ写像します。ACP clientが返したIDが元optionに存在しなければ拒否します。client cancel/error/disconnect時は実在するdeny optionを選び、3.3.6にはresponse、3.8.1および3.9.1にはoption IDをexactly onceで返します。

### Structured user input

form elicitation capabilityを持つACP clientには複数質問・multiple selectを保持して`elicitation/create`へ変換します。3.8.1および3.9.1ではclient応答を`action`と`content`へ平坦化し、`respondElicitation`へ渡します。form非対応clientではpermission APIや空文字で代替せず、実際のdecline応答を返してturnを`INTERACTION_UNSUPPORTED`で停止します。

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
+ `zcode.cjs version`のCLI version
+ zcode.cjs SHA-256（公式artifactとの差分診断）
+ .node-bundle-meta.json SHA-256
+ host index SHA-256
+ host RPC module path + SHA-256 + required exports
```

未知identityにunsafe bypassやsystem runtime fallbackはありません。
