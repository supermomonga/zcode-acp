---
number: 4
title: 状態を持つプロトコル変換としてACPとZCodeを接続する
status: accepted
date: 2026-09-02
---

# 状態を持つプロトコル変換としてACPとZCodeを接続する

## Context and Problem Statement

ACP JSON-RPCとZCode private RPCは、どちらも行区切りJSONを使うが、request ID、reverse request、session、prompt完了、permission、cancelの意味が異なる。envelopeだけを付け替えるproxyでは、状態と順序を正しく保てない。

## Decision Drivers

* 二つのprotocolのschemaとrequest相関を分離すること
* session、workspace、promptの状態と順序を明示すること
* event欠落、二重tool実行、誤った成功終了を防ぐこと
* private protocol変更をACP surfaceから隔離すること

## Considered Options

* protocol-neutralなsession coordinatorで状態を管理するadapter
* requestとeventを逐次変換するstateless proxy
* protocolごとに独立したsession状態を持ち、緩く同期する二重モデル

## Decision Outcome

protocol-neutralなsession coordinatorを中心に置き、ACP server、ZCode protocol client、host bridge、event mapperを分離する。native session IDをopaqueなACP session IDとして使い、workspace binding、prompt状態、pending interaction、event順序をcoordinatorで管理する。

### Consequences

* Good, because ACPとZCodeの更新を別々のschemaとtestで扱える。
* Good, because subscription、prompt、permission、cancelの順序条件を明示できる。
* Good, because 未知のeventや終端理由を誤った成功へ丸めずに済む。
* Bad, because connection、workspace、session、promptごとの状態管理が必要になる。
* Bad, because mapperとcoordinatorに意味変換のtestが必要になる。

### Confirmation

unit testとgolden traceでrequest ID相関、subscribe-before-send、event順序、単一active prompt、cancelのexactly-once処理、未知schemaのfail-closedを確認する。active promptを新しいchildへ自動再送しないことも検証する。

## Pros and Cons of the Options

### 状態を管理するadapter

* Good, because 異なる状態機械の意味を一か所で整合できる。
* Good, because failure boundaryと再試行禁止条件を表現できる。
* Bad, because 状態遷移の実装量が増える。

### stateless proxy

* Good, because request単位の変換は単純になる。
* Bad, because prompt完了、reverse request、cancel、event順序を表現できない。

### protocolごとの二重sessionモデル

* Good, because 各protocolの内部表現を独立させられる。
* Bad, because 再起動を越えるID mappingと同期不整合が増える。
* Bad, because native session IDをそのまま公開できる現行contractには不要である。

## More Information

具体的なcomponent、状態遷移、data flowは[アーキテクチャ](../03-architecture.md)、公開wire behaviorは[ACP v1 adapter specification](../05-acp-v1-adapter-spec.md)に記録する。
