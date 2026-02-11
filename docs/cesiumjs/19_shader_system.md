# 19. Shader システム - ShaderBuilder / GLSL コンパイルパイプライン

## 概要

CesiumJS のシェーダーシステムは **GLSL シェーダーの動的生成・コンパイル・キャッシュ**を担当します。
約 300 の GLSL ファイル（91 ビルトイン関数、40 定数、8 構造体 + 各種シェーダー）を管理し、
パイプラインステージごとに段階的にシェーダーを組み立てます。

主な特徴:
- **ShaderBuilder**: パイプラインステージが段階的に GLSL コードを追加するビルダー
- **ShaderSource**: `czm_` プレフィックスの依存関係を自動解決してビルトイン関数を注入
- **ShaderCache**: 同一シェーダーの重複コンパイルを防止（参照カウント管理）
- **AutomaticUniforms**: `czm_model`, `czm_view` 等を FrameState/UniformState から自動設定
- **ビルド時変換**: `.glsl` → `.js` 変換で GLSL をモジュールとしてインポート可能に

## アーキテクチャ全体図

```
┌──────────────────────────────────────────────────────────┐
│                    ビルド時（gulp/scripts）                │
│  .glsl ファイル ──→ glslToJavaScript() ──→ .js モジュール  │
│  Builtin/*.glsl ──→ CzmBuiltins.js (辞書)                │
└────────────────────────────┬─────────────────────────────┘
                             │ import
                             ▼
┌──────────────────────────────────────────────────────────┐
│                  実行時（ブラウザ）                         │
│                                                          │
│  ShaderBuilder (パイプラインステージが段階的に追加)          │
│       │                                                  │
│       ▼                                                  │
│  ShaderSource (czm_ 依存解決 + ビルトイン注入)              │
│       │                                                  │
│       ▼                                                  │
│  ShaderCache (キーベースキャッシュ)                         │
│       │                                                  │
│       ▼                                                  │
│  ShaderProgram (WebGL コンパイル + リンク)                  │
│       │                                                  │
│       ▼                                                  │
│  UniformState ──→ AutomaticUniforms (自動設定)             │
│  uniformMap    ──→ ManualUniforms    (手動設定)             │
└──────────────────────────────────────────────────────────┘
```

## ビルド時パイプライン: .glsl → .js 変換

**ファイル**: `scripts/build.js` L492-625

### 変換プロセス

```
packages/engine/Source/Shaders/**/*.glsl
  │
  ├─ glslToJavaScript()
  │   ├── 各 .glsl ファイルを読み込み
  │   ├── コメント除去、空白圧縮（minify 時）
  │   ├── 文字列エスケープ
  │   └── export default "..." として .js ファイルに出力
  │
  └─ CzmBuiltins.js 自動生成
      ├── Builtin/Constants/*.glsl → czm_定数名
      ├── Builtin/Structs/*.glsl  → czm_構造体名
      └── Builtin/Functions/*.glsl → czm_関数名
```

### 変換例

```glsl
// fog.glsl (入力)
vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor) {
    float scalar = distanceToCamera * czm_fogDensity;
    float fog = 1.0 - exp(-(scalar * scalar));
    return mix(color, fogColor, fog);
}
```

```javascript
// fog.js (出力 - 自動生成)
//This file is automatically rebuilt by the Cesium build process.
export default "vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor) {\n\
    float scalar = distanceToCamera * czm_fogDensity;\n\
    float fog = 1.0 - exp(-(scalar * scalar));\n\
    return mix(color, fogColor, fog);\n\
}\n";
```

### CzmBuiltins.js の生成

```javascript
// 自動生成されるファイル
import czm_fog from './Functions/fog.js';
import czm_pi from './Constants/pi.js';
import czm_material from './Structs/material.js';
// ... 139 個のビルトインを import

export default {
    czm_fog: czm_fog,
    czm_pi: czm_pi,
    czm_material: czm_material,
    // ...
};
```

### ビルトイン GLSL ファイル数

| カテゴリ | ファイル数 | 例 |
|---|---|---|
| Functions | 91 | `fog.glsl`, `gammaCorrect.glsl`, `phong.glsl` |
| Constants | 40 | `pi.glsl`, `epsilon1.glsl`, `passOpaque.glsl` |
| Structs | 8 | `material.glsl`, `ray.glsl`, `shadowParameters.glsl` |
| **合計** | **139** | |

