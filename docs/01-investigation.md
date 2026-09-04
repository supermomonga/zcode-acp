# 調査結果

この文書は現在のZCode配布物から観測した事実を記録します。起動方式の選定は[ADR 0003](adr/0003-zcodegong-shi-hosutosabisuwotong-kun-electronrantaimudeqi-dong-suru.md)、互換性方針は[ADR 0005](adr/0005-zui-xin-nojian-zheng-ji-mizcode-1baziyondakewoyan-mi-nisapotosuru.md)、build方針は[ADR 0008](adr/0008-linuxshang-dequan-puratutohuomuxiang-keadaputanomiwobirudosuru.md)を参照してください。

## 1. 調査対象

2026-09-04時点のZCode 3.11.2 / CLI 0.16.5を、現在サポートする唯一のreleaseとして調査しました。互換性契約は過去releaseへ累積せず、新releaseを採用するときに置換します。

## 2. 配布構造

adapterが利用する要素は次の4種類です。

- OSごとのElectron executableとinstall root
- `Resources/glm/zcode.cjs`
- `Resources/glm/.node-bundle-meta.json`
- `Resources/app.asar/out/host`

同一app versionの`zcode.cjs`とhost実装はOS間で同一と扱います。OS別installerを相互比較してmanifestを増やす設計にはしません。OS差はinstall layoutの解決と、metadata platformが実行中のprocess platformに一致することだけで検証します。

## 3. metadata contract

metadataは次の意味値を必須とします。

```json
{
  "runtime": "electron-node",
  "entry": "zcode.cjs",
  "source": "apps/zcode-cli/packages/cli/dist/zcode.cjs",
  "platform": "darwin-arm64"
}
```

`platform`は例であり、現在のOSとarchitectureから得た値との完全一致が必要です。raw metadata SHA-256はdiagnosticに残しますが、JSONのfield順序や整形差分を互換性違反にはしません。

## 4. 観測した起動経路

公式GUI hostは同梱Electron executableをNode互換modeで動かし、`app.asar/out/host/index.js`をworkerとして起動します。この経路ではZCodeのprovider registry、credential、runtime header処理を利用できます。

`zcode.cjs app-server --stdio`を直接起動した実測ではprovider registryを受け取れず、実モデル利用に必要なproviderが0件になりました。この証拠に基づく起動方式はADR 0003で確定しています。

## 5. Host artifact

ZCode 3.11.2の現在値は次のとおりです。

| Field | Value |
| --- | --- |
| Artifact ID | `zcode-host-3.11.2` |
| Host index | `out/host/index.js` |
| Host index SHA-256 | `30911a90dadc5c384959d00d95ccc70c8cf38c74a9cb99c3168b0897d046d215` |
| RPC module | `out/host/chunk-KGXW6KHC.js` |
| RPC module SHA-256 | `e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31` |
| Required exports | `g`、`i`、`j` |

host index、RPC module、required exportsのいずれかが異なる場合は起動前に拒否します。

## 6. Host protocol

現在のprotocol IDは`zcode-task-v1`です。common操作は`zcode-agent`、task interactionは`zcode-task`を使います。

| Semantic operation | Native operation |
| --- | --- |
| cancel | `stopGeneration({taskId})` |
| structured input | `respondElicitation({taskId, requestId, action, content})` |
| permission | `respondPermission({taskId, requestId, optionId})` |

permissionの旧response object形式や、structured inputのnested response形式は扱いません。

## 7. 現在のcompatibility判定

- app versionは`3.11.2`だけを許可
- CLI versionは`0.16.5`だけを許可
- CLI SHA-256一致は`verified`、差分は`modified`
- CLIが`modified`でもhost artifact一致時は起動可能
- app buildとmetadata raw SHA-256は診断のみ
- metadata semantic field、process platform、host hash/exportの差分は拒否
- 未知OSはinstall layout解決時に拒否

これらを最新の検証済み1バージョンだけへ適用し、過去releaseを累積しない理由はADR 0005に記録しています。

## 8. 残る検証範囲

artifact/protocolの互換性契約と、各OSでの実運用検証は別に記録します。macOS上の現在releaseでhost lifecycleとbuildを検証し、Linux/Windows向けbinaryはLinux runnerからcross compileします。現在の検証結果は[Implementation status](10-implementation-status.md)に記録します。
