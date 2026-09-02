---
number: 5
title: 最新の検証済みZCode 1バージョンだけを厳密にサポートする
status: accepted
date: 2026-09-02
---

# 最新の検証済みZCode 1バージョンだけを厳密にサポートする

## Context and Problem Statement

ZCode host serviceは公開・versioned APIではなく、app releaseによってファイル、export、service method、payload semanticsが変わり得る。広いversion rangeや推測によるfallbackは、互換性がないartifactを実行してworkspaceへ変更を加える危険がある。

## Decision Drivers

* 未検証artifactを起動前に拒否すること
* compatibility判定を再現可能な実測値で構成すること
* 過去versionの分岐とfixtureを累積させないこと
* OS固有差とartifact/protocol差を混同しないこと

## Considered Options

* 最新の検証済み公式ZCode 1バージョンだけを厳密一致でサポートする
* 複数の過去versionをmanifestへ累積する
* version rangeとbest-effort fallbackで起動する

## Decision Outcome

manifestは最新の検証済み公式ZCode 1バージョンだけを表し、新release対応時はartifact descriptor、必要に応じてprotocol descriptor、fixture、test、文書を置き換える。metadata semantics、process platform、app/CLI version、host index/RPC hash、required exportsを起動前に検証し、不一致は拒否する。

同じZCode app versionに含まれるCLIとhost内容はOSとarchitectureによらず同一として扱う。OS固有処理はinstall layoutとmetadata/process platform一致の検証に限定する。app buildとraw metadata hashは診断情報、CLI hash差分は `modified` 診断とし、host互換性とは分離する。

### Consequences

* Good, because サポート表明を実測済みcontractへ限定できる。
* Good, because unknown schemaやmethodを誤って実行しない。
* Good, because OS別manifestや過去version分岐の組み合わせ増加を避けられる。
* Bad, because ZCode更新のたびにartifact採取とruntime verificationが必要になる。
* Bad, because 利用者はサポート対象のZCodeへ更新する必要がある。

### Confirmation

manifestが単一artifact/protocolだけを持つこと、3 OSのidentityが同じcontractへ解決されること、旧versionと未知hash/exportを拒否することをtestする。release前にcurrent artifactでhost lifecycleとACP wireを実機検証する。

## Pros and Cons of the Options

### 最新の検証済み1バージョンだけを厳密にサポート

* Good, because support表明と検証証拠が一対一になる。
* Good, because private protocolの不確実性をfail-closedで扱える。
* Bad, because 複数のZCode releaseを同時には利用できない。

### 複数versionの累積support

* Good, because 古いZCode利用者を継続supportできる。
* Bad, because private contractごとの分岐、fixture、実機検証を維持する必要がある。
* Bad, because 検証できない古いartifactへsupport表明が残りやすい。

### best-effort fallback

* Good, because 未知versionでも起動できる可能性がある。
* Bad, because permissionやtool semanticsの不一致が実行後に発覚する。
* Bad, because 安全性をversion文字列から推測することになる。

## More Information

現在の実測値は[調査結果](../01-investigation.md)と[ZCode private host protocol](../04-zcode-private-protocol.md)、更新手順は[Testing and compatibility](../08-testing-compatibility.md)に記録する。