## ShaderBuilder - 段階的シェーダー組立

**ファイル**: `Renderer/ShaderBuilder.js` (598行)

### 内部構造

```javascript
function ShaderBuilder() {
  // attribute 0 は常にアクティブにする必要があるため position を分離管理
  this._positionAttributeLine = undefined;
  this._nextAttributeLocation = 1;
  this._attributeLocations = {};
  this._attributeLines = [];

  // 動的に生成される構造体と関数
  this._structs = {};    // id → ShaderStruct
  this._functions = {};  // id → ShaderFunction

  // 頂点シェーダーパーツ
  this._vertexShaderParts = {
    defineLines: [],    // #define 行
    uniformLines: [],   // uniform 宣言行
    shaderLines: [],    // メインのシェーダーコード
    varyingLines: [],   // varying/out 宣言行
    structIds: [],      // 含める構造体 ID
    functionIds: [],    // 含める関数 ID
  };

  // フラグメントシェーダーパーツ（同構造）
  this._fragmentShaderParts = { ... };
}
```

### ShaderDestination

各操作の送り先を制御:

```javascript
const ShaderDestination = {
  VERTEX: 0,      // 頂点シェーダーのみ
  FRAGMENT: 1,    // フラグメントシェーダーのみ
  BOTH: 2,        // 両方
};
```

### 主要メソッド

| メソッド | 説明 | 生成される GLSL |
|---|---|---|
| `addDefine(id, value, dest)` | #define 追加 | `#define HAS_NORMALS` |
| `addUniform(type, name, dest)` | uniform 宣言追加 | `uniform vec4 u_color;` |
| `addAttribute(type, name)` | 頂点属性追加 + location 自動割り当て | `in vec3 a_positionMC;` |
| `addVarying(type, name)` | varying 追加 | `out vec3 v_positionWC;` (VS) / `in vec3 v_positionWC;` (FS) |
| `addVertexLines(lines)` | VS メインコード追加 | GLSL ソースの文字列 |
| `addFragmentLines(lines)` | FS メインコード追加 | GLSL ソースの文字列 |
| `addStruct(id, name, dest)` | 構造体宣言開始 | `struct MaterialInput {` |
| `addStructField(id, type, name)` | 構造体フィールド追加 | `  vec3 normal;` |
| `addFunction(id, sig, dest)` | 関数シグネチャ登録 | `void adjustColor(...)` |
| `addFunctionLines(id, lines)` | 関数本体追加 | `{ ... }` |
| `setPositionAttribute(type, name)` | position 属性（location=0） | `in vec3 a_positionMC;` |
| `buildShaderProgram(context)` | 最終的な ShaderProgram 生成 | ↓参照 |

### buildShaderProgram() の組立順序

```javascript
ShaderBuilder.prototype.buildShaderProgram = function(context) {
  // 1. 構造体・関数の GLSL 生成
  const structLines = generateStructLines(this);    // struct { ... };
  const functionLines = generateFunctionLines(this); // void foo() { ... }

  // 2. 頂点シェーダーを結合（順序が重要）
  const vertexLines = [
    positionAttribute,     // in vec3 a_positionMC;  (location=0)
    ...attributeLines,     // in vec3 a_normalMC;    (location=1,2,...)
    ...uniformLines,       // uniform mat4 czm_model;
    ...varyingLines,       // out vec3 v_positionWC;
    ...structLines.vertex, // struct MaterialInput { ... };
    ...functionLines.vertex,
    ...shaderLines,        // メインのコード (void main() { ... })
  ].join("\n");

  // 3. ShaderSource にラップ（defines は別管理）
  const vertexShaderSource = new ShaderSource({
    defines: this._vertexShaderParts.defineLines,  // ["HAS_NORMALS", ...]
    sources: [vertexLines],
  });

  // 4. フラグメントシェーダーも同様に結合

  // 5. ShaderProgram.fromCache() でキャッシュ経由生成
  return ShaderProgram.fromCache({
    context: context,
    vertexShaderSource: vertexShaderSource,
    fragmentShaderSource: fragmentShaderSource,
    attributeLocations: this._attributeLocations,
  });
};
```

