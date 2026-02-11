# 08. Primitive システム - DrawCommand 生成の仕組み

## 概要

Primitive は CesiumJS の **描画の基本単位** です。
GeometryInstance（形状データ）+ Appearance（見た目）を受け取り、
毎フレームの `update()` で **DrawCommand** を生成して `frameState.commandList` に追加します。

```
ユーザーコード:
  new Cesium.Primitive({
    geometryInstances: new GeometryInstance({ geometry: ... }),
    appearance: new PerInstanceColorAppearance()
  })

→ scene.primitives.add(primitive)
→ 毎フレーム: primitive.update(frameState)
→ DrawCommand 生成 → frameState.commandList に push
→ Scene が commandList を frustum/pass で仕分け → WebGL 描画
```

## Primitive のライフサイクル (PrimitiveState)

Primitive は内部状態 `_state` を持ち、`update()` 呼び出しごとに進行します。

```
READY (0)  ← 初期状態
  │
  ├─ [同期モード] loadSynchronous()
  │    → geometry.constructor.createGeometry() でジオメトリ生成
  │    → PrimitivePipeline.combineGeometry() で結合
  │    → COMBINED (4)
  │
  └─ [非同期モード] loadAsynchronous()
       → Web Worker でジオメトリ生成 → CREATING (1)
       → 完了 → CREATED (2)
       → combine タスク実行 → COMBINING (3)
       → 完了 → COMBINED (4)

COMBINED (4)
  │ createVertexArray() で GPU にアップロード
  ▼
COMPLETE (5)  ← 描画可能
  │ 以降は毎フレーム update() で DrawCommand を更新・キューイング

FAILED (6)  ← エラー発生時
```

### 各状態の意味

| 状態 | 値 | 意味 |
|---|---|---|
| READY | 0 | 初期状態。何もまだ処理されていない |
| CREATING | 1 | (非同期のみ) Web Worker がジオメトリ生成中 |
| CREATED | 2 | (非同期のみ) ジオメトリ生成完了、結合待ち |
| COMBINING | 3 | (非同期のみ) ジオメトリ結合処理中 |
| COMBINED | 4 | ジオメトリ結合完了、GPU アップロード待ち |
| COMPLETE | 5 | GPU アップロード完了、描画可能 |
| FAILED | 6 | エラー発生 |

## update() メソッド全体フロー (L2078-2227)

`update(frameState)` は **毎フレーム** 呼ばれ、以下の処理を順に実行します:

```
update(frameState)
  │
  ├─ 1. 早期リターン判定
  │    ├ geometryInstances がない & VA もない → return
  │    ├ appearance がない → return
  │    ├ 2D/CV モードで scene3DOnly → return
  │    └ render/pick パスでない → return
  │
  ├─ 2. BatchTable 初期化・更新
  │    └ createBatchTable() / batchTable.update()
  │
  ├─ 3. ジオメトリ読み込み (COMPLETE/COMBINED でない場合)
  │    ├ [asynchronous=true]  → loadAsynchronous()
  │    └ [asynchronous=false] → loadSynchronous()
  │
  ├─ 4. GPU アップロード (COMBINED の場合)
  │    ├ updateBatchTableBoundingSpheres()
  │    ├ updateBatchTableOffsets()
  │    └ createVertexArray()  → COMPLETE に遷移
  │
  ├─ 5. show=false or COMPLETE でない → return
  │
  ├─ 6. Appearance/Material 変更チェック
  │    ├ appearance 変更 → createRS=true, createSP=true
  │    ├ material 変更 → createSP=true
  │    ├ translucent 変更 → createRS=true
  │    └ material.update(context)
  │
  ├─ 7. RenderState 作成 (createRS=true の場合)
  │    └ createRenderStates()
  │
  ├─ 8. ShaderProgram 作成 (createSP=true の場合)
  │    └ createShaderProgram()
  │
  ├─ 9. DrawCommand 作成 (createRS or createSP の場合)
  │    └ createCommands()
  │
  └─ 10. コマンドキューイング (毎フレーム必ず実行)
       └ updateAndQueueCommands()
           → frameState.commandList.push(colorCommand)
```

