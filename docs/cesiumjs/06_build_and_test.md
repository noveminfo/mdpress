# 06. ビルドシステム・テスト・CI/CD

## ビルドシステム

### 概要

| ツール | 役割 |
|---|---|
| Gulp | タスクランナー (gulpfile.js) |
| esbuild | JS/TS バンドル・ミニファイ |
| tsd-jsdoc | JSDoc → TypeScript 型定義 |
| カスタム | GLSL → JS 変換、Worker バンドル |

### 主要ビルドコマンド

```bash
npm run build           # 開発ビルド
npm run build-release   # リリースビルド (ミニファイ + pragma 除去)
npm run build-watch     # ウォッチモード
npm run build-ts        # TypeScript 型定義生成
npm run build-docs      # JSDoc ドキュメント生成
npm run clean           # ビルド成果物クリーン
```

### ビルドパイプライン

```
1. glslToJavaScript()    GLSL → JS モジュールに変換
2. bundleWorkers()       Web Worker を個別バンドル
3. buildEngine()         @cesium/engine ビルド
4. buildWidgets()        @cesium/widgets ビルド
5. buildCesium()         統合 Cesium.js 生成
```

### 出力形式

| 形式 | 用途 | ファイル |
|---|---|---|
| ESM | モダンバンドラー | `Source/Cesium.js` |
| IIFE | `<script>` タグ | `Build/Cesium/Cesium.js` |
| CJS | Node.js | `index.cjs` |

### GLSL → JS 変換

シェーダーファイル (`.glsl`) はビルド時に JavaScript モジュールに変換されます:

```
Source/Shaders/GlobeFS.glsl
  → (glslToJavaScript)
  → Source/Shaders/GlobeFS.js  (export default "shader source string")
```

## テスト

### テストフレームワーク

| 種類 | フレームワーク | ファイル数 |
|---|---|---|
| 単体テスト | Karma + Jasmine | 652 Spec |
| E2E テスト | Playwright | 5 Spec |
| TypeScript | tsc チェック | tsconfig.json |

### テストコマンド

```bash
# 単体テスト
npm test                    # 全テスト
npm run test-all            # 全テスト (verbose)
npm run test-webgl          # WebGL テストのみ
npm run test-non-webgl      # 非WebGL テストのみ
npm run test-webgl-stub     # WebGL スタブモード
npm run test-webgl-validation # WebGL バリデーション
npm run test-release        # リリースビルドテスト
npm run coverage            # カバレッジレポート

# E2E テスト
npm run test-e2e            # Chromium のみ
npm run test-e2e-all        # 全ブラウザ
npm run test-e2e-release    # リリースビルド E2E
```

### テストディレクトリ構成

```
Specs/
├── karma.conf.cjs           ← Karma 設定
├── karma-main.js            ← テストエントリ
├── Data/                    ← テストデータ
│   ├── CZML/
│   ├── Cesium3DTiles/
│   ├── KML/
│   ├── Models/
│   └── ...
├── e2e/                     ← Playwright E2E
│   ├── playwright.config.js
│   ├── CesiumPage.js        ← ヘルパー
│   ├── viewer.spec.js
│   ├── models.spec.js
│   ├── picking.spec.js
│   ├── sandcastle.spec.js
│   └── voxel-cameras.spec.js
├── TestWorkers/             ← テスト用 Worker
└── [ヘルパーファイル群]
    ├── createScene.js
    ├── createContext.js
    ├── createCamera.js
    ├── MockTerrainProvider.js
    └── ...
```

### テストの書き方

Spec ファイルは `packages/engine/Specs/` に配置:

```
packages/engine/Specs/
├── Core/
│   ├── Cartesian3Spec.js
│   ├── BoundingSphereSpec.js
│   └── ...
├── Scene/
│   ├── SceneSpec.js
│   ├── CameraSpec.js
│   └── ...
├── DataSources/
│   ├── EntitySpec.js
│   └── ...
└── Renderer/
    └── ...
```

## コード品質ツール

### ESLint

```bash
npm run eslint              # 全ファイルリント
```

- ESLint v9+ FlatConfig (`eslint.config.js`)
- `@cesium/eslint-config` 共通設定
- TypeScript-ESLint 対応
- ファイル別設定 (Browser/Node/Jasmine 環境)

### Prettier

```bash
npm run prettier            # 全ファイルフォーマット
npm run prettier-check      # フォーマットチェックのみ
```

- デフォルト設定 (`.prettierrc` は `{}`)
- `.prettierignore` で対象制御

### Pre-commit フック

```
Husky → lint-staged
  ├ *.{js,cjs,mjs,ts,tsx,css,html} → ESLint + Prettier
  └ *.md → markdownlint + Prettier
```

### その他

```bash
npm run tsc                 # TypeScript 型チェック
npm run markdownlint        # Markdown リント
npm run cspell              # スペルチェック
npm run cloc                # コード行数カウント
```

## CI/CD (GitHub Actions)

### ワークフロー一覧

| ファイル | トリガー | 内容 |
|---|---|---|
| `dev.yml` | main push/PR | Lint → Coverage → Release test → Node20 |
| `prod.yml` | cesium.com branch | Lint → Build → Deploy (cesium.com) |
| `deploy.yml` | feature branches | Lint → Build → Package → Deploy (ci-builds) |
| `sandcastle-dev.yml` | main push | Sandcastle ビルド → Deploy |
| `cla.yml` | PR 作成 | CLA 署名確認 |

### dev.yml の詳細

```
┌─ Lint Job ─────────────────────────┐
│  ESLint + Prettier + TypeScript    │
└────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌─ Coverage ─┐  ┌─ Release Tests ─┐  ┌─ Node 20 ─┐
│  Firefox   │  │  Chrome          │  │  互換テスト │
│  + S3 upload│  │  リリースビルド  │  │            │
└────────────┘  └─────────────────┘  └────────────┘
```

### カスタムアクション

- `.github/actions/verify-package/` - npm パッケージ検証
- `.github/actions/check-for-CLA/` - CLA 署名チェック (Google Sheets 連携)

## 開発サーバー

```bash
npm start              # http://localhost:8080
npm run start-public   # ネットワークからアクセス可能
```

`server.js` が Express サーバーを起動:
- Sandcastle: `/Apps/Sandcastle/`
- テストランナー: `/Specs/SpecRunner.html`
- ドキュメント: `/Build/Documentation/`
