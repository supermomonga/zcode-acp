# 製品仕様

## 1. 製品名

`zcode-acp`

## 2. 問題定義

ZCodeのエージェント機能はデスクトップGUIから利用できる一方、GUIを持たないLinux環境や、ACP対応TUI/IDEから利用するための公開入口がありません。同梱CLIのTUIはZCode 3.3.6配布物では依存パッケージ欠落により起動しません。

`zcode-acp`は、インストール済みZCodeの公式local host serviceをheadlessで起動し、そのservice contractを標準ACPへ変換することでこの問題を解決します。

## 3. 目標

### 3.1 MVPの目標

- GUIセッションやdisplay serverなしで起動できる
- ACP v1対応クライアントから新規ZCodeセッションを作成できる
- text prompt、streaming response、tool statusをACPへ配信できる
- permission requestをクライアントへ転送し、選択結果をZCodeへ返せる
- promptをキャンセルできる
- 子プロセス終了、protocol破損、非対応版を明確なエラーとして扱える
- Linux x64でend-to-endの実モデル応答を確認できる
- ToadなどのTUIとacpxなどのheadless clientの双方で接続できる

### 3.2 将来目標

- persisted sessionのload/resume
- model、thought level、modeのACP config options化
- MCP server設定の受け渡し
- image/resource prompt
- slash commandsとusage情報
- Linux arm64、macOS x64、Windows
- ACP v2のversion negotiation対応

## 4. 非目標

- ZCodeそのものの再実装
- TUI、IDE、Web UIの実装
- Piまたは特定のagent harnessへの依存
- ZCodeのGUI自動操作
- `zcode.cjs` やZCodeアプリの再配布
- private RPCを公開安定APIとして一般化すること
- ZCode plugin/skill/marketplace管理APIのMVP公開
- ACPとZCodeの意味が異なる機能を、名前だけ合わせて疑似対応すること
- 未知のバージョンを推測やsilent fallbackで動作させること

## 5. 想定ユーザー

### 5.1 ヘッドレスLinux利用者

SSH先、サーバー、コンテナなどで汎用ACP TUIを起動し、ZCodeを利用します。GUI依存を持ち込まないこと、OAuth URLを別ブラウザーで開けること、stdoutがprotocolとして安定していることが重要です。

### 5.2 ACPクライアント開発者

標準ACP v1 Agentとしてプロセスを登録します。ZCode private RPCを知る必要はありません。

### 5.3 zcode-acp保守者

新しいZCode配布物が出た際にcontract snapshotと互換性テストを更新します。ZCode内部の変更をクライアントへ漏らさないことが責務です。

## 6. CLI UX

### 6.1 Agent起動

```bash
zcode-acp
```

引数なしの起動は、stdin/stdout上でACP v1 Agentを開始します。プロトコルメッセージ以外をstdoutへ出してはいけません。

### 6.2 診断

```bash
zcode-acp doctor
zcode-acp doctor --json
```

診断は少なくとも次を表示します。

- OSとarchitecture
- 解決したZCode install root、runtime、CLI entry
- ZCode app version、CLI version、bundle metadata
- 対応表との一致
- `doctor` subprocess smokeの成否
- credentialの存在有無だけ。値やtokenは表示しない
- display serverなしで起動可能か
- provider runtime headers bridgeの対応状態

### 6.3 バージョン

```bash
zcode-acp version
```

`zcode-acp` 自身、対応ACP major、検出済みならZCode/CLI versionを出力します。

### 6.4 ZCode install rootの解決

実装時の優先順位は次とします。

1. `--zcode-install <absolute-path>` の明示指定
2. `ZCODE_ACP_ZCODE_INSTALL` の明示指定
3. OSごとの公式既定インストール先

指定先はinstall rootとして検証し、runtime、`zcode.cjs`、metadataの組を一括で解決します。個々のファイルを別々の場所から寄せ集めません。PATH上の `node` や偶然見つかった `zcode.cjs` へのfallbackは禁止します。

## 7. 対応プラットフォーム

| Platform | MVP位置付け | 現在の根拠 |
| --- | --- | --- |
| Linux x64 | release target | 3.3.6-3198 `.deb`、displayなし実model/tool/permission/cancel pass |
| macOS arm64 | release target | 3.3.6 build 3.3.6.3198、同E2E pass |
| Linux arm64 | 次フェーズ | 公式配布はあるが、本調査で内容・実行を未確認 |
| macOS x64 | 次フェーズ | 未確認 |
| Windows | 非MVP | 未確認 |

「配布物が存在する」ことと「zcode-acpが対応済み」であることを区別し、compatibility matrixを通過した組だけをsupportedと表記します。

## 8. 機能要件