## 主要関数の詳細

### loadSynchronous() (L1308-1369) - 同期ジオメトリ生成

```javascript
function loadSynchronous(primitive, frameState) {
  // 1. GeometryInstance をクローン
  // 2. geometry.constructor.createGeometry(geometry) で実際のジオメトリ生成
  //    例: RectangleGeometry.createGeometry(rectangleGeometry)
  //    → 頂点・インデックスデータが作られる
  // 3. PrimitivePipeline.combineGeometry() で結合・最適化
  //    → 頂点キャッシュ最適化、法線圧縮、座標変換等
  // 4. 成功 → _state = COMBINED
  //    失敗 → _state = FAILED
}
```

**ポイント**: `geometry.constructor.createGeometry(geometry)` がジオメトリの実体を生成します。
例えば `RectangleGeometry` なら矩形のメッシュ（頂点・インデックス配列）が作られます。

### createVertexArray() (L1621-1677) - GPU アップロード

```javascript
function createVertexArray(primitive, frameState) {
  // 各 geometry から VertexArray を作成 (WebGL バッファにアップロード)
  // VertexArray.fromGeometry({
  //   context, geometry, attributeLocations,
  //   bufferUsage: STATIC_DRAW, interleave
  // })
  //
  // バウンディングスフィアも作成
  // primitive._va = [VertexArray, ...]
  // primitive._primitiveType = geometries[0].primitiveType (TRIANGLES 等)
  //
  // releaseGeometryInstances=true なら CPU 側データ解放
  // → _state = COMPLETE
}
```

### createRenderStates() (L1679-1721) - WebGL ステート設定

```javascript
function createRenderStates(primitive, context, appearance, twoPasses) {
  // Appearance から RenderState を取得
  //
  // twoPasses (半透明+閉じたジオメトリ) の場合:
  //   _frontFaceRS: BACK カリング (前面を描画)
  //   _backFaceRS:  FRONT カリング (背面を描画)
  //   → 裏表を別パスで描画して正しい半透明合成
  //
  // depthFailAppearance がある場合:
  //   深度テスト失敗時用の RenderState (GREATER テスト)
}
```

### createShaderProgram() (L1723-1783) - シェーダー組み立て

```javascript
function createShaderProgram(primitive, frameState, appearance) {
  // Appearance の vertexShaderSource をベースに、以下を追加:
  //   1. BatchTable コールバック (per-instance 属性アクセス)
  //   2. _appendOffsetToShader (オフセット対応)
  //   3. _appendShowToShader (show/hide 切り替え)
  //   4. _appendDistanceDisplayConditionToShader (距離条件表示)
  //   5. appendPickToVertexShader (ピッキング用頂点出力)
  //   6. _updateColorAttribute (カラー属性)
  //   7. modifyForEncodedNormals (圧縮法線対応)
  //   8. _modifyShaderPosition (RTC/位置修正)
  //
  // フラグメントシェーダーにも appendPickToFragmentShader を追加
  //
  // ShaderProgram.replaceCache() でキャッシュ付きコンパイル
}
```

**ポイント**: シェーダーは Appearance が提供するベースコードに対して、
Primitive の各機能（ピッキング、表示条件、per-instance 属性等）のコードを
**動的に組み込む** パターンです。

### createCommands() (L1841-1940) - DrawCommand 生成

```javascript
function createCommands(primitive, appearance, material, translucent,
                        twoPasses, colorCommands, pickCommands, frameState) {
  // uniforms を取得 (appearance + material のユニフォーム結合)
  //
  // pass を決定:
  //   translucent → Pass.TRANSLUCENT
  //   opaque     → Pass.OPAQUE
  //
  // VertexArray の数 × multiplier 分の DrawCommand を生成:
  //   multiplier = twoPasses ? 2 : 1  (前面/背面の2パス)
  //             × depthFail ? 2 : 1   (深度失敗時描画)
  //
  // 各 DrawCommand の構成:
  //   vertexArray:   GPU 上の頂点データ
  //   renderState:   WebGL ステート (深度テスト、カリング等)
  //   shaderProgram: コンパイル済みシェーダー
  //   uniformMap:    ユニフォーム変数マップ
  //   pass:          描画パス (OPAQUE or TRANSLUCENT)
  //   owner:         所有者 (この Primitive)
  //   primitiveType: TRIANGLES 等
}
```

