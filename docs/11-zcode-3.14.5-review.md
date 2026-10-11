# ZCode 3.14.5 compatibility review

調査日: 2026-10-11。対象: [Issue #26](https://github.com/supermomonga/zcode-acp/issues/26)。確認した adapter の main: `7b3af187d7ee732e9043aed873a863fc855625c2`。

## 判断

**3.14.5 は未対応。バージョンと fingerprint だけの更新は行わない。** 現在の対応基準は 3.14.3 ではなく **3.11.2 / CLI 0.16.5** である。3.14.5 の公式配布物は取得でき、CLI の version/doctor は成功したが、adapter が呼ぶホスト API が変わっている。manifest の検査を緩めて実行可能にするのは誤りである。

今回の変更は未対応の明示と調査結果の保存に限定する。実装移行と実ホスト契約の検証が完了するまで、既存の fail-closed 判定を維持し、Issue #26 は開いたままにする。これは「3.14.5 への追従が不要」ではなく、「対応済みとして公開するには時期尚早」という判断である。

## 3.14.3 → 3.14.5 の上流情報

[公式変更履歴](https://zcode.z.ai/en/changelog)では、3.14.4 はモデル要求の CAPTCHA 無効化、3.14.5 は手動リセット後の残りリセット回数の表示維持。adapter はその Desktop UI や手動リセット操作を実装していない。しかし変更履歴だけでは非公開 host contract の互換性を保証できない。

公開リポジトリの refs と履歴を確認したところ、次の状態だった。

| Ref | Commit | package version |
| --- | --- | --- |
| `v3.14.3` | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | 3.14.3 |
| `v3.15.1`, `main` | `aac4755666d09fdcd70272fcf063c077a639015f` | 3.15.1 |
| `feat/ui-plugin` | `662c30bea4e833acaacbfb745a65eb09c23d55f8` | 3.14.3 |

3.14.4/3.14.5 を識別できるソースコミットは見つからず、公開 main は 3.14.3 から 3.15.1 へ直接進んでいる。**正確な 3.14.3 → 3.14.5 のソース差分は取得できていない。** 3.15.1 の差分をその代わりに扱わない。

Paseo provider の managed runtime は別の方式で、3.14.3-paseo.1 の公開ソースビルドに ADR 19 のパッチを適用している。zcode-acp は Desktop 同梱の Electron / host を利用するため、その managed runtime やパッチを転用すれば対応できるわけではない。

## 3.14.5 公式成果物の実測

公式変更履歴ページが指定する [Linux x64 AppImage](https://cdn-zcode.z.ai/zcode/electron/releases/3.14.5/linux-x64/ZCode-3.14.5-linux-x64.AppImage) を取得し、`--appimage-extract` で一時領域へ展開した。Electron の `ELECTRON_RUN_AS_NODE=1` で ASAR の package metadata と host を読み取った。配布物は変更していない。以下のハッシュは測定値であり、独立した署名検証の代わりではない。

| 対象 | 実測 |
| --- | --- |
| App version | 3.14.5 (`resources/app.asar/package.json`) |
| CLI version | 0.16.9 (`resources/glm/zcode.cjs version`) |
| Bundled Electron Node | v24.14.0 |
| Metadata platform / runtime | `linux-x64` / `electron-node` |
| AppImage SHA-256 | `5cfa481c1e98eef85c4ef3e05639deb144de68c89e1a845b5cf19126f49eed07` |
| CLI SHA-256 | `fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f` |
| `out/host/index.js` SHA-256 | `a3473b147101ee29f53394bcbe90f4a121c570e2bdf1a5e0a19b938f19b174e5` |
| RPC module | `out/host/chunk-UHHNTW2R.js` |
| RPC module SHA-256 | `e18062d19280253e1c40a683f47d3891a27e335c5bc28d98986d714e3fc1f598` |
| RPC exports | `e`: MessagePortProtocol, `g`: ChannelClient, `h`: ProxyChannel (`fromService`, `toService`) |

RPC exports は Electron で当該モジュールを import し、export の名前・型・class name / object keys を確認した。現 manifest の `chunk-KGXW6KHC.js` は新しい `out/host` ディレクトリに存在しない。旧 exports `g/i/j` をそのまま使うこともできない。

## 具体的な契約の不一致

1. **バージョン検査。** `bun run src/cli.ts doctor --json --zcode-install /absolute/squashfs-root` の実測は app 3.14.5、CLI 0.16.9、`runtimeSmoke: passed`、`compatibility: unsupported`、理由は `ZCode app or CLI version does not match the current compatibility manifest`。`hostArtifact` / `hostProtocol` は null。CLI が起動することと ACP が動くことは別である。実アカウントは使っていない。
2. **workspace API。** adapter の `src/domain/session-service.ts` は `initializeWorkspace` と `getWorkspaceSettings` で `readWorkspaceState` を呼ぶ。3.14.5 の host index にはそのメソッドがなく、`readWorkspacePresentation` がある。公開 3.14.3 ソースの `packages/services/src/zcode-agent/zcodeAgent.ts` でも既に後者へ変わっているため、問題は 3.14.5 の小さな表示修正より前からある。
3. **メソッド名の置換だけでも不足。** 参照できる 3.14.3 ソースの `packages/shared/src/zcode-protocol/index.ts` では workspace presentation は `workspace` / `mode` / `slashCommands` を持つ。一方 adapter の `WorkspaceStateResultSchema` と利用側は `settings` / `modelCatalog.providers` を期待している。モデルカタログ取得、初期化時の認証判定、設定返却を新しい契約に合わせて評価する必要がある。この型参照は3.14.3の資料であり、3.14.5のwire実測の代わりではない。
4. **lifecycle の検証も未完。** 隔離した HOME / ZCode データ領域で、現 bridge source に候補の RPC path / exports を渡す一時的な調査 harness を実行した。`readWorkspaceState` 要求は30秒以内に応答を得られなかった。通常の discovery / manifest は変更せず、実データには接続していない。タイムアウトを特定の API エラーや互換性成功として扱わない。

## 必要な移行と受け入れ条件

- 対象版の host 起動、サービス登録、workspace/model catalog の取得経路を確認し、古い `readWorkspaceState` 契約と fixtures を置き換える。
- session new / resume / list、モデル・思考深度・mode 設定、イベント配信、ACP ストリーム、キャンセル、permission、elicitation、plan approval を実ホストで確認する。3.11.2 用 fake host の成功だけでは承認しない。
- 上流の公開型を使う場合は対象成果物と対応するソースを特定する。現行公開ソースにはその対応がないため、3.14.5 の返却値・イベントを別途実測する必要がある。
- ADR 0005 に従い、検証済みの新しい **1 バージョン**へ manifest / protocol / fixtures / docs をまとめて置き換える。旧版への fallback や、hash/export 検証の無効化は追加しない。
- 調査 harness による候補の確認と、正式 adapter による host lifecycle / ACP wire の実機検証を分けて記録する。CI runner は従来通り Linux のみとする。

3.15.1 を次の移行先にする場合も別途検証する。今回の3.14.5調査を、未検証の3.15.1サポートへ読み替えない。

## 今回の確認結果

- Bun 1.3.13、lockfile に基づく依存導入で `bun run check` が成功（typecheck、89 tests / 21 files）。これは既存3.11.2契約の試験。
- 3.14.5 の公式 Electron/CLI による `version` / `doctor` の smoke は成功。
- 新しい host lifecycle、ACP end-to-end、認証付きモデル実行、macOS / Windows の runtime は未検証。3.14.5 を対応済みとはしない。

再確認に使った主なコマンド:

```bash
git ls-remote https://github.com/zai-org/ZCode.git 'refs/tags/*' 'refs/heads/*'
./ZCode-3.14.5-linux-x64.AppImage --appimage-extract
ELECTRON_RUN_AS_NODE=1 ./squashfs-root/zcode \
  ./squashfs-root/resources/glm/zcode.cjs version
bun run src/cli.ts doctor --json --zcode-install /absolute/squashfs-root
bun run check
```
