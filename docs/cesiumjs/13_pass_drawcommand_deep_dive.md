# 13. Pass / DrawCommand 深掘り - 描画コマンドパイプライン

## 概要

CesiumJS の描画は **コマンドパターン** で実装されています。
各 Primitive は DrawCommand オブジェクトを生成し、Scene がそれらをまとめて実行します。

このドキュメントでは、DrawCommand の生成から WebGL 描画呼び出しまでの
完全なパイプラインを深掘りします。

## 全体フロー

```
Primitive.update(frameState)
  └── new DrawCommand({ vertexArray, shaderProgram, renderState, pass, ... })
  └── frameState.commandList.push(command)
           │
           ▼
View.createPotentiallyVisibleSet()           ← commandList を分類
  ├── COMPUTE / OVERLAY → 専用リストへ
  ├── カリング判定 (cullingVolume + occluder)
  ├── near/far 距離計算 → CommandExtent
  ├── updateFrustums() → フラスタム分割数を決定
  └── insertIntoBin() → frustumCommands[i].commands[pass][index] に格納
           │
           ▼
executeCommands()                            ← フラスタム別・パス別に実行
  └── for each frustum (far → near):
       ├── performPass(GLOBE)
       ├── performPass(TERRAIN_CLASSIFICATION)
       ├── performPass(CESIUM_3D_TILE_EDGES)
       ├── performPass(CESIUM_3D_TILE)
       ├── performPass(CESIUM_3D_TILE_CLASSIFICATION)
       ├── performPass(OPAQUE)
       ├── performPass(GAUSSIAN_SPLATS)
       └── performTranslucentPass(TRANSLUCENT)
                │
                ▼
executeCommand(command)                      ← derivedCommand の選択
  └── command.execute(context, passState)
       └── context.draw(command, passState)
                │
                ▼
beginDraw()  → FBO バインド, RenderState 適用, シェーダーバインド
continueDraw() → Uniform 設定, VA バインド, gl.drawElements() / gl.drawArrays()
```

## Pass - 描画パスの定義

**ファイル**: `packages/engine/Source/Renderer/Pass.js`

```javascript
Pass = {
  ENVIRONMENT: 0,                               // 環境（空、大気）
  COMPUTE: 1,                                    // GPU 計算（描画なし）
  GLOBE: 2,                                      // 地球タイル
  TERRAIN_CLASSIFICATION: 3,                     // 地形分類
  CESIUM_3D_TILE_EDGES: 4,                       // 3D Tiles エッジ
  CESIUM_3D_TILE: 5,                             // 3D Tiles
  CESIUM_3D_TILE_CLASSIFICATION: 6,              // 3D Tiles 分類
  CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW: 7,  // 3D Tiles 分類（show無視）
  OPAQUE: 8,                                     // 不透明ジオメトリ
  TRANSLUCENT: 9,                                // 半透明ジオメトリ
  VOXELS: 10,                                    // ボクセル
  GAUSSIAN_SPLATS: 11,                           // ガウシアンスプラット
  OVERLAY: 12,                                   // UI オーバーレイ
  NUMBER_OF_PASSES: 13,                          // パス総数
};
```

### パスの実行順序と意味

```
ENVIRONMENT (0)     ← Sky, Sun, Moon, Stars（最初に描画、ピッキング対象外）
COMPUTE (1)         ← GPU コンピュート（フラスタム外で実行）
GLOBE (2)           ← 地球タイル（最も遠い背景）
TERRAIN_CLASS (3)   ← 地形上の分類描画（道路等を地形に貼り付け）
3D_TILE_EDGES (4)   ← 3D Tiles のエッジ描画（テクスチャフィードバック回避のため先に実行）
3D_TILE (5)         ← 3D Tiles 建物モデル
3D_TILE_CLASS (6-7) ← 3D Tiles 上の分類描画
OPAQUE (8)          ← 通常の不透明オブジェクト（Entity 等）
TRANSLUCENT (9)     ← 半透明オブジェクト（OIT でソート不要描画）
VOXELS (10)         ← ボクセルプリミティブ
GAUSSIAN_SPLATS (11)← ガウシアンスプラット
OVERLAY (12)        ← 2D UI 要素（フラスタム外で実行）
```

