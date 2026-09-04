---
number: 10
title: capability交渉付きACP plan operationsでZCodeのプラン承認を変換する
status: accepted
date: 2026-09-04
links:
- target: 6
  kind: relatesto
- target: 7
  kind: relatesto
---

# capability交渉付きACP plan operationsでZCodeのプラン承認を変換する

## Context and Problem Statement

ZCode 3.11.2はプラン本文と承認要求を `userInput.request` または `permission.request` で送る。従来実装は `userInput.request` の質問だけをform elicitationへ変換し、`input.plan` の本文をACP clientへ渡していなかった。また、ACPの従来型 `plan` は一つの項目一覧しか表せず、Markdownの提案本文と実行中のtodosを独立して管理できない。

## Decision Drivers

* プラン本文を承認前に欠落なく表示すること
* プラン承認と通常のtool permissionの意味を混同しないこと
* 不安定なACP機能を非対応clientへ送らないこと
* native option IDとallow/denyの意味を保持すること
* proposalとtodosの終了・空配列を明示し、clientに古い表示を残さないこと

## Considered Options

* capability交渉付きplan operationsとform elicitationへ分離して変換する
* 全clientへ不安定なplan operationsを送る
* 従来型planだけを使い続ける
* plan承認をsession/request_permissionとして公開する

## Decision Outcome

`clientCapabilities.plan` が非nullの場合だけ、ACP SDK 1.4.0の不安定な `plan_update` / `plan_removed` を使用する。proposalはMarkdown plan、todosはitems planとして別の `planId` を割り当てる。capabilityが未指定またはnullの場合は従来型 `plan` へ変換する。

プラン承認にはschema-v1.21.0で安定化されたform `elicitation/create` を使う。ZCodeの `schema.interaction === "plan_approval"` と `toolName === "ExitPlanMode"` を専用の内部契約へ正規化し、本文を通知してから承認を求める。通常のtool permissionだけを `session/request_permission` に対応させる。

SDK同梱の不安定schemaではMarkdown planの識別子に `planId` を使う。proposal IDは `zcode-plan-proposal:<native requestId>`、todos IDは `zcode-todos` とする。本文欠落、未知option、allow/denyへ安全に対応付けられない形ではallowを返さない。

### Consequences

* Good, because proposal本文とtodosを独立して更新・削除できる。
* Good, because plan capabilityを持たないclientでも従来型planで本文を確認できる。
* Good, because plan承認が通常のtool permissionとして誤表示されない。
* Good, because accept、decline、cancel、errorとnative option IDの対応を検証できる。
* Bad, because plan operationsは不安定仕様であり、SDK更新時に型とRFDの再確認が必要になる。
* Bad, because 従来型planではproposalとtodosを同時に別表示できない。

### Confirmation

SDK/schema lock test、capability有無のwire test、両native sourceの承認test、accept/decline/cancel/errorの削除test、通常permissionと通常formの回帰test、todos全件置換testで確認する。実機probeでは一時workspaceを使い、Markdown通知がelicitationより先に届くことと、cancel後にworkspaceが変更されないことを確認する。

## Pros and Cons of the Options

### capability交渉付きplan operationsとform elicitation

* Good, because ACPの各契約を目的どおりに使える。
* Good, because 不安定仕様の影響範囲を明示的に限定できる。
* Bad, because capability別の変換とlifecycle管理が必要になる。

### 全clientへplan operationsを送る

* Good, because agent側の出力shapeは一つになる。
* Bad, because 未対応clientとのprotocol契約に違反する。

### 従来型planだけを使う

* Good, because 安定仕様だけで構成できる。
* Bad, because proposal本文とtodosを独立したplanとして扱えない。

### plan承認をsession/request_permissionとして公開する

* Good, because 既存のpermission UIを再利用できる。
* Bad, because `session/request_permission` のtool実行許可という意味と一致しない。
* Bad, because Markdown本文をpermission contractへ正しく格納できない。

## More Information

この決定は[ADR 0006](0006-acp-v1qi-yue-wogu-ding-si-jiang-lai-nopurotokoruban-wofen-li-suru.md)のprotocolVersion固定とschema lock、および[ADR 0007](0007-neiteibunoquan-xian-ru-li-zi-ge-qing-bao-nojing-jie-wobao-chi-suru.md)のinteraction境界を具体化する。plan operationsが安定仕様になった場合、またはSDK同梱schemaから削除・変更された場合に再評価する。

根拠は[ACP TypeScript SDK v1.4.0](https://github.com/agentclientprotocol/typescript-sdk/releases/tag/v1.4.0)、[schema-v1.21.0](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.21.0)、[Plan Operations RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/plan-operations.mdx)とする。
