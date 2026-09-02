# Headless Linux運用

runtime起動は[ADR 0003](adr/0003-zcodegong-shi-hosutosabisuwotong-kun-electronrantaimudeqi-dong-suru.md)、互換性は[ADR 0005](adr/0005-zui-xin-nojian-zheng-ji-mizcode-1baziyondakewoyan-mi-nisapotosuru.md)、credential境界は[ADR 0007](adr/0007-neiteibunoquan-xian-ru-li-zi-ge-qing-bao-nojing-jie-wobao-chi-suru.md)、release buildは[ADR 0008](adr/0008-linuxshang-dequan-puratutohuomuxiang-keadaputanomiwobirudosuru.md)を参照してください。この文書は現在の運用手順と診断方法を記録します。

## 1. 対象

現在の互換性対象はZCode 3.10.2 / CLI 0.16.5です。Linux固有の互換性契約は持たず、全OSで`zcode-host-3.10.2`と`zcode-task-v1`へ解決します。

Linux固有の処理は、install rootとElectron executableの解決、およびmetadataの`platform`が実行processと一致することだけです。

## 2. Install

公式Linux packageを通常どおりinstallし、adapterを実行するLinux userでZCodeへsign inします。ZCodeやcredentialを`zcode-acp`のrelease artifactへ同梱しません。

```bash
zcode-acp doctor --json
zcode-acp
```

非標準のinstall rootは`--zcode-install /absolute/path`または`ZCODE_ACP_ZCODE_INSTALL`で明示します。system Nodeへのfallbackはありません。

## 3. Authentication

credentialはZCodeが所有します。別OSから状態を移行する場合、ZCodeのcredentialを復号できる正規の移行方法が必要です。`zcode-acp`はcredentialを表示、コピー、復号、変換しません。

## 4. Diagnostics

`doctor --json`で次を確認します。

```json
{
  "hostArtifact": "zcode-host-3.10.2",
  "hostProtocol": "zcode-task-v1",
  "compatibility": "supported"
}
```

`appBuild`と`metadataSha256`は調査用です。これらだけが変わっても互換性は変わりません。`cliIntegrity: "modified"`はCLI本文の差分を示しますが、host fingerprintが一致する場合は起動できます。

## 5. ACP client registration

ACP clientにはLinux用binaryの絶対pathとworkspace directoryを設定します。stdoutはACP JSON-RPC専用なので、shell wrapperが標準出力へlogを追加しないようにします。

## 6. Container / multi-user

- container imageには公式ZCode packageが要求する共有libraryをinstallする
- ZCode state directoryをadapter実行userが読み書きできるようにする
- workspaceごとに明示的なpathを渡す
- 複数user間でZCode stateやcredentialを共有しない
- provider runtime headerやpromptをlogへ出さない

## 7. CIとの分離

GitHub Actionsは`ubuntu-latest`だけを使います。Linux runner上でmacOS arm64/x64、Linux arm64/x64、Windows x64の5 binaryをcross compileします。CIでmacOS/Windows host runtimeを実行できることは主張せず、artifact buildとOS非依存のunit/integration contractを検証します。

## 8. Failure diagnosis

- `unsupported platform`: 未知OS/architecture、またはmetadata platform不一致
- `unsupported`: app/CLI version、metadata semantics、host hash/exportの不一致
- `cliIntegrity: modified`: CLI本文だけが現在のverified artifactと異なる
- `AUTH_REQUIRED`: ZCode側のsign-in/provider状態を確認
- child/protocol error: stdout framing、worker終了、service channelを確認