### なぜこの順序か

1. **深度バッファの利用**: GLOBE → 3D_TILE → OPAQUE の順で不透明物を描画し、深度バッファを構築。後続パスで early-z rejection が効く
2. **分類描画の挿入**: GLOBE と 3D_TILE の直後にそれぞれの CLASSIFICATION パスを実行し、ステンシルバッファで分類を実現
3. **半透明の後処理**: TRANSLUCENT は最後に描画。OIT (Order Independent Transparency) で正しい合成

### パスの特殊処理

| パス | 特殊処理 |
|---|---|
| COMPUTE | フラスタムに関係なく1回だけ実行 |
| OVERLAY | フラスタムに関係なく最後に1回実行 |
| TRANSLUCENT | OIT (Order Independent Transparency) で合成 |
| GLOBE | GlobeTranslucencyState による特別処理あり |
| GAUSSIAN_SPLATS | 専用パス処理 |
| VOXELS | 専用パス処理 |

## DrawCommand - 描画コマンドの詳細

**ファイル**: `packages/engine/Source/Renderer/DrawCommand.js`

### コンストラクタ

```javascript
class DrawCommand {
  constructor(options) {
    // === WebGL 描画に必要な5要素 ===
    this._vertexArray = options.vertexArray;       // 頂点データ (VAO)
    this._shaderProgram = options.shaderProgram;   // シェーダー
    this._renderState = options.renderState;       // WebGL ステート
    this._uniformMap = options.uniformMap;          // Uniform 値
    this._primitiveType = options.primitiveType;   // TRIANGLES, LINES 等

    // === 描画制御 ===
    this._pass = options.pass;                     // どのパスで描画するか
    this._count = options.count;                   // 描画する頂点/インデックス数
    this._offset = options.offset;                 // 開始オフセット
    this._instanceCount = options.instanceCount;   // インスタンス数

    // === 空間情報 ===
    this._boundingVolume = options.boundingVolume;  // カリング用バウンディング球
    this._orientedBoundingBox = options.orientedBoundingBox; // OBB
    this._modelMatrix = options.modelMatrix;        // モデル変換行列

    // === フレームバッファ ===
    this._framebuffer = options.framebuffer;        // 描画先（null=デフォルト）

    // === フラグ（ビットフィールド） ===
    this._flags = 0;
    this.cull = true;            // 視錐台カリング有効
    this.occlude = true;         // 地球オクルージョン有効
    this.castShadows = false;    // シャドウキャスト
    this.receiveShadows = false; // シャドウレシーブ
    this.pickOnly = false;       // ピッキング専用（通常描画しない）
    this.executeInClosestFrustum = false; // 最近フラスタムのみで実行

    // === ピッキング ===
    this._pickId = options.pickId;
    this._owner = options.owner;  // この command を生成した Primitive

    // === 派生コマンド ===
    this.derivedCommands = {};    // logDepth, hdr, picking, shadows, oit 等
    this.dirty = true;
    this.lastDirtyTime = 0;
  }
}
```

### フラグのビットフィールド実装

DrawCommand の boolean フラグは**ビットフィールド**で実装されており、メモリ効率が良い:

```javascript
const Flags = {
  CULL: 1,                                    // bit 0
  OCCLUDE: 2,                                 // bit 1
  EXECUTE_IN_CLOSEST_FRUSTUM: 4,              // bit 2
  DEBUG_SHOW_BOUNDING_VOLUME: 8,              // bit 3
  CAST_SHADOWS: 16,                           // bit 4
  RECEIVE_SHADOWS: 32,                        // bit 5
  PICK_ONLY: 64,                              // bit 6
  DEPTH_FOR_TRANSLUCENT_CLASSIFICATION: 128,  // bit 7
};

function hasFlag(command, flag) {
  return (command._flags & flag) === flag;
}

function setFlag(command, flag, value) {
  if (value) {
    command._flags |= flag;   // ビット ON
  } else {
    command._flags &= ~flag;  // ビット OFF
  }
}
```