### パイプラインステージによる使用パターン

```javascript
// GeometryPipelineStage.js (典型例)
GeometryPipelineStage.process = function(renderResources, primitive, frameState) {
  const shaderBuilder = renderResources.shaderBuilder;

  // 1. #define
  shaderBuilder.addDefine("HAS_NORMALS", undefined, ShaderDestination.BOTH);

  // 2. Attribute
  shaderBuilder.setPositionAttribute("vec3", "a_positionMC");
  shaderBuilder.addAttribute("vec3", "a_normalMC");

  // 3. Varying
  shaderBuilder.addVarying("vec3", "v_positionWC");
  shaderBuilder.addVarying("vec3", "v_normalEC");

  // 4. GLSL コード追加（import した .glsl 文字列）
  shaderBuilder.addVertexLines(GeometryStageVS);    // GLSL テキスト
  shaderBuilder.addFragmentLines(GeometryStageFS);
};

// MaterialPipelineStage.js（次のステージ）
MaterialPipelineStage.process = function(renderResources, primitive, frameState) {
  const shaderBuilder = renderResources.shaderBuilder;

  shaderBuilder.addDefine("HAS_BASE_COLOR_TEXTURE", undefined, ShaderDestination.FRAGMENT);
  shaderBuilder.addUniform("sampler2D", "u_baseColorTexture", ShaderDestination.FRAGMENT);
  shaderBuilder.addUniform("vec4", "u_baseColorFactor", ShaderDestination.FRAGMENT);

  shaderBuilder.addFragmentLines(MaterialStageFS);
};
```

## ShaderSource - czm_ 依存解決とシェーダー結合

**ファイル**: `Renderer/ShaderSource.js` (526行)

### コンストラクタ

```javascript
function ShaderSource(options) {
  this.defines = options.defines ?? [];          // ["HAS_NORMALS", "HAS_PBR"]
  this.sources = options.sources ?? [];          // [GLSL ソース文字列]
  this.pickColorQualifier = options.pickColorQualifier;  // "uniform" or "in"
  this.includeBuiltIns = options.includeBuiltIns ?? true;
}
```

### combineShader() - シェーダーテキスト結合の中核

**L154-303**: ShaderSource から最終的な GLSL テキストを生成。

```
combineShader(shaderSource, isFragmentShader, context)
  │
  ├─① ソース結合
  │   sources[0], sources[1], ... を "#line 0\n" 区切りで結合
  │
  ├─② コメント除去
  │   removeComments()
  │
  ├─③ #version 抽出
  │   #version 300 es を先頭に移動（後で再挿入）
  │
  ├─④ #extension 抽出
  │   #extension を先頭に移動
  │
  ├─⑤ precision 除去
  │   precision mediump float; を除去（後で自動挿入）
  │
  ├─⑥ ピッキング対応
  │   pickColorQualifier が設定されていれば main() をラップ
  │
  ├─⑦ 最終テキスト組立
  │   extensions
  │   + precision (Fragment のみ: highp or mediump)
  │   + #define 行
  │   + WebGL 拡張 #define (OES_texture_float_linear 等)
  │   + ビルトインソース (★czm_ 依存解決)
  │   + out_FragColor layout 宣言
  │   + ユーザーソース
  │
  └─⑧ WebGL2 対応
      context.webgl2 なら "#version 300 es\n" を先頭に
      WebGL1 なら demodernizeShader() で in/out → attribute/varying に変換
```

### czm_ 依存解決 - 自動ビルトイン注入

ShaderSource の最も重要な機能は **`czm_` プレフィックスの自動依存解決**です。

```
getBuiltinsAndAutomaticUniforms(shaderSource)
  │
  ├─① getDependencyNode("main", shaderSource)
  │   ルートノードを作成
  │
  ├─② generateDependencies(root, dependencyNodes)
  │   │  正規表現 /\bczm_[a-zA-Z0-9_]*/g でソース内の czm_ 参照を検出
  │   │
  │   ├─ czm_fog → CzmBuiltins["czm_fog"] のソースを取得
  │   │   └─ czm_fog のソース内にも czm_fogDensity が見つかる
  │   │       └─ AutomaticUniforms["czm_fogDensity"] の宣言を取得
  │   │
  │   └─ 再帰的に全ての czm_ 依存を収集
  │
  └─③ sortDependencies(dependencyNodes)
      Kahn のアルゴリズムでトポロジカルソート
      → 依存される側を先に、依存する側を後に並べる
      → 循環依存があればエラー
```

