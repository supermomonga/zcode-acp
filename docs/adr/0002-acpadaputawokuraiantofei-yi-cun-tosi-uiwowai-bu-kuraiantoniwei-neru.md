---
number: 2
title: ACPアダプターをクライアント非依存とし、UIを外部クライアントに委ねる
status: accepted
date: 2026-09-02
---

# ACPアダプターをクライアント非依存とし、UIを外部クライアントに委ねる

## Context and Problem Statement

ZCodeのエージェント機能をGUIのないLinux環境と複数のACP対応クライアントから利用する必要がある。`zcode-acp` 自身がUIや特定クライアント向けの統合を持つと、ZCode private protocolへの追従とクライアントUXの保守が同じ製品へ混在する。

## Decision Drivers

* GUIのない環境でも利用できること
* TUI、IDE、automationから同じAgentを利用できること
* ZCode固有の変換責務を一か所へ閉じ込めること
* UIや特定のagent harnessを製品依存関係にしないこと

## Considered Options

* クライアント非依存のACP Agentを提供し、UIを外部ACPクライアントへ委ねる
* 専用TUIを `zcode-acp` に実装する
* Piなど特定のagent harnessのpluginとして実装する

## Decision Outcome

`zcode-acp` はクライアント非依存のACP stdio Agentとし、TUI、IDE、headless automationは互換性のある外部ACPクライアントへ委ねる。Toadやacpxは相互運用性の検証に利用できるが、製品へbundleせず、必須クライアントにも指定しない。

### Consequences

* Good, because 一つのadapterをTUI、IDE、CIから共通利用できる。
* Good, because ZCodeのversion差分、session、permission、event変換へ保守範囲を限定できる。
* Good, because クライアントを比較・交換してもadapterの公開境界を変えずに済む。
* Bad, because 操作性と対応機能は利用者が選ぶACPクライアントにも依存する。
* Bad, because private RPCとACPの意味差はadapter内で正確に実装し続ける必要がある。

### Confirmation

公開CLIがACP Agentと診断・認証操作に限定され、特定クライアント専用のserverやSDK依存がないことを確認する。少なくともTUI型とheadless型の二種類のACPクライアントで基本シナリオを検証する。

## Pros and Cons of the Options

### クライアント非依存のACP Agent

ZCode固有処理を標準ACPへ変換し、表示と対話をクライアントから分離する。

* Good, because 要求される複数の利用形態を一つの公開境界で満たせる。
* Good, because adapterとUIを独立して更新できる。
* Bad, because ACPクライアントごとのcapability差を相互運用テストで確認する必要がある。

### 専用TUI

* Good, because UX全体を一つの製品で制御できる。
* Bad, because terminal描画、入力、アクセシビリティを継続保守する必要がある。
* Bad, because IDEやheadless automation向けに別の入口が必要になる。

### 特定のagent harness向けplugin

* Good, because 対象harnessの機能を直接利用できる。
* Bad, because harness固有APIとlifecycleへ依存する。
* Bad, because 任意のACPクライアントから使う要件を直接満たさない。

## More Information

現在の製品境界とcapabilityは[製品仕様](../02-product-spec.md)および[公開README](../../README.md)に記録する。ZCodeが公式ACP serverを提供した場合は、独自bridgeを継続する必要性を再評価する。