### FR-1: ACP initialization

- stdio上のJSON-RPC 2.0を受け付ける
- MVPでは `protocolVersion: 1` のみ選択する
- 実装していないcapabilityをadvertiseしない
- clientがv1を受理できない場合は明示的に終了する

### FR-2: Runtime discovery

- ZCodeのapp version、CLI version、metadataを検証する
- 対応表にない組み合わせは起動しない
- executableとCLI entryが同一install root由来であることを検証する

### FR-3: Session lifecycle

- ACP `session/new` のabsolute `cwd` ごとにworkspaceを確立する
- ACP connectionごとに公式ZCode host workerを一つ管理する
- ZCode session IDとcwdのbindingを保持する
- 同一sessionで同時に複数のactive promptを受理しない

### FR-4: Prompt and updates

- text、resource link、image、audio、embedded resourceをcapabilityどおり受理する
- ZCode eventの順序を保ってACP `session/update` を送る
- 認識できないeventを別の意味へ丸めない
- terminal stateを確認してからACP `session/prompt` を完了する

### FR-5: Permission

- ZCodeのpermission request IDと選択肢を保持する
- ACP clientへ `session/request_permission` を送る
- clientの選択を対応するZCode responseへ一度だけ変換する
- timeout、cancel、client切断をdeny/cancel相当として明示処理する
- 自動承認しない

### FR-6: Cancellation

- ACP `session/cancel` を対応するZCode `session/stop` へ伝播する
- cancel後の遅延eventを所定の終端まで順序通り処理する
- prompt responseを `stopReason: cancelled` で完了する
- cancelを一般エラーとして表示しない

### FR-7: Shutdown

- ACP stdin EOF、client切断、SIGTERMで新規request受付を停止する
- stdinを閉じてZCode子プロセスのgraceful exitを待つ
- timeout後はprocess treeを終了する
- active promptを別プロセスへ自動再送しない

### FR-8: Diagnostics

- protocol parse error、timeout、子プロセスexit、unsupported versionを区別する
- secretを除外してstderrへ構造化ログを出す
- user-facing errorに復旧方法を含める

## 9. 非機能要件

### NFR-1: Protocol integrity

stdoutにはACP frameだけを出します。ログ、banner、progress bar、stack traceはstderrへ送ります。

### NFR-2: Security

- permission modeを `yolo` へ暗黙変更しない
- credential/header/prompt本文を既定ログへ出さない
- `cwd` はabsolute pathとして検証する
- MVPでは `additionalDirectories` をadvertiseしない

### NFR-3: Compatibility

- ZCode app/build/platform、CLI version、metadata/host hash単位でcontract fixtureを保持する
- ACP schemaとSDKをexact versionでlockする
- ZCode更新時はcompatibility suiteを通すまでsupported matrixへ追加しない

### NFR-4: Portability

ユーザーにZCode CLI実行用のNode.jsを別途要求しません。`zcode-acp` 自身の配布形式は、Linuxで単一実行ファイルまたは明示的runtime packageを目標とします。

### NFR-5: Observability

request ID、ACP session ID、native session ID、workspace key、event sequenceを相関可能にします。ただしprompt、tool input、secret headerは既定で記録しません。

## 10. 安全なmodeの原則

ZCode one-shotの既定が `yolo` であることを、app-serverの既定に一般化してはいけません。アダプターは次を守ります。

- `yolo` を自動選択しない
- 既存workspace設定またはclientによる明示選択を勝手に強い権限へ変更しない
- 現在modeを取得できる場合はclientへ可視化する
- modeを安全に決定できない版では、推測せずセッション作成を失敗させる

mode configのACP公開はMVP後でも構いませんが、permission requestの正しいbridgeはMVP必須です。

## 11. MVP受け入れ条件

MVPは次をすべて満たしたときだけ完成とします。

1. Linux x64のdisplay serverなし環境で `zcode-acp` を起動できる
2. ACP v1 clientでinitializeとsession/newが成功する
3. 実モデルへのtext promptで複数のstream updateと `end_turn` を得る
4. read-only toolとwrite toolのpermission promptをclient上で確認できる
5. denyとcancelがZCode側へ正しく伝わる
6. Z.AI/BigModel Coding Plan利用時のprovider runtime headersが正しく適用される
7. child crashと不正frameでsilent hangしない
8. stdoutにprotocol外文字列が一度も混入しない
9. Toadとacpxの少なくとも二種類で同じ基本シナリオが通る
10. 認証情報、runtime header、prompt本文が既定ログに含まれない

一部を「既知の制限」として省略する場合は、その機能をcapabilityとしてadvertiseせず、READMEとcompatibility matrixに明記します。