#### _czmBuiltinsAndUniforms 辞書

ShaderSource の起動時に以下の辞書が構築されます:

```javascript
// ShaderSource.js L414-431
ShaderSource._czmBuiltinsAndUniforms = {};

// 1. CzmBuiltins（ビルド時生成の GLSL 辞書）を登録
for (const builtinName in CzmBuiltins) {
  ShaderSource._czmBuiltinsAndUniforms[builtinName] = CzmBuiltins[builtinName];
  // 例: "czm_fog" → "vec3 czm_fog(float d, vec3 c, vec3 fc) { ... }"
}

// 2. AutomaticUniforms の宣言を登録
for (const uniformName in AutomaticUniforms) {
  const uniform = AutomaticUniforms[uniformName];
  ShaderSource._czmBuiltinsAndUniforms[uniformName] = uniform.getDeclaration(uniformName);
  // 例: "czm_fogDensity" → "uniform float czm_fogDensity;"
}
```

これにより、GLSL ソース中に `czm_fog` と書くだけで:
1. `czm_fog` 関数のソースが自動注入される
2. `czm_fog` が参照する `czm_fogDensity` の uniform 宣言も自動注入される
3. トポロジカルソートにより正しい順序で注入される

### キャッシュキー生成

```javascript
ShaderSource.prototype.getCacheKey = function() {
  const sortedDefines = this.defines.slice().sort();
  const definesKey = sortedDefines.join(",");
  const sourcesKey = this.sources.join("\n");
  return `${definesKey}:${pickKey}:${builtinsKey}:${sourcesKey}`;
};
```

defines をソートすることで、`["A", "B"]` と `["B", "A"]` が同一キーになります。

## ShaderCache - 参照カウントベースのシェーダーキャッシュ

**ファイル**: `Renderer/ShaderCache.js` (288行)

### キャッシュの仕組み

```
ShaderCache
  │
  ├── _shaders: { keyword → cachedShader }
  │     cachedShader = {
  │       cache: this,
  │       shaderProgram: ShaderProgram,
  │       keyword: "defines:sources:attributeLocations",
  │       derivedKeywords: [],   // 派生シェーダーのキー
  │       count: 参照カウント,
  │     }
  │
  └── _shadersToRelease: { keyword → cachedShader }
        count が 0 になったシェーダーを遅延削除
```

### getShaderProgram() - キャッシュ参照・生成

```javascript
ShaderCache.prototype.getShaderProgram = function(options) {
  // 1. ShaderSource のキャッシュキーからルックアップキーを生成
  const keyword = `${vertexKey}:${fragmentKey}:${attributeLocationKey}`;

  // 2. キャッシュヒット → 参照カウント++
  if (defined(this._shaders[keyword])) {
    cachedShader = this._shaders[keyword];
    delete this._shadersToRelease[keyword];  // リリース予約を取消
    ++cachedShader.count;
    return cachedShader.shaderProgram;
  }

  // 3. キャッシュミス → シェーダーテキストを生成してコンパイル
  const vertexShaderText = vertexShaderSource.createCombinedVertexShader(context);
  const fragmentShaderText = fragmentShaderSource.createCombinedFragmentShader(context);

  const shaderProgram = new ShaderProgram({
    gl: context._gl,
    vertexShaderText: vertexShaderText,
    fragmentShaderText: fragmentShaderText,
    attributeLocations: attributeLocations,
    // ...
  });

  // キャッシュに登録
  this._shaders[keyword] = { shaderProgram, keyword, count: 1, ... };
  return shaderProgram;
};
```

### 参照カウントによるライフサイクル

```
Primitive が ShaderProgram を要求
  → getShaderProgram() → count++

Primitive が破棄
  → releaseShaderProgram() → count--

count == 0
  → _shadersToRelease に登録（即座には削除しない）

次フレーム開始時
  → destroyReleasedShaderPrograms()
    → まだ count == 0 なら WebGL リソースを破棄
```

### 派生シェーダー (Derived Shader)

