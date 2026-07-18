# Headless Linux運用

## 1. Status

ZCode 3.3.6-3198 linux-x64と`zcode-acp` linux-x64は、Ubuntu 24.04 amd64 containerで`DISPLAY`/`WAYLAND_DISPLAY`なしのE2Eを通過しています。version、doctor、ACP session、実モデル、read/write tool、permission allow/deny、cancelを確認済みです。

## 2. Install

公式`ZCode-3.3.6-linux-x64.deb`をpackage managerで通常どおりinstallします。packageが宣言する依存に加え、検証containerではElectronの共有libraryとして`libasound2t64`が必要でした。展開だけを行う最小imageではGTK/NSS/ALSA等が欠け、実行できません。

確認済み配置:

```text
/opt/ZCode/zcode
/opt/ZCode/resources/app.asar
/opt/ZCode/resources/glm/zcode.cjs
/opt/ZCode/resources/glm/.node-bundle-meta.json
```

## 3. Authentication

対象Linux user自身でZCode公式loginを行い、`~/.zcode`をそのuserだけが読める状態にします。`zcode-acp`はcredentialをコピー、復号、変換、表示しません。

ZCode 3.3.6の公式credential cipherは、`ZCODE_CREDENTIAL_SECRET`がなければOS、HOME、user名から鍵を導出します。そのため別OSから`~/.zcode`だけをコピーしても復号できません。正規の移行が必要な場合は、移行元と移行先のZCode processへ同一の`ZCODE_CREDENTIAL_SECRET`を設定します。これはZCode公式host実装の環境変数であり、adapter独自のcredential形式ではありません。

## 4. Diagnostics

```bash
zcode-acp doctor --json
```

supported packageでは次を確認します。

```json
{
  "platform": "linux-x64",
  "zcodeInstall": "/opt/ZCode",
  "zcodeAppVersion": "3.3.6",
  "zcodeCliVersion": "0.15.2",
  "compatibility": "supported",
  "runtimeSmoke": "passed",
  "authentication": "present",
  "providerHeadersBridge": "installed-host"
}
```

`authentication`はcredential fileの存在診断であり、token値やprovider headerを表示しません。実際のprovider readinessは`session/new`時に公式hostが検証し、未ログインなら`AUTH_REQUIRED`を返します。

## 5. ACP client registration

client固有の公式設定形式に従い、commandとしてstandalone binaryを登録します。

```text
command: /usr/local/bin/zcode-acp-linux-x64
environment:
  ZCODE_ACP_ZCODE_INSTALL=/opt/ZCode
```

stdoutはACP transport専用です。log collectorへstdoutを複製・加工しません。

## 6. Container / multi-user

- ZCode packageの公開imageへの再配布はlicense確認なしに行わない
- credentialをimage layerへ入れず、mode 600/700相当のvolumeに置く
- workspaceは必要な範囲だけmountする
- userごとにHOMEとcredential directoryを分離する
- global writableなZCode install rootを使用しない
- adapterは通常ACP clientの子processとして起動し、共有daemonにしない

## 7. Failure diagnosis

### shared library error

`.deb`をpackage managerでinstallし、`ldd /opt/ZCode/zcode`でmissing libraryを確認します。system Nodeでの再実行はしません。

### `AUTH_REQUIRED` / provider count 0

対象userでlogin済みか、HOMEが正しいか、別OSからstateを移した場合にcredential cipher secretが一致しているかを確認します。adapterへAPI keyやtokenを渡すfallbackはありません。

### provider runtime headers error

`doctor`のexact compatibilityを確認します。通常headerは公式hostのmodel-provider serviceが適用します。captcha等のinteractive recoveryをheadlessで完了できない場合、adapterは`headersApplied: false`としてturnを失敗させます。

### child/protocol error

stderrのadapter codeとZCode/CLI identityを採取します。active promptを自動再送しません。

## 8. Verified Linux gate

2026-07-19に以下を通過しました。

1. displayなしでversion/doctor
2. official host initializeとprovider readiness
3. ACP initialize/session/new
4. text streaming
5. read tool + permission
6. write tool allow-once / deny and filesystem assertion
7. model streaming cancel
8. clean shutdown
9. stdout contamination test

Linux arm64は未検証で、support matrixに含めません。
