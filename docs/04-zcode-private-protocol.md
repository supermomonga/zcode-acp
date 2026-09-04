# ZCode private host protocol

この文書は現在のversion固有contractを記録します。hostの起動方式は[ADR 0003](adr/0003-zcodegong-shi-hosutosabisuwotong-kun-electronrantaimudeqi-dong-suru.md)、互換性方針は[ADR 0005](adr/0005-zui-xin-nojian-zheng-ji-mizcode-1baziyondakewoyan-mi-nisapotosuru.md)、interaction境界は[ADR 0007](adr/0007-neiteibunoquan-xian-ru-li-zi-ge-qing-bao-nojing-jie-wobao-chi-suru.md)を参照してください。

## 1. Scope

対象はZCode 3.11.2 / CLI 0.16.5の`app.asar/out/host`に含まれる公式local host serviceです。これは公開APIではないため、現在のmanifestが示すartifact fingerprintと完全一致する場合だけ起動します。

`zcode.cjs app-server --stdio`の直接protocolではdesktopのmodel-provider registryを利用できないことが実測されています。production経路の選定理由はADR 0003に記録しています。

## 2. Artifactとprotocolの分離

`HostArtifactDescriptor`は実ファイルの同一性を表します。

- ID: `zcode-host-3.11.2`
- app version: `3.11.2`
- CLI version: `0.16.5`
- host index: `out/host/index.js`
- RPC module: `out/host/chunk-KGXW6KHC.js`
- required exports: `g`、`i`、`j`

`HostProtocolDescriptor`は意味変換を表します。

- ID: `zcode-task-v1`
- common service: `zcode-agent`
- task service: `zcode-task`
- cancel: `stopGeneration({taskId})`
- structured input: `respondElicitation({taskId, requestId, action, content})`
- permission: `respondPermission({taskId, requestId, optionId})`

artifactの更新とprotocol意味論の更新を別々のdescriptorで表します。artifactからprotocol IDへの参照が一致しない場合も起動しません。

## 3. Launch and bridge

1. インストール済みZCodeのElectron executableを`ELECTRON_RUN_AS_NODE=1`で起動
2. `worker_threads.Worker`内で公式`out/host/index.js`をimport
3. Electron utility-processの`process.parentPort` event shapeをNode `MessagePort`へ変換
4. descriptorが指定するRPC module/exportとservice channelへ接続
5. allowlist済みservice methodだけを内部NDJSON bridgeへ公開

bridgeのsuccess responseは、公式methodが`undefined`を返す場合も`result: null`を明示します。公式hostのstdout/stderrはACP stdoutへ流しません。

## 4. Internal envelope

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

## 5. Dynamic event schema

top-level eventは`snapshot`、`state.updated`、`permission.request`、`userInput.request`、`userInput.response`、`providerRuntimeHeaders.request`、`session.event`だけを受理します。

`session.event`は`eventId`、`sessionId`、non-negative `seq`、timestamp、delivery kind、type、payloadを必須とします。model stream、tool update、turn terminal、session stateの未知typeを成功終了へ丸めません。

## 6. Reverse interactions

### Permission

native optionの`optionId`、name、意味を保持してACPの選択肢へ一対一で写像します。ACP clientが返したIDが元optionに存在しなければ拒否します。cancel/error/disconnect時は実在するdeny optionを選び、option IDをexactly onceで返します。

### Structured user input

form elicitation capabilityを持つACP clientには複数質問・multiple selectを保持して`elicitation/create`へ変換します。client応答は`action`と`content`へ平坦化して`respondElicitation`へ渡します。form非対応clientでは実際のdecline応答を返し、turnを`INTERACTION_UNSUPPORTED`で停止します。

### Provider runtime headers

通常のprovider headerは公式host内のmodel-provider serviceがcredentialとregistryから構築するため、adapterは値を受け取りません。hostからinteractive requestが来た場合は`headersApplied: false`を返し、turnを明示的に停止します。

## 7. Compatibility identity

互換性判定は次の順序で行います。

1. metadataの`runtime`、`entry`、`source`を既知値と照合
2. metadata platformを実行中のOS/architectureと完全一致で検証
3. app versionとCLI versionを現在のmanifestと照合
4. host index、RPC module、required exportsを完全一致で検証
5. CLI SHA-256の差分を`modified`と診断

app buildとmetadata raw SHA-256は診断表示だけで、互換性条件ではありません。CLIが`modified`でもhost artifactが一致すれば起動を許可します。

同一app versionのCLIとhost内容は全OSで同一と扱います。OS別manifest entryは作らず、OS差はinstall layoutとmetadata platform一致に限定します。未知OSはlayout解決時に拒否します。

## 8. Current fingerprints

```text
CLI SHA-256:        e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8
host index SHA-256: 30911a90dadc5c384959d00d95ccc70c8cf38c74a9cb99c3168b0897d046d215
RPC module SHA-256: e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31
```

未知identityにunsafe bypass、旧response形式、system runtime fallbackはありません。