基底シェーダーに対して、ピッキングやシルエットなどの変形版を作成:

```javascript
// 基底シェーダーから派生シェーダーを取得
let derived = cache.getDerivedShaderProgram(baseShader, "pick");

if (!defined(derived)) {
  // なければ作成（基底のキーに "pick" を追加したキーで保存）
  derived = cache.createDerivedShaderProgram(baseShader, "pick", {
    vertexShaderSource: pickVS,
    fragmentShaderSource: pickFS,
    attributeLocations: attributeLocations,
  });
}
```

派生シェーダーは基底シェーダーの `derivedKeywords` 配列で追跡され、基底シェーダー破棄時に一緒に破棄されます。

## ShaderProgram - WebGL コンパイル・リンク

**ファイル**: `Renderer/ShaderProgram.js` (620行)

### 遅延初期化

ShaderProgram のコンストラクタでは WebGL コンパイルを行いません。
最初の `_bind()` 呼び出し時に `reinitialize()` が実行されます。

```
new ShaderProgram(options)
  └── テキストを保持するだけ（_program = undefined）

描画時 DrawCommand.execute()
  └── shaderProgram._bind()
       └── _program === undefined なら reinitialize(shader)
```

### reinitialize() - コンパイルとリンク

```javascript
function reinitialize(shader) {
  // 1. WebGL コンパイル + リンク
  const program = createAndLinkProgram(gl, shader);

  // 2. Uniform 情報の収集
  const uniforms = findUniforms(gl, program);
  // gl.getActiveUniform() で全 uniform を列挙
  // → uniformsByName, samplerUniforms に分類

  // 3. Uniform の分類（Automatic vs Manual）
  const partitioned = partitionUniforms(shader, uniforms.uniformsByName);
  // czm_ プレフィックスの uniform → automaticUniforms
  // それ以外 → manualUniforms

  // 4. 頂点属性の発見
  shader._vertexAttributes = findVertexAttributes(gl, program, ...);

  // 5. サンプラーのテクスチャユニット割り当て
  shader.maximumTextureUnitIndex = setSamplerUniforms(gl, program, samplerUniforms);
}
```

### createAndLinkProgram() - WebGL API 呼び出し

```javascript
function createAndLinkProgram(gl, shader) {
  // 1. 頂点シェーダーのコンパイル
  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertexShader, shader._vertexShaderText);
  gl.compileShader(vertexShader);

  // 2. フラグメントシェーダーのコンパイル
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragmentShader, shader._fragmentShaderText);
  gl.compileShader(fragmentShader);

  // 3. プログラムのリンク
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  // 4. Attribute Location のバインド（ShaderBuilder が設定した location を使用）
  for (const attribute in shader._attributeLocations) {
    gl.bindAttribLocation(program, attributeLocations[attribute], attribute);
  }

  gl.linkProgram(program);

  // 5. リンク成功チェック（パフォーマンスのためリンク成功時はコンパイル状態を確認しない）
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
  }

  // 6. 失敗時: コンパイルエラー / リンクエラーの詳細ログ
  // debugShaders.getTranslatedShaderSource() で GPU 固有のソースも出力
  throw new RuntimeError(errorMessage);
}
```

## AutomaticUniforms / UniformState - 自動 Uniform 設定

### AutomaticUniforms の定義

**ファイル**: `Renderer/AutomaticUniforms.js` (1858行)

`czm_` プレフィックスの uniform を UniformState から自動取得:

```javascript
const AutomaticUniforms = {
  czm_model: new AutomaticUniform({
    size: 1,
    datatype: WebGLConstants.FLOAT_MAT4,
    getValue: function(uniformState) {
      return uniformState.model;
    },
  }),
  czm_view: new AutomaticUniform({
    size: 1,
    datatype: WebGLConstants.FLOAT_MAT4,
    getValue: function(uniformState) {
      return uniformState.view;
    },
  }),
  czm_viewerPositionWC: new AutomaticUniform({
    size: 1,
    datatype: WebGLConstants.FLOAT_VEC3,
    getValue: function(uniformState) {
      return Matrix4.getTranslation(uniformState.inverseView, scratch);
    },
  }),
  // ... 約70個の自動 Uniform
};
```

### 主要な AutomaticUniforms 一覧

