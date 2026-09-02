# 製品仕様

製品境界は[ADR 0002](adr/0002-acpadaputawokuraiantofei-yi-cun-tosi-uiwowai-bu-kuraiantoniwei-neru.md)、runtime起動は[ADR 0003](adr/0003-zcodegong-shi-hosutosabisuwotong-kun-electronrantaimudeqi-dong-suru.md)、ACP versionは[ADR 0006](adr/0006-acp-v1qi-yue-wogu-ding-si-jiang-lai-nopurotokoruban-wofen-li-suru.md)、権限とcredential境界は[ADR 0007](adr/0007-neiteibunoquan-xian-ru-li-zi-ge-qing-bao-nojing-jie-wobao-chi-suru.md)を参照してください。

## 1. 製品名

`zcode-acp`

## 2. 問題定義

ZCodeのエージェント機能はデスクトップGUIから利用できる一方、GUIを持たないLinux環境や、ACP対応TUI/IDEから利用するための公開入口がありません。`zcode-acp`はインストール済みZCodeの公式host serviceをACP v1へ接続します。

`zcode-acp`は、インストール済みZCodeの公式local host serviceをheadlessで起動し、そのservice contractを標準ACPへ変換することでこの問題を解決します。

## 3. 目標

### 3.1 現在の目標

- GUIセッションやdisplay serverなしで起動できる
- ACP v1対応クライアントから新規ZCodeセッションを作成できる
- text prompt、streaming response、tool statusをACPへ配信できる
- permission requestをクライアントへ転送し、選択結果をZCodeへ返せる
- promptをキャンセルできる
- 子プロセス終了、protocol破損、非対応版を明確なエラーとして扱える
- 対応ZCodeを使い、隔離した実機環境でend-to-endの実モデル応答を確認できる
- ToadなどのTUIとacpxなどのheadless clientの双方で接続できる

### 3.2 現在の対応範囲

- persisted sessionのload/resume/list/close
- model、thought level、modeのACP config optionsとlegacy mode操作
- stdio、HTTP、SSE MCP server設定の受け渡し
- text、resource link、image、audio、embedded resource prompt
- slash commands、plan、session情報、usage update
- macOS arm64/x64、Linux arm64/x64、Windows x64のstandalone build

ACP v2は現在の公開contractに含めません。対応時はADR 0006に従い、v1 handlerへ互換分岐を足さずversion別wire adapterとして実装します。

## 4. 非目標

- ZCodeそのものの再実装
- TUI、IDE、Web UIの実装
- Piまたは特定のagent harnessへの依存
- ZCodeのGUI自動操作
- `zcode.cjs` やZCodeアプリの再配布
- private RPCを公開安定APIとして一般化すること
- ZCode plugin/skill/marketplace管理APIの公開
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

| Platform | 現在の位置付け | 現在の根拠 |
| --- | --- | --- |
| Linux arm64/x64 | release target | ZCode 3.10.2 contract、headless運用 |
| macOS arm64/x64 | release target | ZCode 3.10.2 contract |
| Windows x64 | release target | ZCode 3.10.2 contract |

全OSで同じcurrent artifact/protocolを使います。OS別に互換性versionを増やさず、install layoutとmetadata/process platform一致だけを分離して検証します。各OSでの実行確認とrelease binaryの生成確認は別のevidenceとして記録します。

## 8. 現在の機能要件

### FR-1: ACP initialization

- stdio上のJSON-RPC 2.0を受け付ける
- 現在は `protocolVersion: 1` のみ選択する
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

- ACP `session/cancel` を意味操作`cancelGeneration`へ変換し、現在のhost descriptorに従って`stopGeneration({taskId})`へ伝播する
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
- 現在は `additionalDirectories` をadvertiseしない

### NFR-3: Compatibility

- ZCode app/CLI version、metadata semantics、process platform、host hash/export単位でcontract fixtureを保持する
- app buildとmetadata raw SHA-256は診断情報とし、compatibility条件にはしない
- ACP schemaとSDKをexact versionでlockする
- ZCode更新時はcompatibility suiteを通した最新1バージョンへcontractを置き換える

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

modeはACPのlegacy mode操作とconfig optionsの両方へ現在値として公開します。permission requestはnative optionとACP optionを一対一で対応させます。

## 11. Release受け入れ条件

releaseは次をすべて満たしたときだけ公開します。実機で確認した範囲は[Implementation status](10-implementation-status.md)に分離して記録します。

1. display serverに依存しない公式host起動経路を使い、Linux standalone binaryを生成できる
2. ACP v1 clientでinitializeとsession/newが成功する
3. 実モデルへのtext promptで複数のstream updateと `end_turn` を得る
4. read-only toolとwrite toolのpermission promptをclient上で確認できる
5. denyとcancelがZCode側へ正しく伝わる
6. 通常のprovider runtime headersは公式host内で適用され、interactive recovery requestを偽の成功として扱わない
7. child crashと不正frameでsilent hangしない
8. stdoutにprotocol外文字列が一度も混入しない
9. Toadとacpxの少なくとも二種類で同じ基本シナリオが通る
10. 認証情報、runtime header、prompt本文が既定ログに含まれない

一部を「既知の制限」として省略する場合は、その機能をcapabilityとしてadvertiseせず、READMEとcompatibility matrixに明記します。
