# 01. プロジェクト全体構成

## 基本情報

| 項目 | 値 |
|---|---|
| プロジェクト | CesiumJS |
| バージョン | 1.138.0 |
| ライセンス | Apache 2.0 |
| リポジトリ | https://github.com/CesiumGS/cesium |
| 言語 | JavaScript / TypeScript (ES Modules) |
| Node.js | >= 20.19.0 |
| モジュール形式 | ESM (`"type": "module"`) |

## モノレポ構成

```
cesium/                          ← ルートパッケージ (v1.138.0)
├── packages/
│   ├── engine/                  ← @cesium/engine v22.3.0 (コアエンジン)
│   ├── widgets/                 ← @cesium/widgets v14.3.0 (UIウィジェット)
│   └── sandcastle/              ← @cesium/sandcastle (デモ/エディタ, private)
├── Apps/                        ← アプリケーション
│   ├── Sandcastle/              ← プロダクション版 Sandcastle
│   ├── CesiumViewer/            ← スタンドアロンビューア
│   ├── TimelineDemo/            ← タイムラインデモ
│   └── SampleData/              ← サンプルデータ
├── Specs/                       ← テストスイート
│   ├── Data/                    ← テストデータ (CZML, KML, 3DTiles 等)
│   ├── e2e/                     ← E2E テスト (Playwright)
│   ├── TestWorkers/             ← テスト用 Web Worker
│   └── TypeScript/              ← TypeScript テスト
├── Source/                      ← トップレベルエントリ (packages を re-export)
├── Tools/                       ← JSDoc テンプレート, Rollup プラグイン
├── scripts/                     ← ビルドスクリプト
├── Documentation/               ← ドキュメント
├── .github/                     ← GitHub Actions ワークフロー
└── gulpfile.js                  ← メインビルドファイル
```

## ファイル数・規模

### Engine パッケージ (packages/engine/Source/)

| ディレクトリ | JS ファイル数 | 役割 |
|---|---|---|
| Core/ | 287 | 数学、ジオメトリ、アルゴリズム、ユーティリティ |
| Scene/ | 477 | レンダリングエンジン、プリミティブ、カメラ、タイル |
| DataSources/ | 108 | Entity API、CZML/GeoJSON/KML パーサー |
| Renderer/ | 46 | WebGL 抽象化 (非公開API) |
| Workers/ | 53 | Web Worker (ジオメトリ生成、テレイン処理) |
| Shaders/ | 304 GLSL | シェーダー (6サブディレクトリ) |
| Widget/ | 3 | CesiumWidget (メインウィジェット) |
| **合計** | **~972 JS** | **~367,000 LOC (ThirdParty除く)** |

### Widgets パッケージ (packages/widgets/Source/)

- **54 JS ファイル**
- 22 ウィジェットコンポーネント
- knockout.js ベースの MVVM パターン

### テスト

| 種類 | ファイル数 |
|---|---|
| Jasmine Spec | 652 |
| Playwright E2E | 5 |
| Sandcastle デモ | ~285 |

## 主要依存パッケージ (Engine)

| パッケージ | 用途 |
|---|---|
| draco3d | Draco 圧縮/解凍 |
| meshoptimizer | メッシュ最適化 |
| @cesium/wasm-splats | ガウシアンスプラット |
| protobufjs | Protocol Buffers |
| ktx-parse | KTX2 テクスチャ |
| lerc | LERC 圧縮 |
| pako | zlib 圧縮 |
| earcut | ポリゴン三角分割 |
| rbush, kdbush | 空間インデックス |
| @tweenjs/tween.js | アニメーション |
| @zip.js/zip.js | ZIP 圧縮 |
| urijs | URI 操作 |