| Uniform 名 | 型 | 説明 |
|---|---|---|
| `czm_model` | mat4 | モデル行列 |
| `czm_view` | mat4 | ビュー行列 |
| `czm_projection` | mat4 | 投影行列 |
| `czm_modelView` | mat4 | M × V |
| `czm_modelViewProjection` | mat4 | M × V × P |
| `czm_normal` | mat3 | 法線変換行列 |
| `czm_viewerPositionWC` | vec3 | カメラ位置（ワールド座標） |
| `czm_sunDirectionEC` | vec3 | 太陽方向（アイ座標） |
| `czm_lightDirectionEC` | vec3 | ライト方向（アイ座標） |
| `czm_fogDensity` | float | 霧の密度 |
| `czm_frameNumber` | float | フレーム番号 |
| `czm_morphTime` | float | モーフ遷移（0=2D, 1=3D） |
| `czm_sceneMode` | float | シーンモード |
| `czm_pass` | float | 描画パス |
| `czm_viewport` | vec4 | ビューポート (x,y,w,h) |
| `czm_currentFrustum` | vec2 | 現在のフラスタム (near, far) |

### UniformState - FrameState からの値の計算

**ファイル**: `Renderer/UniformState.js` (1949行)

UniformState は FrameState の情報をもとに行列計算等を行い、AutomaticUniforms に提供:

```
Scene.render()
  └── Context.beginFrame()
       └── UniformState.update(frameState)
            ├── setCamera(camera)        → view, inverseView, viewRotation
            ├── setView(view)            → view3D, viewRotation3D
            ├── setProjection(projection) → inverseProjection
            ├── setSunAndMoonDirections() → sunDirectionEC/WC, moonDirectionEC
            ├── fogDensity = frameState.fog.density
            ├── atmosphereXxx = frameState.atmosphere.xxx
            └── 合成行列を dirty フラグでオンデマンド計算
                modelView = model × view  (アクセス時に計算)
                modelViewProjection = modelView × projection
```

重要: `modelView` や `modelViewProjection` などの合成行列は **遅延計算** (dirty フラグ) で、実際に GPU に送る直前にのみ計算されます。

### _setUniforms() - 描画時の Uniform 設定

```javascript
ShaderProgram.prototype._setUniforms = function(uniformMap, uniformState, validate) {
  // 1. Manual Uniforms: uniformMap (DrawCommand に設定された辞書) から取得
  for (const mu of this._manualUniforms) {
    mu.value = uniformMap[mu.name]();  // uniformMap は関数の辞書
  }

  // 2. Automatic Uniforms: UniformState から自動取得
  for (const au of this._automaticUniforms) {
    au.uniform.value = au.automaticUniform.getValue(uniformState);
  }

  // 3. 全 Uniform を GPU に送信（gl.uniform*() 呼び出し）
  for (const uniform of this._uniforms) {
    uniform.set();  // gl.uniformMatrix4fv(), gl.uniform3fv(), etc.
  }
};
```

### Uniform の分類

```
シェーダー内の uniform 宣言
  │
  ├── "czm_model", "czm_view", ...
  │   → AutomaticUniforms 辞書にヒット
  │   → automaticUniforms[] に分類
  │   → UniformState から自動設定
  │
  └── "u_baseColorTexture", "u_color", ...
      → AutomaticUniforms にヒットしない
      → manualUniforms[] に分類
      → DrawCommand.uniformMap から手動設定
```

## データフロー全体図

