---
number: 3
title: ZCode公式ホストサービスを同梱Electronランタイムで起動する
status: accepted
date: 2026-09-02
---

# ZCode公式ホストサービスを同梱Electronランタイムで起動する

## Context and Problem Statement

ZCodeのモデル・provider registry・credential・runtime headersを利用してheadless Agentを動かす必要がある。`zcode.cjs app-server --stdio` の直接起動ではdesktop側のprovider registryを受け取れず、system Nodeによる起動は公式配布物と異なるruntimeを持ち込む。

## Decision Drivers

* desktopと同じproviderおよびcredential経路を利用できること
* ZCodeが配布したruntimeとhost実装の組を保持すること
* ZCode artifactをコピー、改変、再配布しないこと
* 実行対象を検証済みinstall root内へ限定すること

## Considered Options

* 公式host serviceを同梱ElectronのNode互換modeで起動する
* `zcode.cjs app-server --stdio` を直接起動する
* system Nodeでhost moduleを起動する

## Decision Outcome

インストール済みZCodeの同梱Electron executableを `ELECTRON_RUN_AS_NODE=1` で起動し、公式 `app.asar/out/host` serviceをworkerとして利用する。executable、CLI、metadata、host moduleは同じ検証済みinstall rootから解決し、system Nodeへfallbackしない。

### Consequences

* Good, because ZCode desktopと同じprovider registry、credential、runtime header処理を利用できる。
* Good, because 公式配布物のruntimeとhost実装の組み合わせを維持できる。
* Good, because ZCodeのcredential形式をadapterが複製する必要がない。
* Bad, because 非公開host artifactの変更をZCode releaseごとに検証する必要がある。
* Bad, because 利用者は対応する公式ZCodeを別途インストールする必要がある。

### Confirmation

runtime discovery testで同一install root、`electron-node` metadata、process platform一致を検証する。実機probeで公式hostのinitialize、session lifecycle、実モデル応答を確認し、system Node fallbackが存在しないことをコード検索で確認する。

## Pros and Cons of the Options

### 公式host serviceと同梱Electron

* Good, because desktopと同じmodel-provider経路を再利用できる。
* Good, because runtimeの出所を公式install artifactへ固定できる。
* Bad, because private host contractを厳密に追跡する必要がある。

### `zcode.cjs app-server --stdio`

* Good, because CLI entryを直接起動でき、構造が単純に見える。
* Bad, because desktop側のprovider registryがなく、実モデル利用の要件を満たさない。

### system Node

* Good, because 一般的なNode processとして起動できる。
* Bad, because ZCodeが配布・検証していないruntimeとの組み合わせになる。
* Bad, because 利用者へ追加runtimeの管理を要求する。

## More Information

観測した配布構造は[調査結果](../01-investigation.md)、起動構造は[アーキテクチャ](../03-architecture.md)、現在のhost contractは[ZCode private host protocol](../04-zcode-private-protocol.md)に記録する。