各プロパティ（cull, occlude 等）の getter/setter は内部で `hasFlag`/`setFlag` を使用。

### execute() - WebGL 描画実行

```javascript
DrawCommand.prototype.execute = function(context, passState) {
  context.draw(this, passState);
};
```

極めてシンプル。実際の描画は Context.draw() に委譲。

### shallowClone() - コマンドの複製

```javascript
DrawCommand.shallowClone = function(command, result) {
  // 全プロパティを浅いコピー
  result._vertexArray = command._vertexArray;
  result._shaderProgram = command._shaderProgram;
  // ... 全フィールド
  result.dirty = true;  // 派生コマンドの再生成を促す
  return result;
};
```

derivedCommands の生成で使用。元のコマンドを複製し、シェーダーや RenderState だけ差し替える。

## Context.draw() - WebGL 描画の実体

**ファイル**: `packages/engine/Source/Renderer/Context.js`

### draw() (L1397-1417)

```javascript
Context.prototype.draw = function(drawCommand, passState, shaderProgram, uniformMap) {
  const framebuffer = drawCommand._framebuffer ?? passState.framebuffer;
  const renderState = drawCommand._renderState ?? this._defaultRenderState;
  shaderProgram = shaderProgram ?? drawCommand._shaderProgram;
  uniformMap = uniformMap ?? drawCommand._uniformMap;

  beginDraw(this, framebuffer, passState, shaderProgram, renderState);
  continueDraw(this, drawCommand, shaderProgram, uniformMap);
};
```

### beginDraw() - WebGL ステートの設定

```javascript
function beginDraw(context, framebuffer, passState, shaderProgram, renderState) {
  bindFramebuffer(context, framebuffer);                    // FBO バインド
  applyRenderState(context, renderState, passState, false); // WebGL ステート適用
  shaderProgram._bind();                                    // シェーダーバインド
}
```

### continueDraw() - 実際の描画呼び出し

```javascript
function continueDraw(context, drawCommand, shaderProgram, uniformMap) {
  // モデル行列を UniformState に設定
  context._us.model = drawCommand._modelMatrix ?? Matrix4.IDENTITY;

  // Uniform 値をシェーダーに設定
  shaderProgram._setUniforms(uniformMap, context._us, ...);

  // VertexArray をバインド
  va._bind();

  const indexBuffer = va.indexBuffer;
  if (defined(indexBuffer)) {
    // インデックスバッファあり → drawElements
    context._gl.drawElements(primitiveType, count, indexDatatype, offset);
    // またはインスタンス描画
    context.glDrawElementsInstanced(primitiveType, count, indexDatatype, offset, instanceCount);
  } else {
    // インデックスバッファなし → drawArrays
    context._gl.drawArrays(primitiveType, offset, count);
  }

  va._unBind();
}
```

**ここが WebGL API との接点**。最終的に `gl.drawElements()` または `gl.drawArrays()` が呼ばれる。

## マルチフラスタム描画

### なぜ必要か

WebGL の深度バッファは 24bit (約 1670万段階)。
CesiumJS は 0.1m ～ 数百万km の距離を扱うため、単一フラスタムでは深度精度が不足し
z-fighting が発生する。

### フラスタム分割アルゴリズム (View.js updateFrustums)