```
┌─ ビルド時 ─────────────────────────────────────────────┐
│                                                        │
│  fog.glsl ──→ fog.js (export default "...")             │
│  pi.glsl  ──→ pi.js                                    │
│  ...                                                    │
│  ──→ CzmBuiltins.js { czm_fog: "...", czm_pi: "..." } │
│                                                        │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌─ 実行時 ───────────────────────────────────────────────┐
│                                                        │
│  PipelineStage.process(renderResources)                 │
│    └── shaderBuilder.addDefine("HAS_NORMALS")          │
│        shaderBuilder.addAttribute("vec3", "a_pos")     │
│        shaderBuilder.addUniform("float", "u_alpha")    │
│        shaderBuilder.addFragmentLines(MaterialFS)      │
│                                                        │
│  shaderBuilder.buildShaderProgram(context)              │
│    ├── 全パーツを結合 → vertexLines, fragmentLines     │
│    ├── new ShaderSource({ defines, sources })           │
│    └── ShaderProgram.fromCache()                        │
│         └── ShaderCache.getShaderProgram()              │
│              ├── キャッシュヒット → 既存を返す (count++)  │
│              └── キャッシュミス ↓                        │
│                   │                                     │
│  ShaderSource.createCombinedVertexShader(context)       │
│    └── combineShader()                                  │
│         ├── ソース結合 + コメント除去                     │
│         ├── #version, #extension 抽出                   │
│         ├── czm_ 依存解決                               │
│         │   ├── "czm_fog" → CzmBuiltins から注入        │
│         │   └── "czm_fogDensity" → 自動 uniform 宣言注入 │
│         ├── #define 行挿入                              │
│         ├── precision 宣言挿入                           │
│         └── #version 300 es 先頭付加                    │
│                   │                                     │
│  new ShaderProgram(vertexShaderText, fragmentShaderText) │
│    └── 遅延初期化（_program = undefined）                │
│                   │                                     │
│  描画時: shaderProgram._bind()                          │
│    └── reinitialize()                                   │
│         ├── createAndLinkProgram(gl, shader)             │
│         │   ├── gl.createShader() × 2                   │
│         │   ├── gl.shaderSource() × 2                   │
│         │   ├── gl.compileShader() × 2                  │
│         │   ├── gl.createProgram()                      │
│         │   ├── gl.attachShader() × 2                   │
│         │   ├── gl.bindAttribLocation() × N             │
│         │   └── gl.linkProgram()                        │
│         ├── findUniforms() → uniform 列挙               │
│         └── partitionUniforms() → Auto/Manual 分類      │
│                   │                                     │
│  shaderProgram._setUniforms(uniformMap, uniformState)    │
│    ├── manualUniforms: uniformMap[name]() で値取得      │
│    ├── automaticUniforms: uniformState から自動取得      │
│    └── uniform.set() → gl.uniform*() で GPU に送信      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## ピッキングシェーダー

ShaderSource はピッキング用のシェーダー変形を提供:

```javascript
// 頂点シェーダー: pickColor 属性を追加
ShaderSource.createPickVertexShaderSource = function(vs) {
  const renamedVS = ShaderSource.replaceMain(vs, "czm_old_main");
  return renamedVS + `
    in vec4 pickColor;
    out vec4 czm_pickColor;
    void main() {
      czm_old_main();
      czm_pickColor = pickColor;
    }
  `;
};

// フラグメントシェーダー: 出力を pickColor に置換
ShaderSource.createPickFragmentShaderSource = function(fs, qualifier) {
  const renamedFS = ShaderSource.replaceMain(fs, "czm_old_main");
  return renamedFS + `
    ${qualifier} vec4 czm_pickColor;
    void main() {
      czm_old_main();
      if (out_FragColor.a == 0.0) discard;
      out_FragColor = czm_pickColor;
    }
  `;
};
```

`replaceMain()` で元の `main()` を別名に変更し、新しい `main()` でラップする手法は CesiumJS 全体で使用されています。

## 関連ファイル

| ファイル | 責務 |
|---|---|
| `Renderer/ShaderBuilder.js` | パイプラインステージ用シェーダービルダー |
| `Renderer/ShaderSource.js` | czm_ 依存解決、シェーダーテキスト結合 |
| `Renderer/ShaderProgram.js` | WebGL コンパイル・リンク・Uniform 設定 |
| `Renderer/ShaderCache.js` | シェーダープログラムの参照カウントキャッシュ |
| `Renderer/ShaderDestination.js` | VS/FS/BOTH の送り先指定 |
| `Renderer/AutomaticUniforms.js` | czm_ 自動 Uniform 定義（約70個） |
| `Renderer/UniformState.js` | FrameState から Uniform 値を計算 |
| `Shaders/Builtin/Functions/` | ビルトイン GLSL 関数（91個） |
| `Shaders/Builtin/Constants/` | ビルトイン GLSL 定数（40個） |
| `Shaders/Builtin/Structs/` | ビルトイン GLSL 構造体（8個） |
| `scripts/build.js` | .glsl → .js 変換 + CzmBuiltins.js 生成 |
