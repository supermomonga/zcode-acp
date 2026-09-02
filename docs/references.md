# References and evidence

この文書は互換性判定に使う一次資料、実測値、再現commandを記録します。これらの証拠を最新の検証済み1バージョンへ限定する理由は[ADR 0005](adr/0005-zui-xin-nojian-zheng-ji-mizcode-1baziyondakewoyan-mi-nisapotosuru.md)を参照してください。

## 1. Current ZCode artifact

調査日: 2026-09-01

```text
ZCode app: 3.10.2
Observed macOS build: 3.10.2.6414
ZCode CLI: 0.16.5
platform: darwin-arm64
runtime: electron-node
```

主要path:

```text
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
/Applications/ZCode.app/Contents/Resources/glm/.node-bundle-meta.json
/Applications/ZCode.app/Contents/Resources/app.asar/out/host/index.js
/Applications/ZCode.app/Contents/Resources/app.asar/out/host/chunk-KGXW6KHC.js
```

Current fingerprints:

```text
3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc  zcode.cjs
3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660  .node-bundle-meta.json (diagnostic only)
72e57751ed5563338335a52cd688c7fba0707ef72d8ce782356b1f0b39c77462  out/host/index.js
e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31  out/host/chunk-KGXW6KHC.js
```

hashは調査artifactの同一性を確認するもので、配布元の署名検証やlicense確認の代替ではありません。app buildとmetadata raw hashは診断情報であり、互換性条件ではありません。

## 2. ACP official sources

- [Agent Client Protocol official repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v1 cancellation](https://agentclientprotocol.com/protocol/v1/cancellation)
- [ACP v1 authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [schema-v1.19.0 release](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.19.0)

## 3. Structural references and clients

- [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp): ACP adapter structureの参考
- [batrachianai/toad](https://github.com/batrachianai/toad): generic ACP TUI
- [openclaw/acpx](https://github.com/openclaw/acpx): headless/scriptable ACP client

これらはZCode private host protocolの根拠ではありません。ZCode contractはinstalled artifactから取得します。

## 4. Reproduction commands

### App version

```bash
plutil -extract CFBundleShortVersionString raw -o - \
  /Applications/ZCode.app/Contents/Info.plist

plutil -extract CFBundleVersion raw -o - \
  /Applications/ZCode.app/Contents/Info.plist
```

### Bundled CLI version

```bash
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  version
```

### Adapter diagnostics

```bash
bun run src/cli.ts doctor --json
```

### Hashes

```bash
shasum -a 256 \
  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs \
  /Applications/ZCode.app/Contents/Resources/glm/.node-bundle-meta.json
```

host files inside ASAR are read through the installed Electron runtime before hashing.

## 5. Evidence limitations

現在のcontractは同一app versionのCLI/host contentをOS間で同一と扱います。OS別installerのcross-comparisonはrelease gateにしません。macOS上のruntime evidenceとLinux CIでのcross-build evidenceを分けて記録し、実行していないOS runtime testを成功扱いしません。

## 6. Refresh policy

新しいZCode releaseへ移行するときは、最新app/CLI、host fingerprint、protocol semanticsを再取得し、current manifest、tests、docsを置換します。旧release entryや後方互換分岐は残しません。