### updateAndQueueCommands() (L1996-2063) - コマンドキューイング

```javascript
function updateAndQueueCommands(primitive, frameState, colorCommands,
                                 pickCommands, modelMatrix, cull,
                                 debugShowBoundingVolume, twoPasses) {
  // 1. バウンディングボリュームを更新 (モデル行列適用)
  //
  // 2. シーンモードに応じた BoundingSphere を選択
  //    SCENE3D      → _boundingSphereWC
  //    COLUMBUS_VIEW → _boundingSphereCV
  //    SCENE2D      → _boundingSphere2D
  //    MORPHING     → _boundingSphereMorph
  //
  // 3. render/pick パスの場合、全 colorCommand に対して:
  //    - modelMatrix を設定
  //    - boundingVolume を設定 (フラスタムカリング用)
  //    - cull, debugShowBoundingVolume 設定
  //    - castShadows, receiveShadows 設定
  //    - pickId を設定 ("v_pickColor" or undefined)
  //
  // 4. ★ frameState.commandList.push(colorCommand)
  //    → Scene がこのリストから描画実行
}
```

## DrawCommand の構造

DrawCommand は **1回の WebGL draw call** に必要な全情報をカプセル化します。

```
DrawCommand {
  // ジオメトリデータ
  vertexArray:    VertexArray     ← GPU 上の頂点/インデックスバッファ
  primitiveType:  PrimitiveType   ← TRIANGLES, LINES, POINTS 等
  count:          number          ← 描画する頂点/インデックス数
  offset:         number          ← 開始オフセット
  instanceCount:  number          ← インスタンス描画数

  // シェーダー・ユニフォーム
  shaderProgram:  ShaderProgram   ← コンパイル済み GLSL プログラム
  uniformMap:     object          ← ユニフォーム変数 → 値のマッピング

  // WebGL ステート
  renderState:    RenderState     ← 深度テスト、ブレンド、カリング等
  framebuffer:    Framebuffer     ← 描画先 FBO (null = スクリーン)

  // カリング・可視性
  boundingVolume:      BoundingSphere  ← フラスタムカリング用
  orientedBoundingBox: OBB             ← より精密なカリング
  modelMatrix:         Matrix4         ← モデル変換行列
  cull:                boolean         ← カリング有効フラグ
  occlude:             boolean         ← ホライズンカリング

  // 描画制御
  pass:           Pass            ← OPAQUE, TRANSLUCENT, GLOBE 等
  owner:          object          ← 所有する Primitive
  castShadows:    boolean         ← 影を投射するか
  receiveShadows: boolean         ← 影を受けるか

  // ピッキング
  pickId:         string          ← ピッキング用 ID
}
```

### execute() メソッド

```javascript
DrawCommand.prototype.execute = function(context, passState) {
  context.draw(this, passState);  // → WebGL の drawElements/drawArrays
};
```

最終的に `Context.draw()` が WebGL API を呼び出します。

## 全体の流れ図

