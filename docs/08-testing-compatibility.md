# Testing and compatibility

単一versionの互換性方針は[ADR 0005](adr/0005-zui-xin-nojian-zheng-ji-mizcode-1baziyondakewoyan-mi-nisapotosuru.md)、Linux-only CIとrelease artifactの範囲は[ADR 0008](adr/0008-linuxshang-dequan-puratutohuomuxiang-keadaputanomiwobirudosuru.md)を参照してください。この文書は現在のcontract、test、実機probe、更新手順を記録します。

## 1. 方針

現在のmanifestはZCode 3.10.2 / CLI 0.16.5だけを表し、新versionを採用するときはこのentryとfixturesを置換します。過去versionのentryは残しません。

同一ZCode versionのCLIとhost内容は全OSで同一と扱います。OS別version entryやinstaller比較testは作らず、OS差はlayout解決とmetadata/process platform一致だけをtestします。

## 2. Current contract

| Field | Value |
| --- | --- |
| ZCode | `3.10.2` |
| CLI | `0.16.5` |
| CLI SHA-256 | `3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc` |
| Host artifact | `zcode-host-3.10.2` |
| Host index SHA-256 | `72e57751ed5563338335a52cd688c7fba0707ef72d8ce782356b1f0b39c77462` |
| RPC module | `out/host/chunk-KGXW6KHC.js` |
| RPC SHA-256 | `e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31` |
| Required exports | `g`、`i`、`j` |
| Host protocol | `zcode-task-v1` |

## 3. Unit and integration tests

### Identity and metadata

- macOS、Linux、Windows identityが同じartifact/protocolへ解決される
- metadataの`runtime`、`entry`、`source`を完全一致で検証する
- metadata platformとprocess platformの不一致を拒否する
- app buildとmetadata raw SHA-256の差分は判定へ影響しない
- 未知OSはlayout解決時に拒否する

### Artifact compatibility

- app/CLI versionが現在値と一致する
- 旧app versionと未知CLI versionを拒否する
- host index/RPC SHA-256とrequired exportsの差分を拒否する
- CLI SHA-256差分は`supported`かつ`modified`になる
- statusは`supported | unsupported`だけを返す

### Protocol semantics

- cancelを`stopGeneration({taskId})`へ変換する
- structured inputを平坦な`action`/`content`で`respondElicitation`へ渡す
- permissionは検証済み`optionId`を`respondPermission`へ渡す
- 旧response objectやnested responseを受理しない

### Public diagnostics

- `doctor --json`は`hostArtifact`と`hostProtocol`を返す
- `hostContract`を公開出力に含めない
- app build、metadata raw SHA-256、CLI integrityを診断表示する

## 4. Local runtime verification

release前に現在のmacOS ZCode 3.10.2で次を実行します。既存credentialの内容は表示・コピーしません。

1. frozen dependency install
2. `bun run check`
3. `doctor --json`
4. `bun run build`
5. `bun run release`による5 target build
6. host initialize、session create/list/read/resume/close
7. 実モデル応答とread/write tool
8. permission allow/deny
9. structured input
10. cancel、history resume/delete
11. ACP wire

実モデルを使う項目はworkspace dataがproviderへ送信され得るため、probe用一時directoryだけを対象にし、実行環境の承認を得て行います。

## 5. GitHub Actions

通常CIは`pull_request`と`main`へのpushで実行します。

- runner: `ubuntu-latest`だけ
- Bun: `1.3.13`
- install: `bun install --frozen-lockfile`
- verification: `bun run check`
- permissions: `contents: read`
- 同一refの古いrunをcancel

Release workflowもUbuntuだけを使い、公開前の`bun run check`を必須にします。成果物はmacOS arm64/x64、Linux arm64/x64、Windows x64の5 targetです。

## 6. New ZCode release procedure

1. 最新app/CLI versionを確認
2. current CLI、host index、RPC module、required exportsを取得
3. artifact descriptorを新releaseへ置換
4. protocol意味論が変わった場合だけprotocol descriptorを置換
5. fixtureと文書のcurrent値を置換
6. 旧version分岐、fixture、support記述が残っていないことを検索
7. unit/integration/local runtime verificationを完走

旧releaseを別entryとして残したり、互換性を推測するfallbackを追加したりしません。

## 7. Release decision

release可能なのは次をすべて満たす場合です。

- current artifact fingerprintが既知
- adapterの意味変換testが通る
- Linux CIの`bun run check`が通る
- local ZCode runtimeの必須probeが通る
- 5 target、checksums、SBOMが生成される
- credential、prompt、provider headerがartifact/logへ混入しない
