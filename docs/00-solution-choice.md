# Solution choice: ACP adapter + external client

## 1. Decision

採用する構成は次です。

```text
Generic ACP TUI / IDE / headless client
  -> zcode-acp
     -> installed ZCode official host service
```

Pi pluginとしてZCodeを埋め込む方式や、専用TUIを新規実装する方式は採用しません。`zcode-acp` はclient-independentなACP Agentとし、UIは既存ACP clientへ任せます。

## 2. Why this boundary

要求は「Piから使うこと」ではなく、次の二つです。

1. GUIがないLinuxで使えるTUI
2. ACP modeで起動して任意のACP clientから使えること

Pi pluginは第一の入口にはなれますが、Pi固有APIとlifecycleへ依存し、第二の要求を直接満たしません。逆に、ZCode private RPCをACPへ一度正しく変換すれば、TUI、IDE、automationから同じAgentを利用できます。

UIとadapterを分離すると、次の保守範囲も分離できます。

- TUI描画、key binding、terminal compatibility: ACP client側
- ZCode version差分、permission、session/event変換: `zcode-acp` 側
- model/provider/tool実装: ZCode側

## 3. Selection criteria

候補は次の観点で比較しました。

- Linux headlessで動くか
- generic ACP client/agentとして接続できるか
- TUIを再実装せずに済むか
- custom provider codeをclient本体へ追加せずに済むか
- session、stream、permission、cancelを扱えるか
- license上、独立processとして安心して利用できるか
- `zcode-acp` のCI clientにも使えるか

## 4. Candidate assessment

2026-07-19時点の調査スナップショットです。採用前にcurrent docs/licenseを再確認します。

| Candidate | Role | Assessment | Decision |
| --- | --- | --- | --- |
| Toad | Generic ACP TUI | Linux/macOS向けTUI。ACP Agentを外部commandとして扱える。AGPL-3.0だが別process clientとして利用可能 | 初期のhuman-facing client候補 |
| acpx | Headless ACP client | script/JSON/CI向け。TUIではないが、deterministic integration testに適する。MIT | 初期test client候補 |
| Zed | GUI ACP client | ACP interoperability確認には有用だが、headless TUI要件は満たさない | optional validation client |
| Nori | Generic ACP TUI | 技術的候補だが、独自license addendumの適用範囲を要精査 | 法務確認なしには基盤採用しない |
| OpenCode | Agent/TUI | ACP server surfaceはあるが、TUIがgeneric ACP clientとして任意agentへ接続する構造ではない | primary harnessにしない |
| Goose | Agent framework | ACP provider/server機能はあるが、custom agent統合はclient-independent adapterより重く、session制約も確認が必要 | primary harnessにしない |
| Pool | Generic ACP client | 技術的には候補だが、all-rights-reserved/EULA条件を要確認 | open基盤として採用しない |
| Pi + custom plugin | Pi-specific harness | Pi内のUXには適合するが、ACP Agentと汎用client要件を別途実装する必要がある | 不採用。将来ACP clientとして接続できるなら利用可能 |
| ZCode built-in `tui` | ZCode CLI TUI | 3.3.6配布物では `@zcode/tui` が欠落し起動不能 | 不採用 |

## 5. Recommended combination

初期開発では二種類のclientを使います。

- Toad: 人が使うTUI UX、stream、permission、cancelの確認
- acpx: CI可能なACP wire/integration scenarios

この二つを `zcode-acp` のdependencyとしてbundleしません。ユーザーは将来、互換性のある任意のACP clientを選べます。

## 6. Agent harness/framework choice

`zcode-acp` 自体に必要なのはfull agent harnessではなく、次の薄いadapter infrastructureです。

- official ACP SDK
- ACP JSON-RPC stdio server
- ZCode official host service bridge
- session coordinator
- event/permission/error mappers
- Electron Node worker lifecycle manager

構造の参考として `agentclientprotocol/codex-acp` が最も近いです。Codex app-serverをofficial ACP SDKへ変換しており、app-server client、session connection、event/tool/approval mapper、testsの分離を参考にできます。

ただしZCodeのprivate protocol shapeとreverse requestは異なるため、Codex-specific translationを流用しません。frameworkをforkしてZCode対応を継ぎ足すより、同じarchitecture patternをZCode contractに対して実装します。

## 7. Consequences

### Benefits

- TUIを自作・保守しない
- Piへ依存しない
- GUI IDEとheadless automationにも同じAgentを提供できる
- ZCode private互換性を一か所へ閉じ込められる
- clientを比較・交換できる

### Costs

- ZCode private RPCとACPの意味変換を正しく実装する必要がある
- ZCode更新ごとにcompatibility testが必要
- generic ACPに同等機能がないZCode user-input等は、仕様上のgapとして解決が必要
- TUI品質は選択したclientにも依存する

これらのcostは、専用TUIとadapterを同時に自作する場合にも存在し、さらにUI保守が加わります。ACP境界を先に作る方が要求に対して最小の恒久実装です。

## 8. Revisit triggers

次の場合は判断を再評価します。

- ZCodeが公式ACP serverを提供した
- ZCodeがversioned public headless SDKを提供した
- ACP clientがpermission/user-inputの必須UXを共通実装できない
- ZCodeサポートの公開条件（ZCode本体を同梱しない）が変更された
- selected TUI clientがACP v1 supportを廃止し、v2がstableになった

公式ZCode ACPが提供された場合、`zcode-acp` は原則として不要になり、独自bridgeを延命しません。
