---
number: 6
title: ACP v1契約を固定し、将来のプロトコル版を分離する
status: accepted
date: 2026-09-02
links:
- target: 10
  kind: relatesto
---

# ACP v1契約を固定し、将来のプロトコル版を分離する

## Context and Problem Statement

ACPのprotocol version間ではinitialize、prompt完了、message、tool、plan、session復元の意味とwire shapeが異なる。同じhandlerへv1と将来versionの条件分岐を混在させると、negotiation後のcontractが不明確になる。

## Decision Drivers

* 公開wire contractを再現可能にすること
* SDK、schema、fixtureの暗黙更新を防ぐこと
* 実装していないcapabilityをadvertiseしないこと
* protocol version固有の意味を型とtestで分離すること

## Considered Options

* ACP v1と対応SDK/schemaを固定し、将来versionは別wire adapterとして追加する
* 一つのhandlerでv1と将来versionを同時に扱う
* SDKの互換範囲へ追従し、schemaを固定しない

## Decision Outcome

現在の公開contractをACP `protocolVersion: 1` に固定し、`@agentclientprotocol/sdk` と対応schemaをexact versionでlockする。将来のprotocol versionを追加する場合はversion別wire adapter、型、fixture、testを用意し、negotiation後のconnectionは一つのversionだけを扱う。

### Consequences

* Good, because prompt完了やsession updateの意味がconnection内で一意になる。
* Good, because dependency更新とwire contract変更を同じreviewで確認できる。
* Good, because versionごとのregression testを独立して維持できる。
* Bad, because 新protocol versionの対応には別adapterの実装が必要になる。
* Bad, because 複数versionを同時supportする場合のコード量が増える。

### Confirmation

package manifestのexact dependency、schema lock test、initialize negotiation test、ACP wire fixtureを確認する。未対応versionを拒否し、実装していないcapabilityがinitialize responseに現れないことをtestする。

## Pros and Cons of the Options

### version別wire adapter

* Good, because 各versionの型と意味を局所化できる。
* Good, because 一つのconnectionで複数versionが混在しない。
* Bad, because 共通処理とversion固有処理の境界設計が必要になる。

### 単一handlerの条件分岐

* Good, because 初期実装では共通コードを増やしやすい。
* Bad, because version固有のresponse時期やfieldを取り違えやすい。
* Bad, because 後方互換分岐が恒久的に残る。

### schemaを固定しないSDK追従

* Good, because dependency更新が容易に見える。
* Bad, because lockfile更新だけでwire behaviorが変わり得る。
* Bad, because release artifactのcontractを再現しにくい。

## More Information

現在のmethod、capability、mappingは[ACP v1 adapter specification](../05-acp-v1-adapter-spec.md)に記録する。dependencyの現在値は[`package.json`](../../package.json)を正とする。