```
┌──────────────── ユーザーコード ─────────────────┐
│                                                  │
│  const primitive = new Primitive({               │
│    geometryInstances: new GeometryInstance({      │
│      geometry: new RectangleGeometry({...}),      │
│      attributes: { color: ColorGeometryIA(...) }  │
│    }),                                           │
│    appearance: new PerInstanceColorAppearance()  │
│  });                                             │
│  scene.primitives.add(primitive);                │
│                                                  │
└──────────────────────────────────────────────────┘
                    │
                    ▼ 毎フレーム (Scene.render → updateAndRenderPrimitives)
┌──────────────── update(frameState) ─────────────┐
│                                                  │
│  [初回のみ]                                      │
│  ├─ loadSynchronous/Async()                      │
│  │   geometry.createGeometry() → メッシュ生成     │
│  │   PrimitivePipeline.combineGeometry()         │
│  │                                               │
│  ├─ createVertexArray()                          │
│  │   → VertexArray.fromGeometry() → GPU Upload   │
│  │                                               │
│  ├─ createRenderStates()                         │
│  │   → RenderState.fromCache() → WebGL ステート   │
│  │                                               │
│  ├─ createShaderProgram()                        │
│  │   → Appearance シェーダー + 各種修飾           │
│  │   → ShaderProgram.replaceCache()              │
│  │                                               │
│  └─ createCommands()                             │
│      → new DrawCommand({VA, SP, RS, pass, ...})  │
│                                                  │
│  [毎フレーム]                                     │
│  └─ updateAndQueueCommands()                     │
│      → boundingVolume 更新                        │
│      → modelMatrix 設定                           │
│      → ★ frameState.commandList.push(command)    │
│                                                  │
└──────────────────────────────────────────────────┘
                    │
                    ▼ Scene.executeCommands()
┌──────────────── 描画実行 ────────────────────────┐
│                                                  │
│  commandList を frustum/pass でソート             │
│  for each frustum:                               │
│    for each pass (OPAQUE, TRANSLUCENT...):        │
│      for each command:                           │
│        command.execute(context, passState)        │
│          → context.draw(command, passState)       │
│            → gl.drawElements() / gl.drawArrays() │
│                                                  │
└──────────────────────────────────────────────────┘
```

## 拡張ポイント

### カスタム関数フック

Primitive はコンストラクタの `options` で内部関数を差し替え可能です:

| オプション | デフォルト | 用途 |
|---|---|---|
| `_createRenderStatesFunction` | `createRenderStates` | RenderState 生成カスタマイズ |
| `_createShaderProgramFunction` | `createShaderProgram` | シェーダー組み立てカスタマイズ |
| `_createCommandsFunction` | `createCommands` | DrawCommand 生成カスタマイズ |
| `_updateAndQueueCommandsFunction` | `updateAndQueueCommands` | キューイングカスタマイズ |
| `_createBoundingVolumeFunction` | (内蔵ロジック) | BoundingSphere 生成カスタマイズ |

これらは `GroundPrimitive` や `ClassificationPrimitive` 等のサブクラスが
独自の描画挙動を実装するために使用しています。

### Appearance による見た目制御

Appearance が提供するもの:

| 要素 | 説明 |
|---|---|
| `vertexShaderSource` | 頂点シェーダーのベースコード |
| `getFragmentShaderSource()` | フラグメントシェーダー |
| `getRenderState()` | WebGL ステート設定 |
| `material` | Material (テクスチャ・色等のユニフォーム) |
| `isTranslucent()` | 半透明かどうか → Pass 決定に使用 |
| `closed` | 閉じたジオメトリか → twoPasses 判定に使用 |

主な Appearance 実装:
- `MaterialAppearance` - 汎用 (Material ベース)
- `PerInstanceColorAppearance` - インスタンスごと色指定
- `EllipsoidSurfaceAppearance` - 楕円体表面用
- `PolylineMaterialAppearance` - ポリライン用
- `PolylineColorAppearance` - ポリライン色指定

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `Scene/Primitive.js` | 描画プリミティブの基本クラス (~2300行) |
| `Scene/PrimitiveState.js` | ライフサイクル状態定義 |
| `Scene/PrimitivePipeline.js` | ジオメトリ結合・最適化パイプライン |
| `Scene/GroundPrimitive.js` | 地表に張り付くプリミティブ |
| `Scene/ClassificationPrimitive.js` | 分類プリミティブ |
| `Renderer/DrawCommand.js` | 描画コマンド構造体 |
| `Renderer/ShaderProgram.js` | GLSL プログラム管理 |
| `Renderer/RenderState.js` | WebGL ステート管理 |
| `Renderer/VertexArray.js` | 頂点配列 (GPU バッファ) |
| `Renderer/Context.js` | WebGL コンテキスト (`draw()` 実行) |
