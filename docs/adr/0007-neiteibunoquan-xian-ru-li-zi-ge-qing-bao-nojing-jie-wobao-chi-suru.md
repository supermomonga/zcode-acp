---
number: 7
title: ネイティブの権限・入力・資格情報の境界を保持する
status: accepted
date: 2026-09-02
links:
- target: 9
  kind: amendedby
- target: 10
  kind: relatesto
---

# ネイティブの権限・入力・資格情報の境界を保持する

## Context and Problem Statement

adapterは外部ACP client、ZCode private interaction、workspace、credentialの境界に位置する。permissionやstructured inputを似た別の応答へ丸めたり、credentialをadapterへ複製したりすると、利用者が意図しない権限付与やsecret漏えいにつながる。

## Decision Drivers

* native optionとclient選択の意味を失わないこと
* client非対応、切断、timeout時に安全側で停止すること
* credentialとprovider設定の所有者をZCodeに保つこと
* prompt、tool input、header、tokenをprotocol外へ漏らさないこと

## Considered Options

* native interactionを一対一で変換し、credential処理をZCodeへ委ねる
* adapterが不足するinteractionを既定応答で補う
* adapterがcredentialとprovider設定を直接管理する

## Decision Outcome

permission option IDと意味、structured inputのaccept/decline/cancel、sessionとturnのbindingを保持して一対一で変換する。未知option、client切断、timeoutではallowを返さず、`yolo` を暗黙に選ばない。form elicitation非対応clientではnative requestをdeclineし、turnを明示的に失敗させる。

credential、provider registry、runtime headersの作成・保存・適用は公式ZCode hostの責務とし、adapterは値を取得・複製・記録しない。公式runtimeに必要なproviderやproxy設定を保持するため親process環境をhostへ渡すが、環境値をlogやACP messageへ出さず、任意command overrideも公開しない。

### Consequences

* Good, because clientが選んだ権限とZCodeが実行する権限を対応付けられる。
* Good, because adapterがcredential形式やrefresh処理へ依存しない。
* Good, because 非対応interactionを偽の成功として扱わない。
* Bad, because capability不足のclientではturnが完了できない場合がある。
* Bad, because 親process環境にはsecretが含まれ得るため、ログと子process境界を継続監査する必要がある。

### Confirmation

permission allow/deny/cancel、未知option、late response、form elicitation非対応、provider header requestのtestを行う。secret fixtureを使い、stdout、stderr、ACP `_meta`、release artifactへsecretが含まれないことを確認する。

## Pros and Cons of the Options

### 一対一変換とZCodeによる資格情報管理

* Good, because 既存のZCode security modelをadapterが弱めない。
* Good, because secretをadapter storageへ追加しない。
* Bad, because ZCode hostとACP clientの両方が必要なinteractionを表現できなければ停止する。

### 既定応答による補完

* Good, because capabilityの少ないclientでもturnを続行できる場合がある。
* Bad, because 利用者の同意なしにallowや入力内容を合成する危険がある。
* Bad, because private requestを未解決のまま成功扱いし得る。

### adapterによるcredential管理

* Good, because adapter独自の認証UXを作れる。
* Bad, because credential形式、暗号化、refresh、provider差分を再実装する必要がある。
* Bad, because secretの保存先と漏えい面が増える。

## More Information

公開interaction mappingは[ACP v1 adapter specification](../05-acp-v1-adapter-spec.md)、security controlとlicensing boundaryは[Security and licensing](../07-security-licensing.md)に記録する。
