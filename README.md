# zcode-acp

ZCodeの公式インストール済みruntimeを、ACP v1 stdio agentとして公開するTypeScript/Bunアダプターです。ZCodeの資格情報やmodel provider設定を複製せず、公式desktop host serviceをheadlessで起動します。

## Capabilities

- ACP v1 `initialize`、`authenticate`、`logout`
- `session/new`、`load`、`resume`、`list`、`close`、`prompt`、`cancel`
- text/resource link/image/audio/embedded resource promptとassistant/reasoning stream
- model、thought level、modeのsession config
- slash commands、plan、session info、context usage update
- stdio / HTTP / SSE MCP server設定のnative転送
- ACP form elicitationによるstructured user input
- tool callの作成・進行・完了・失敗通知
- native permissionのACP allow-once / allow-always / deny-once / deny-alwaysへの一対一変換
- session cancelとgranular `$/cancel_request`
- ZCode側のprovider registry、credential、runtime header適用経路の利用
- macOS arm64/x64、Linux arm64/x64、Windows x64の単一実行ファイル
- exact artifact hashによるfail-closed compatibility gate

`additionalDirectories`とsession deleteは、ZCode 3.3.6 hostに対応APIがないためadvertiseしません。`session/list`はZCodeの制約に合わせてcwdを必須とし、省略時はinvalid paramsを返します。form elicitation非対応clientにstructured inputが必要になった場合は、native requestをdeclineしてturnを明示的に停止します。

## Supported runtime

| Platform | ZCode | CLI | Status |
| --- | --- | --- | --- |
| macOS arm64 | 3.3.6 build 3.3.6.3198 | 0.15.2 | supported |
| Linux x64 | 3.3.6-3198 official `.deb` | 0.15.2 | supported |

同じversion文字列でもhashが異なるartifactは拒否します。`doctor --json`で判定理由とhashを確認できます。

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run build
```

release artifacts、SHA-256 checksums、SPDX 2.3 SBOMの生成:

```bash
bun run release
```

`v*` tagをpushするとGitHub Actionsが同じ検証とbuildを実行し、5 platform binaries、checksums、SBOMをGitHub Releaseへ公開します。

## CLI

```bash
./dist/zcode-acp doctor --json
./dist/zcode-acp version
./dist/zcode-acp login
./dist/zcode-acp logout
./dist/zcode-acp
```

subcommandなしではstdoutをACP JSON-RPC専用にし、診断ログはstderrへ出します。標準外のインストール先は`--zcode-install /absolute/path`または`ZCODE_ACP_ZCODE_INSTALL`で指定できます。

## ACP clients

Toad 0.6.20とacpx 0.12.0で、ACP v1の初期化、セッション作成、text stream、`end_turn`まで実機確認済みです。

Toad:

```bash
uvx --from batrachian-toad toad acp \
  "/absolute/path/to/zcode-acp-darwin-arm64" \
  --project-dir "/absolute/path/to/project"
```

acpx:

```bash
npx acpx@latest \
  --cwd "/absolute/path/to/project" \
  --agent "/absolute/path/to/zcode-acp-darwin-arm64" \
  sessions new

npx acpx@latest \
  --cwd "/absolute/path/to/project" \
  --agent "/absolute/path/to/zcode-acp-darwin-arm64" \
  "Reply with exactly OK"
```

Linuxでは公式`.deb`を通常どおりインストールし、そのLinux user自身でZCodeへログインしてください。別OSからstateを移行する場合、ZCode公式の`ZCODE_CREDENTIAL_SECRET`を移行元と移行先で同じ値に設定しない限りcredentialは復号できません。`zcode-acp`はcredentialのコピー・復号・変換を行いません。

## Privacy and terms

model/providerとの通信、telemetry、認証はインストール済みZCode runtimeが行い、ZCodeのprivacy policyと利用規約が適用されます。`zcode-acp`はprompt本文、credential、provider runtime headerを既定で永続ログへ保存しません。利用するACP client自身のlogging policyは別途確認してください。

ZCodeサポートへの確認により、ZCode本体を同梱しない条件で`zcode-acp`を公開できることを確認済みです。本projectはZCode artifactを同梱せず、ユーザーが公式配布物を別途インストールする境界を維持します。

設計、private contract、検証証跡は[`docs/`](docs/README.md)を参照してください。
