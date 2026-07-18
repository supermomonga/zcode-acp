# References and evidence

## 1. 調査日時と対象

調査日: 2026-07-19

### Installed macOS artifacts

```text
/Applications/ZCode.app
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
/Applications/ZCode.app/Contents/Resources/glm/.node-bundle-meta.json
/Applications/ZCode.app/Contents/Resources/app.asar
```

確認値:

```text
ZCode app: 3.3.6
ZCode build: 3.3.6.3198
ZCode CLI: 0.15.2
platform: darwin-arm64
runtime: electron-node
```

SHA-256:

```text
a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239  zcode.cjs
3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660  .node-bundle-meta.json
a8c2ad8bef5edaaf9f62c77dec1ae772ffa31feefd01a8b83039446ac03776db  app.asar
```

hashは調査artifactを識別するためのもので、配布元の署名検証やlicense確認の代替ではありません。

### Linux artifact

調査したURL:

- [ZCode 3.3.6 linux-x64 `.deb`](https://cdn-zcode.z.ai/zcode/electron/releases/3.3.6/linux-x64/ZCode-3.3.6-linux-x64.deb)

SHA-256:

```text
47dded48f48dc5db2e1f5a554fea8e5bb1f183fa2d263697e2f4837a985d95ff  ZCode-3.3.6-linux-x64.deb
```

展開して`/opt/ZCode/zcode`、`app.asar`、`zcode.cjs`、metadataを確認し、Ubuntu 24.04 amd64のdisplayなしcontainerで実行しました。

## 2. ACP official sources

### Protocol and schema

- [Agent Client Protocol official repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v1 cancellation](https://agentclientprotocol.com/protocol/v1/cancellation)
- [ACP v1 authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [schema-v1.19.0 release](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.19.0)
- [ACP v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration)

調査時点のofficial repository release一覧ではprotocol/SDK系release `v1.4.0` とschema release `schema-v1.19.0` が確認できました。v2 migration guideはstable v2 baselineを説明する一方、v2 protocol surface全体をdraftと明記し、v1/v2併存とfeature flagを推奨しています。

### Structural reference

- [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)

調査時点のpackage versionは1.1.4で、TypeScript、Apache-2.0です。Codex app-server client、ACP session connection、approval/event/tool mapper、testsという構造を参考にできます。ZCodeのprivate semanticsを代替するものではありません。

## 3. ACP clients considered

- [batrachianai/toad](https://github.com/batrachianai/toad): generic ACP TUI。0.6.20でbaseline E2Eを実施
- [openclaw/acpx](https://github.com/openclaw/acpx): headless/scriptable ACP client。0.12.0のstrict JSON modeでbaseline E2Eを実施

両clientともrelease binaryを外部ACP agentとして起動し、initialize、session/new、prompt stream、`end_turn`を確認しました。acpxではread tool lifecycleも確認しています。

## 4. Reproduction commands

以下は秘密情報やモデル呼び出しを伴わない確認に使用したコマンドの要約です。

### App version

```bash
plutil -extract CFBundleShortVersionString raw -o - \
  /Applications/ZCode.app/Contents/Info.plist

plutil -extract CFBundleVersion raw -o - \
  /Applications/ZCode.app/Contents/Info.plist
```

### Bundled CLI version

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  version
```

### Doctor

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  doctor --json
```

doctor出力を保存・掲載する場合は、home path、credential状態、環境情報のredactionを先に行います。

### App-server launch shape

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  app-server --stdio
```

### Hashes

```bash
shasum -a 256 \
  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs \
  /Applications/ZCode.app/Contents/Resources/glm/.node-bundle-meta.json \
  /Applications/ZCode.app/Contents/Resources/app.asar
```

## 5. Source inspection notes

Electron runtimeのNode modeで `fs.readFileSync` を使うと、Electron ASAR filesystemを通じて次を読めました。

```text
/Applications/ZCode.app/Contents/Resources/app.asar/out/host/index.js
```

ここから確認した事項:

- `process.execPath` + `zcode.cjs app-server --stdio`
- `ELECTRON_RUN_AS_NODE=1`
- workspace-keyed process manager
- private request clientと30,000ms default timeout
- NDJSON framingとparse failure behavior
- provider runtime headersをruntime modelへ適用するGUI host flow

`zcode.cjs` のprotocol schema tableからmethod inventoryとreverse request名を確認しました。minified bundleのsymbol名を公開contractとは扱わず、実装Phase 0で実serverのgolden traceを取得します。

## 6. Evidence limitations

macOS/Linux runtime、実model、tool permission、provider headers経路、cancel、generic ACP client接続に加え、session load/resume/list/close、config、usageを実測済みです。未実施なのは、新規OAuth login flowの完走、form elicitationのclient固有UX、support matrix外platform、client固有の全UX操作です。

## 7. Refresh policy

新しいreleaseへ更新する際に次を再確認します。

1. 最新ZCode app/CLI versionと配布構造
2. ACP official release、v2 stability status
3. `@agentclientprotocol/sdk` current API/version
4. codex-acpの現行architecture
5. Toad/acpxのsupported ACP versionと設定方法
6. ZCode license/terms

更新結果がこの文書と異なる場合、先にcompatibility snapshotと仕様を更新してから実装します。
