---
number: 8
title: Linux上で全プラットフォーム向けアダプターのみをビルドする
status: accepted
date: 2026-09-02
---

# Linux上で全プラットフォーム向けアダプターのみをビルドする

## Context and Problem Statement

macOS、Linux、Windows向けのstandalone adapterを配布する必要がある一方、ZCode本体は公式配布元から取得されるべきであり、各OSのGitHub-hosted runnerでprivate runtimeを実行して検証することもできない。release工程を再現可能かつ限定されたものにする必要がある。

## Decision Drivers

* CIとrelease jobを同じLinux環境へ統一すること
* 利用者へBunやsystem Nodeの追加installを要求しないこと
* ZCode artifactとcredentialをreleaseへ含めないこと
* 各targetのbinary、checksum、SBOMを一つのrelease工程で生成すること

## Considered Options

* Linux runnerで全targetのadapterをcross compileする
* OSごとのnative runnerでbuildする
* source packageだけを配布して利用者がbuildする

## Decision Outcome

GitHub ActionsのjobはLinux runnerだけで実行し、macOS arm64/x64、Linux arm64/x64、Windows x64のstandalone adapterをcross compileする。releaseには5 binary、SHA-256 checksums、SPDX SBOMを含めるが、ZCode本体、installer、credentialは含めない。

OSごとのruntime互換性は単一artifact/protocol contractとinstall layout testで扱い、cross compile成功を各OS上のruntime実行成功とは表現しない。必要な実機probeは別の検証証拠として記録する。

### Consequences

* Good, because CI環境とrelease工程を一種類へ限定できる。
* Good, because 5 targetを同じsourceとdependency lockから生成できる。
* Good, because ZCodeの配布・license境界を明確に保てる。
* Bad, because cross compileだけではmacOSとWindows上のruntime動作を証明できない。
* Bad, because target固有問題には別途実機検証が必要になる。

### Confirmation

workflowの `runs-on` がLinuxだけであること、release scriptが5 targetとchecksums、SBOMを生成することを確認する。SBOMとbinaryからZCode artifact、credential、不要な製品依存が含まれないことを検査する。

## Pros and Cons of the Options

### Linux runnerからのcross compile

* Good, because runnerとtoolchainの差を減らせる。
* Good, because release artifactを一つのjobで揃えられる。
* Bad, because native runtime testは別工程になる。

### OSごとのnative runner

* Good, because buildと同じOSで基本実行を確認できる。
* Bad, because runner、toolchain、費用、失敗要因が増える。
* Bad, because private ZCode runtimeとcredentialをCIへ用意する問題は解消しない。

### source packageだけの配布

* Good, because release artifactの種類を減らせる。
* Bad, because 利用者へBunとbuild手順を要求する。
* Bad, because 同一sourceから生成されたbinaryのchecksumを提供できない。

## More Information

利用手順は[Headless Linux運用](../06-headless-linux.md)、buildとreleaseの検証項目は[Testing and compatibility](../08-testing-compatibility.md)に記録する。
