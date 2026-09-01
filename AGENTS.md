# Repository Rules

## ZCode compatibility

- 対応対象は常に最新の公式ZCode 1バージョンだけとする。
- 新しいZCodeバージョンへ対応するときは、以前のバージョンのmanifest、host artifact、protocol分岐、テスト、対応表を置き換える。後方互換コードは残さない。
- 同じZCode app versionに含まれる`zcode.cjs`と`app.asar/out/host`の内容は、OSとarchitectureによらず同一として扱う。OS別のversion entryやartifact fingerprintを追加しない。
- OS固有処理はインストール構造と、bundle metadataが現在のprocess platformに一致することの検証に限定する。

## GitHub Actions

- GitHub ActionsのjobはLinux runnerだけで実行する。macOS runnerとWindows runnerを追加しない。
- Linux runner上でmacOS、Linux、Windows向け成果物をクロスコンパイルしてよい。
