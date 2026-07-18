# 調査結果

## 1. 調査目的

次の二つが、ZCodeのGUIプロセスを起動せずに成立するかを確認しました。

1. ヘッドレスLinux上でZCodeのエージェント機能を利用する
2. その機能をACP Agentとして公開し、任意のACPクライアントから利用する

調査対象は2026-07-19時点のmacOS版ZCode 3.3.6と、公式Linux x64配布物3.3.6です。

## 2. 調査結果の要約

技術的には実現可能性が高いです。ZCode.appにはGUIホストが内部的に利用するCLIバンドルがあり、そのCLIは `app-server --stdio` を提供しています。GUIホスト自身もこのサーバーを子プロセスとして起動し、改行区切りJSONで通信しています。

ただし、このサーバーはACPを直接話しません。JSON-RPCに似たZCode独自RPCであり、GUIホストが担っている逆方向リクエストも存在します。このため、単なるプロセス起動ラッパーではなく、状態・権限・イベントを意味的に変換するアダプターが必要です。

## 3. macOS版の実機確認

### 3.1 バージョンと配置

| 項目 | 値 |
| --- | --- |
| アプリ | `/Applications/ZCode.app` |
| `CFBundleShortVersionString` | `3.3.6` |
| `CFBundleVersion` | `3.3.6.3198` |
| CLI | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` |
| CLI version | `0.15.2` |
| bundle runtime | `electron-node` |
| bundle platform | `darwin-arm64` |

`.node-bundle-meta.json` の内容は次の通りです。

```json
{
  "runtime": "electron-node",
  "entry": "zcode.cjs",
  "platform": "darwin-arm64",
  "source": "apps/zcode-cli/packages/cli/dist/zcode.cjs"
}
```

### 3.2 正しい起動方法

GUIホストの実装は、Electron実行ファイルをNode互換モードにしてCLIを起動します。macOS 3.3.6で確認した等価コマンドは次です。

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  app-server --stdio
```

この方法ではElectronのGUI初期化を行わず、stdioサーバーとして動作します。`zcode-acp` はこの構造を踏襲し、システムの `node` を暗黙の代替ランタイムとして使ってはいけません。同梱CLIが要求するNode/Electron APIとの一致を保証できないためです。

### 3.3 CLIで確認できた機能

CLI 0.15.2は次のコマンドを表示します。

- `app-server`: ZCode Protocol stdio server
- `commands`
- `doctor`
- `login` / `logout`
- `plugins`
- `skills`
- `tui`
- `version`
- `--prompt` / `--print` によるone-shot実行

`doctor --json` は同梱ランタイムで正常に起動し、Node 24.14.0、CLI 0.15.2、process title `zcode-cli` を報告しました。

### 3.4 内蔵TUIは配布物で壊れている

`tui` コマンドを実行すると、次のエラーで終了しました。

```text
Error: Cannot find package '@zcode/tui' imported from .../zcode.cjs
```

macOSアプリ内にもLinux `.deb` 内にも `@zcode/tui` は含まれていません。したがって「既存のZCode TUIをそのまま利用する」案は、3.3.6配布物では成立しません。これはTUIを自作する根拠ではなく、ACP境界を実装して汎用ACPクライアントを利用する根拠です。

### 3.5 one-shotはACPバックエンドに不向き

`--prompt --json` は最終JSONを返すだけで、調査した経路ではツール呼び出しや出力を逐次配信するプロトコルになっていません。また、modeを省略すると `yolo` が既定になるとhelpに明記されています。

一方、`app-server --stdio` はセッション、購読、停止、権限要求を持つため、ACP変換にはこちらが適しています。one-shotをバックエンドのフォールバックにしてはいけません。

### 3.6 helpと実パーサーの不一致

helpに表示される一部のフラグは、無害な呼び出しで実際にはunknown optionとして拒否されました。確認した例は次です。

- `--max-turns`
- `--allowed-tools`
- `--settings`
- `--permission-mode`

private CLIのhelpだけを互換性契約として扱えないことを示しています。`zcode-acp` はアプリ版、CLI版、実際のRPC能力を組み合わせて対応可否を判定する必要があります。

## 4. GUIホスト実装から分かったこと

### 4.1 子プロセスの起動

ZCodeデスクトップホストは、配布環境では概ね次の条件でサーバーを起動します。