```javascript
function updateFrustums(view, scene, near, far) {
  if (useLogDepth) {
    // 対数深度バッファ使用時 → より大きな比率で分割
    farToNearRatio = scene.logarithmicDepthFarToNearRatio;
  } else {
    farToNearRatio = scene.farToNearRatio;  // デフォルト: 1000
  }

  // 3D/CV: 対数分割（近くは密、遠くは疎）
  numFrustums = Math.ceil(Math.log(far / near) / Math.log(farToNearRatio));

  for (let m = 0; m < numFrustums; ++m) {
    curNear = Math.max(near, Math.pow(farToNearRatio, m) * near);
    curFar  = Math.min(far,  farToNearRatio * curNear);
  }
}
```

**例**: near=1m, far=10,000,000m, ratio=1000 の場合:
- フラスタム0: 1m ～ 1,000m
- フラスタム1: 1,000m ～ 1,000,000m
- フラスタム2: 1,000,000m ～ 10,000,000m

### コマンドのフラスタムへの分配 (insertIntoBin)

```javascript
function insertIntoBin(view, scene, commandExtent) {
  const { command, near, far } = commandExtent;

  for (let i = 0; i < frustumCommandsList.length; ++i) {
    const frustumCommands = frustumCommandsList[i];

    if (near > frustumCommands.far) continue;  // コマンドがフラスタムの奥
    if (far < frustumCommands.near) break;     // コマンドがフラスタムの手前

    // このフラスタムにコマンドを登録
    const pass = command.pass;
    const index = frustumCommands.indices[pass]++;
    frustumCommands.commands[pass][index] = command;

    if (command.executeInClosestFrustum) break; // 最近フラスタムのみ
  }

  // 派生コマンド（logDepth, picking, shadow, hdr）を更新
  scene.updateDerivedCommands(command);
}
```

**1つのコマンドが複数フラスタムにまたがることがある**（大きなオブジェクト）。

### FrustumCommands のデータ構造

```javascript
function FrustumCommands(near, far) {
  this.near = near;
  this.far = far;
  this.commands = new Array(NUMBER_OF_PASSES);  // パス別の配列
  this.indices = new Array(NUMBER_OF_PASSES);   // パス別のコマンド数

  // commands[Pass.GLOBE] = [cmd0, cmd1, ...]
  // commands[Pass.OPAQUE] = [cmd0, cmd1, ...]
  // indices[Pass.GLOBE] = 2  (2つのコマンド)
}
```

### フラスタム実行順序

```javascript
// far → near の順で実行（後のフラスタムが手前のフラスタムの深度バッファを上書き）
for (let i = 0; i < numFrustums; ++i) {
  const index = numFrustums - i - 1;  // 逆順
  const frustumCommands = frustumCommandsList[index];

  // フラスタムの near/far を設定
  frustum.near = frustumCommands.near;
  frustum.far = frustumCommands.far;

  clearDepth.execute(context, passState);  // 深度クリア

  // パス順に実行
  performPass(frustumCommands, Pass.GLOBE);
  performPass(frustumCommands, Pass.TERRAIN_CLASSIFICATION);
  // ... 各パス
  performPass(frustumCommands, Pass.OPAQUE);
  performTranslucentPass(...);
}
```

## derivedCommands - 派生コマンドシステム

1つの DrawCommand から、目的別に**シェーダーや設定を差し替えた派生コマンド**を生成:

```
DrawCommand (元コマンド)
 ├── derivedCommands.logDepth     ← 対数深度バッファ用シェーダー
 ├── derivedCommands.hdr          ← HDR 用シェーダー
 ├── derivedCommands.picking      ← ピッキング用シェーダー（ID色を出力）
 ├── derivedCommands.depth        ← 深度のみ描画用
 ├── derivedCommands.shadows      ← シャドウマップ描画用
 ├── derivedCommands.oit          ← OIT (半透明用)
 └── derivedCommands.pickingMetadata ← メタデータピッキング用
```

### executeCommand での派生コマンド選択

