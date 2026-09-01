# Implementation plan

## 1. Runtime and dependencies

- TypeScript/Bun standalone executable
- `@agentclientprotocol/sdk`とschemaをlock
- ZCode同梱Electron runtimeだけを使用
- stdoutはACP JSON-RPC専用、diagnosticはstderr
- ZCode credential/provider設定をadapterへ複製しない

## 2. Compatibility implementation

互換性実装は次の責務へ分けます。

1. OSごとのinstall layout解決
2. metadata semanticsとprocess platformの照合
3. current app/CLI versionの照合
4. `HostArtifactDescriptor`によるhost fingerprint検証
5. `HostProtocolDescriptor`によるtask意味変換
6. diagnostic-onlyなbuild、metadata hash、CLI integrity表示

manifestは常に最新ZCode 1 versionだけを持ちます。現在値はZCode 3.10.2 / CLI 0.16.5、`zcode-host-3.10.2`、`zcode-task-v1`です。

## 3. ACP implementation

- initialize/authenticate/logout
- session new/load/resume/list/close
- prompt streamとterminal mapping
- text/resource/image/audio/embedded context
- tool lifecycle
- native permission optionの一対一変換
- ACP form elicitationによるstructured input
- granular cancellation
- model/thought/mode/config updates
- MCP stdio/HTTP/SSE forwarding

native APIに存在しない機能をprivate storage編集や成功応答の偽装で補いません。

## 4. Verification workflow

```bash
bun install --frozen-lockfile
bun run check
bun run src/cli.ts doctor --json
bun run build
bun run release
```

続けてprobe用一時workspaceでhost lifecycle、実model/tool、permission、structured input、cancel/history、ACP wireを検証します。外部modelへ送信される可能性があるprobeは送信範囲を限定して承認を得ます。

## 5. CI and release

通常CIとReleaseはGitHub ActionsのLinux runnerだけで実行します。Bun 1.3.13を固定し、frozen install後に`bun run check`を通します。

Linux runnerから次の5 targetをcross compileします。

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64
- Windows x64

## 6. Updating ZCode

新release対応は追加ではなく置換です。

1. current artifactを実物から調査
2. descriptor、tests、docsを新値へ置換
3. protocolが変わった場合は意味変換も置換
4. 旧versionの分岐、fixture、文書を削除
5. 全検証を再実行

後方互換性は明示要求がない限り実装しません。

## 7. Definition of done

- current versionだけがsupportedになる
- 3 OS identityが同じartifact/protocolへ解決される
- mismatchが起動前にfail closedになる
- CLI modifiedとhost compatibilityが分離される
- `doctor`のpublic schemaがtestされる
- unit/integration/runtime probeが通る
- Linux-only CIと5 target release buildが通る
- docsに旧version契約やsupport historyが残らない