- command: `process.execPath`
- args: `[zcode.cjs, "app-server", "--stdio"]`
- env patch: `ELECTRON_RUN_AS_NODE=1`
- cwd: 対象workspace path

開発用の環境変数や別バイナリ探索経路も実装されていますが、外部アダプターがそれらを互換性フォールバックとして模倣する必要はありません。公式インストール先と明示指定先だけを解決する方が安全です。

### 4.2 プロセス管理

デスクトップホストには `ZCodeAgentProcessManager` があり、正規化したworkspace keyごとに一つの子プロセスを管理します。起動中Promiseの共有、再起動世代、終了処理もworkspace単位です。

`zcode-acp` も同じ境界を採用します。異なるworkspaceを同一子プロセスへ混在させません。

### 4.3 stdio framing

GUIホストの `ZCodeStdioTransport` は次のルールです。

- UTF-8
- 1行につき1 JSON object
- 送信時は `JSON.stringify(message) + "\n"`
- CRLFの末尾 `\r` を除去
- 空行は無視
- stdoutのJSON parseまたはschema parse失敗でtransportを閉じる
- stderrは行単位の診断ログ

ACPのstdioも改行区切りJSONですが、外側はJSON-RPC 2.0、内側はZCode独自envelopeです。同じストリームへ混ぜてはいけません。

### 4.4 ZCode Protocol client

GUIホストのクライアント実装から、次を確認しました。

- request: `{ id, method, params, trace? }`
- notification: `{ method, params }`
- success response: `{ id, result }`
- error response: `{ id, error }`
- serverからclientへのrequest: `{ id, method, params }`
- request IDは1から増加する数値
- default request timeoutは30,000ms
- `jsonrpc: "2.0"` フィールドは付けない

この契約はJSON-RPC風ですがACPではありません。

## 5. Linux配布物の確認

公式3.3.6 linux-x64 `.deb` を展開し、次の配置を確認しました。

```text
/opt/ZCode/zcode
/opt/ZCode/resources/glm/zcode.cjs
/opt/ZCode/resources/glm/.node-bundle-meta.json
```

metadataは `runtime: electron-node`、`entry: zcode.cjs`、`platform: linux-x64` です。想定起動形は次です。

```bash
ELECTRON_RUN_AS_NODE=1 \
  /opt/ZCode/zcode \
  /opt/ZCode/resources/glm/zcode.cjs \
  app-server --stdio
```

その後、production実装は直接app-serverではなく公式desktop host serviceを使用する構成へ確定しました。Linux上では公式`.deb`、displayなし、実provider/model/tool/permission/cancelまで実行済みです。

## 6. 認証とユーザー状態

ZCodeは `~/.zcode` 以下にcredential、config、database、logsなどのユーザー状態を持ちます。調査ではキー構造だけを確認し、credential値は読み出していません。

CLIは`login --no-browser`をhelpに表示します。検証時点のendpoint responseはinvalid JSONで、OAuth自体の完走は確認できませんでした。一方、既存stateを公式`ZCODE_CREDENTIAL_SECRET`で復号可能にしたLinux testではprovider/model E2Eを完走しています。`zcode-acp`自身はcredentialをコピー・変換・表示しません。

## 7. 重大な逆方向リクエスト

ZCode app-serverからclientへ、少なくとも次のrequestが送られます。

- `interaction/requestPermission`
- `interaction/requestUserInput`
- `interaction/requestProviderRuntimeHeaders`

前二つはGUIでユーザーに提示される操作です。最後のものは、Z.AI Start PlanまたはBigModel Start/Coding Plan系プロバイダーで、モデルリクエスト直前にruntime headersを更新するために使われます。GUIホストはprovider registryからruntime modelを再構築・適用した後に `headersApplied` を返しています。

したがって、次は不正な実装です。

- 常に許可を返す
- user inputを空文字で返す
- headersを適用せず `headersApplied: true` を返す

これらは一見動作しても、安全性や特定providerの認証を破壊します。

## 8. 残る非MVP検証範囲

- `login --no-browser`のOAuth新規完走
- structured user inputを標準化できる将来ACP contract
- persisted session resume/load
- Linux arm64、macOS x64、Windows
- Toad/acpxのpermission画面・cancel操作など高度なclient固有UX（baseline接続は検証済み）

MVP event、permission、tool、terminal variantは実host traceからschema化済みです。