```javascript
function executeCommand(command, scene, passState) {
  // 1. 対数深度バッファ → logDepth 派生コマンドに差し替え
  if (frameState.useLogDepth && defined(command.derivedCommands.logDepth)) {
    command = command.derivedCommands.logDepth.command;
  }

  // 2. HDR → hdr 派生コマンドに差し替え
  if (scene._hdr && defined(command.derivedCommands.hdr)) {
    command = command.derivedCommands.hdr.command;
  }

  // 3. ピッキングパス → picking 派生コマンドで実行
  if (passes.pick && defined(command.derivedCommands.picking)) {
    command = command.derivedCommands.picking.pickCommand;
    command.execute(context, passState);
    return;
  }

  // 4. 深度パス → depth 派生コマンドで実行
  if (passes.depth && defined(command.derivedCommands.depth)) {
    command = command.derivedCommands.depth.depthOnlyCommand;
    command.execute(context, passState);
    return;
  }

  // 5. シャドウレシーブ → shadows 派生コマンドで実行
  if (lightShadowsEnabled && command.receiveShadows) {
    command.derivedCommands.shadows.receiveCommand.execute(context, passState);
  } else {
    command.execute(context, passState);
  }
}
```

### 派生コマンドの dirty フラグ

```javascript
Scene.prototype.updateDerivedCommands = function(command) {
  // シャドウマップが変更されたら dirty
  if (command.lastDirtyTime !== shadowState.lastDirtyTime) {
    command.dirty = true;
  }

  // dirty なら派生コマンドを再生成
  if (command.dirty) {
    derivedCommands.picking = DerivedCommand.createPickDerivedCommand(...);
    derivedCommands.depth = DerivedCommand.createDepthOnlyDerivedCommand(...);
    derivedCommands.logDepth = DerivedCommand.createLogDepthCommand(...);
    derivedCommands.hdr = DerivedCommand.createHdrCommand(...);
    derivedCommands.shadows = ShadowMap.createReceiveDerivedCommand(...);
    // OIT は TRANSLUCENT パスのみ
    if (command.pass === Pass.TRANSLUCENT) {
      derivedCommands.oit = oit.createDerivedCommands(...);
    }
    command.dirty = false;
  }
};
```

## DrawCommand の構成要素

### VertexArray (VAO)

```
VertexArray
 ├── attributes[]     ← 頂点属性（position, normal, texcoord 等）
 │    ├── index       ← attribute location
 │    ├── vertexBuffer ← GPU 上の頂点バッファ
 │    ├── componentsPerAttribute  ← 3 (vec3) や 2 (vec2)
 │    └── componentDatatype       ← FLOAT 等
 ├── indexBuffer      ← インデックスバッファ（オプション）
 └── numberOfVertices ← 頂点数
```

### ShaderProgram

```
ShaderProgram
 ├── vertexShaderSource    ← 頂点シェーダーソース
 ├── fragmentShaderSource  ← フラグメントシェーダーソース
 ├── vertexAttributes      ← 頂点属性マッピング
 ├── allUniforms           ← 全 Uniform 変数
 ├── _bind()               ← gl.useProgram()
 └── _setUniforms()        ← Uniform 値の設定
```

### RenderState

WebGL のレンダリング状態をカプセル化。**キャッシュ**される:

```javascript
// RenderState.fromCache() で同じ設定は同じオブジェクトを返す
const rs = RenderState.fromCache({
  cull: { enabled: true },           // 背面カリング
  depthTest: { enabled: true, func: DepthFunction.LESS },  // 深度テスト
  depthMask: true,                   // 深度書き込み
  blending: BlendingState.DISABLED,  // ブレンディング
  stencilTest: { ... },             // ステンシルテスト
  scissorTest: { ... },             // シザーテスト
  colorMask: { red: true, green: true, blue: true, alpha: true },
});
```

**キャッシュの仕組み**: JSON.stringify で状態をキー化し、同一設定なら同じオブジェクトを再利用。

### UniformMap

シェーダーの Uniform 変数に値を提供する関数マップ:

```javascript
const uniformMap = {
  u_color: function() { return Color.RED; },
  u_modelViewProjection: function() { return mvpMatrix; },
  u_texture: function() { return texture; },
};
```

関数で返す理由: 描画時に最新の値を遅延評価できる。

## カリングパイプライン

### createPotentiallyVisibleSet() でのカリング

```
commandList の各コマンドに対して:

1. Pass が COMPUTE → computeList に分離（フラスタム外）
2. Pass が OVERLAY → overlayList に分離（フラスタム外）
3. boundingVolume あり
   ├── cullingVolume.computeVisibility(BV) → OUTSIDE なら除外
   ├── occluder.isOccluded(BV) → 地球の裏側なら除外
   └── BV.computePlaneDistances() → near/far 距離を計算
4. boundingVolume なし
   └── カメラの frustum.near ～ frustum.far を使用
```

### Scene.isVisible()

```javascript
Scene.prototype.isVisible = function(cullingVolume, command, occluder) {
  // 1. cull フラグが false → カリングしない（常に描画）
  if (!command.cull) return true;

  // 2. 視錐台カリング
  const dominated = cullingVolume.computeVisibility(command.boundingVolume);
  if (dominated === Intersect.OUTSIDE) return false;

  // 3. 地球オクルージョン
  if (command.occlude && defined(occluder) &&
      !occluder.isBoundingSphereVisible(command.boundingVolume)) {
    return false;
  }

  return true;
};
```

## 実用パターン

### DrawCommand を生成する Primitive の典型パターン

```javascript
MyPrimitive.prototype.update = function(frameState) {
  // 初回のみ GPU リソース作成
  if (!defined(this._vertexArray)) {
    this._vertexArray = VertexArray.fromGeometry({ ... });
    this._shaderProgram = ShaderProgram.fromCache({ ... });
    this._renderState = RenderState.fromCache({
      depthTest: { enabled: true },
    });
    this._command = new DrawCommand({
      vertexArray: this._vertexArray,
      shaderProgram: this._shaderProgram,
      renderState: this._renderState,
      pass: Pass.OPAQUE,
      owner: this,
      modelMatrix: this._modelMatrix,
      boundingVolume: this._boundingSphere,
    });
  }

  // 毎フレーム: モデル行列とバウンディングの更新
  this._command.modelMatrix = this._modelMatrix;
  this._command.boundingVolume = this._boundingSphere;

  frameState.commandList.push(this._command);
};
```

### Pass の選び方

| 状況 | Pass |
|---|---|
| 通常の不透明ジオメトリ | `Pass.OPAQUE` |
| 半透明ジオメトリ | `Pass.TRANSLUCENT` |
| 地球タイル | `Pass.GLOBE` |
| 3D Tiles | `Pass.CESIUM_3D_TILE` |
| 地形上に描画（道路等） | `Pass.TERRAIN_CLASSIFICATION` |
| GPU 計算 | `Pass.COMPUTE` |
| 2D UI | `Pass.OVERLAY` |

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `Renderer/Pass.js` | パス定義（列挙型） |
| `Renderer/DrawCommand.js` | 描画コマンド |
| `Renderer/ClearCommand.js` | クリアコマンド |
| `Renderer/ComputeCommand.js` | GPU 計算コマンド |
| `Renderer/Context.js` | WebGL コンテキスト、draw() 実体 |
| `Renderer/RenderState.js` | WebGL ステート（キャッシュ付き） |
| `Renderer/ShaderProgram.js` | シェーダープログラム |
| `Renderer/VertexArray.js` | 頂点配列 (VAO) |
| `Renderer/UniformState.js` | 自動 Uniform (czm_*) |
| `Scene/View.js` | フラスタム分割・コマンド分類 |
| `Scene/FrustumCommands.js` | フラスタム別コマンド格納 |
| `Scene/Scene.js` | executeCommands(), updateDerivedCommands() |
| `Scene/DerivedCommand.js` | 派生コマンド生成 |
| `Scene/OIT.js` | Order Independent Transparency |
