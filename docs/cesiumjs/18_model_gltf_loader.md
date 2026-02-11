# 18. Model / glTF ローダー - 3D モデル描画パイプライン

## 概要

Model は **glTF 形式の 3D モデルを描画するシステム**です。
CesiumJS における最も複雑なサブシステムの一つで、`packages/engine/Source/Scene/Model/` ディレクトリに **80以上のファイル**が存在します。

主な特徴:
- **パイプラインステージアーキテクチャ**: 約20のステージが段階的に ShaderProgram と Uniform を組み立てる
- **3階層 RenderResources**: Model → Node → Primitive の階層で描画リソースを構築
- **状態マシンベースのローダー**: GltfLoader が NOT_LOADED → READY まで7段階で非同期処理
- **Cesium3DTileset との統合**: 3D Tiles のコンテンツとして Model が使用される

## アーキテクチャ全体図

```
                    ┌─────────────────────────────┐
                    │         Model.js             │
                    │  (Primitive-level エントリ)   │
                    │  update(frameState) が起点    │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
        GltfLoader      ModelSceneGraph    ModelDrawCommands
        (glTF 解析)     (シーングラフ)      (DrawCommand 生成)
              │                │
              ▼                ▼
     ResourceCache     ModelRuntimeNode[]
     (GPU リソース)    ModelRuntimePrimitive[]
                               │
                               ▼
                      PipelineStage[] (×20)
                      (Shader/Uniform 組立)
```

## クラス階層と責務

### コアクラス

| クラス | ファイル | 責務 |
|---|---|---|
| **Model** | Model.js (~2600行) | エントリーポイント。update() でフレーム処理 |
| **ModelSceneGraph** | ModelSceneGraph.js (~800行) | glTF のシーングラフを実行時構造に変換 |
| **ModelRuntimeNode** | ModelRuntimeNode.js | 実行時ノード。transform 管理 |
| **ModelRuntimePrimitive** | ModelRuntimePrimitive.js (~350行) | 実行時プリミティブ。パイプラインステージ管理 |
| **GltfLoader** | GltfLoader.js (~700行) | glTF JSON 解析・GPU リソースロード |

### 描画コマンド生成

| クラス | 責務 |
|---|---|
| **ModelDrawCommands** | DrawCommand の生成・ラッピング |
| **ModelDrawCommand** | 単一モデルの DrawCommand（シルエット・半透明対応） |
| **ClassificationModelDrawCommand** | 分類用 DrawCommand |

### RenderResources 階層

| クラス | スコープ | 主な内容 |
|---|---|---|
| **ModelRenderResources** | Model 全体 | ShaderBuilder, UniformMap, lightingModel |
| **NodeRenderResources** | ノード単位 | modelMatrix (node transform 適用済み) |
| **PrimitiveRenderResources** | プリミティブ単位 | attributes, indices, material, boundingSphere |

### パイプラインステージ（約20個）

| ステージ | 処理内容 |
|---|---|
| **GeometryPipelineStage** | 頂点属性設定、position/normal/texcoord バインド |
| **MaterialPipelineStage** | PBR マテリアル Uniform、alpha mode、cull face |
| **LightingPipelineStage** | ライティングモデル（PBR/UNLIT）設定 |
| **MorphTargetsPipelineStage** | モーフターゲット（ブレンドシェイプ） |
| **SkinningPipelineStage** | スケルタルアニメーション |
| **DequantizationPipelineStage** | Draco 圧縮の逆量子化 |
| **CustomShaderPipelineStage** | ユーザーカスタムシェーダー注入 |
| **PickingPipelineStage** | ピッキング用 ID 設定 |
| **AlphaPipelineStage** | アルファブレンド設定 |
| **ImageryPipelineStage** | 地形イメージリーオーバーレイ |
| **FeatureIdPipelineStage** | 3D Tiles Feature ID |
| **MetadataPipelineStage** | 3D Tiles メタデータ |
| **VerticalExaggerationPipelineStage** | 垂直誇張 |
| **SceneMode2DPipelineStage** | 2D/CV モード対応 |
| **ClassificationPipelineStage** | 地形/3D Tiles 分類 |
| **WireframePipelineStage** | ワイヤフレーム表示 |
| **PrimitiveOutlinePipelineStage** | アウトライン描画 |
| **PrimitiveStatisticsPipelineStage** | 統計情報収集 |

## GltfLoader - 状態マシンベースのロード

### 状態遷移

```
NOT_LOADED ──load()──→ LOADING ──JSON取得──→ LOADED
                                               │
                                          process()
                                               │
                                               ▼
                                          PROCESSING
                                          (GPU リソース生成)
                                               │
                                               ▼
                                        POST_PROCESSING
                                        (ジオメトリ後処理)
                                               │
                                               ▼
                                          PROCESSED
                                          (BufferView 解放)
                                               │
                                               ▼
                                            READY ✓
```

### 各状態の処理内容

**LOADING → LOADED**: `loadGltfJson()`
```javascript
// GltfLoader.js L367-402
const gltfJsonLoader = ResourceCache.getGltfJsonLoader({
  gltfResource: this._gltfResource,
  baseResource: this._baseResource,
});
this._gltfJsonLoader = gltfJsonLoader;
await gltfJsonLoader.load();
// → JSON パース完了、gltf オブジェクト取得
```

**PROCESSING**: `_process()` → 各サブローダーを処理
```javascript
// GltfLoader.js L551-580
// BufferView, Geometry, Texture 等の ResourceCache ローダーを process
for (const loader of this._loaders) {
  loader.process(frameState);
}
```

**POST_PROCESSING**: ジオメトリの後処理（法線計算、バウンディングボックス等）

**PROCESSED → READY**: 不要な BufferView ローダーを解放してメモリ節約

### 主要な出力構造

GltfLoader が完了すると以下の構造を提供:

```
GltfLoader.components
  ├── scene: { nodes: [...] }
  ├── nodes: [{ name, matrix, translation, rotation, scale, children, primitives, skin }]
  ├── primitives: [{ attributes, indices, material, featureIds, morphTargets }]
  ├── materials: [{ metallicRoughness, specularGlossiness, emissiveFactor, ... }]
  ├── animations: [{ channels, samplers }]
  └── skins: [{ joints, inverseBindMatrices }]
```

## Model.update() - メインループ

**ファイル**: `Model.js` L1884-2029

```
Model.update(frameState)
  │
  ├─① processLoader(model, frameState)
  │   └── GltfLoader.process(frameState)  ← 状態マシン駆動
  │
  ├─② customShader / IBL 更新
  │   └── _customShader.update(), _environmentMapManager.update()
  │
  ├─③ リソースロード完了チェック
  │   if (!model._resourcesLoaded) return;
  │   ├── new ModelSceneGraph(model)      ← ★初回のみ
  │   └── model._readyEvent.raiseEvent() ← ready イベント発火
  │
  ├─④ buildDrawCommands()                ← ★初回 or 再構築時
  │   └── sceneGraph.buildDrawCommands(frameState)
  │
  ├─⑤ sceneGraph 更新
  │   ├── updateModelMatrix()            ← modelMatrix 変更時
  │   ├── updateSceneGraph()             ← アニメーション等
  │   └── updateShowCreditsOnScreen()
  │
  └─⑥ submitDrawCommands(frameState)
      └── sceneGraph.pushDrawCommands(frameState)
           └── frameState.commandList.push(drawCommand)  ← ★
```

### 初回 vs 毎フレーム

| 処理 | 初回 | 毎フレーム |
|---|---|---|
| processLoader | ✓（完了まで） | ✗ |
| ModelSceneGraph 生成 | ✓ | ✗ |
| buildDrawCommands | ✓ | dirty 時のみ |
| updateSceneGraph | ✓ | ✓（アニメーション等） |
| submitDrawCommands | ✓ | ✓ |

## ModelSceneGraph.buildDrawCommands() - パイプライン実行

**ファイル**: `ModelSceneGraph.js` L459-550

### 3段階のリソース構築

```
buildDrawCommands(frameState)
  │
  ├─ buildRenderResources(frameState)     ←① RenderResources 構築
  │   │
  │   │  ── Model レベル ──
  │   ├── modelRenderResources = new ModelRenderResources(model)
  │   ├── model.configurePipeline() → [ModelColorPipelineStage, IBLStage, ...]
  │   ├── stage.process(modelRenderResources, model, frameState)  × N
  │   │
  │   │  ── Node レベル ──
  │   ├── for each runtimeNode:
  │   │   ├── nodeRenderResources = new NodeRenderResources(modelRR, node)
  │   │   ├── node.configurePipeline() → (通常は空)
  │   │   ├── stage.process(nodeRenderResources, node, frameState)
  │   │   │
  │   │   │  ── Primitive レベル ──
  │   │   └── for each runtimePrimitive:
  │   │       ├── primitiveRR = new PrimitiveRenderResources(nodeRR, prim)
  │   │       ├── primitive.configurePipeline() → [GeometryStage, MaterialStage, ...]
  │   │       └── stage.process(primitiveRR, primitive, frameState)  × ~20
  │   │
  │   └── (結果: 各 primitive の PrimitiveRenderResources が完成)
  │
  ├─ computeBoundingVolumes()             ←② バウンディングボリューム計算
  │
  └─ createDrawCommands(frameState)       ←③ DrawCommand 生成
      └── for each runtimePrimitive:
          ModelDrawCommands.buildModelDrawCommand(primitiveRR, frameState)
```

### Model レベルのパイプラインステージ

```javascript
// ModelSceneGraph.js L713-759 configurePipeline()
if (model.color)           → ModelColorPipelineStage
if (iblEnabled)            → ImageBasedLightingPipelineStage
if (clippingPlanes)        → ModelClippingPlanesPipelineStage
if (clippingPolygons)      → ModelClippingPolygonsPipelineStage
if (silhouette)            → ModelSilhouettePipelineStage
if (in3DTileset)           → TilesetPipelineStage
if (atmosphereEnabled)     → AtmospherePipelineStage
```

### Primitive レベルのパイプラインステージ（約20個）

```javascript
// ModelRuntimePrimitive.js L191-342 configurePipeline()
// 条件に応じて最大20+のステージを pipelineStages 配列に追加

if (mode !== SCENE3D)          → SceneMode2DPipelineStage
                                → GeometryPipelineStage        // ★必須
if (wireframe)                 → WireframePipelineStage
if (classification)            → ClassificationPipelineStage
if (hasMorphTargets)           → MorphTargetsPipelineStage
if (hasSkinning)               → SkinningPipelineStage
if (isPointCloud && hasStyle)  → PointCloudStylingPipelineStage
if (isDequantized)             → DequantizationPipelineStage
if (hasImagery)                → ImageryPipelineStage
                                → MaterialPipelineStage         // ★必須
if (hasFeatureIds)             → FeatureIdPipelineStage
if (hasMetadata)               → MetadataPipelineStage
if (metadataPicking)           → MetadataPickingPipelineStage
if (hasSelectedFeatureIds)     → SelectedFeatureIdPipelineStage
if (hasBatchTexture)           → BatchTexturePipelineStage
if (hasCPUStyling)             → CPUStylingPipelineStage
if (verticalExaggeration)      → VerticalExaggerationPipelineStage
if (customShader)              → CustomShaderPipelineStage
                                → LightingPipelineStage         // ★必須
                                → PickingPipelineStage          // ★必須
if (hasOutline)                → PrimitiveOutlinePipelineStage
if (edgeVisibility)            → EdgeVisibilityPipelineStage
if (edgeDetection)             → EdgeDetectionPipelineStage
                                → AlphaPipelineStage            // ★必須
                                → PrimitiveStatisticsPipelineStage // ★必須
```

## パイプラインステージの処理パターン

全てのステージは同じインターフェースを持つ:

```javascript
SomePipelineStage.process = function(renderResources, primitive, frameState) {
  // 1. ShaderBuilder にシェーダーコードを追加
  const shaderBuilder = renderResources.shaderBuilder;
  shaderBuilder.addDefine("HAS_SOME_FEATURE", undefined, ShaderDestination.BOTH);
  shaderBuilder.addVertexLines("SomeStageVS");
  shaderBuilder.addFragmentLines("SomeStageFS");

  // 2. Uniform を追加
  shaderBuilder.addUniform("float", "u_someValue", ShaderDestination.FRAGMENT);
  renderResources.uniformMap.u_someValue = function() {
    return someValue;
  };

  // 3. RenderStateを変更（必要に応じて）
  renderResources.renderStateOptions.blending = BlendingState.ALPHA_BLEND;
};
```

### GeometryPipelineStage の詳細

**ファイル**: `GeometryPipelineStage.js` L60-203

```javascript
GeometryPipelineStage.process = function(renderResources, primitive, frameState) {
  // 1. 頂点属性の処理
  for (const attribute of primitive.attributes) {
    // POSITION → a_positionMC, v_positionWC, v_positionEC
    // NORMAL → a_normalMC, v_normalEC
    // TEXCOORD_0 → a_texCoord_0, v_texCoord_0
    // ... 各属性をシェーダー変数にマッピング
    processAttribute(renderResources, attribute);
  }

  // 2. インデックスバッファ設定
  if (defined(primitive.indices)) {
    renderResources.indices = primitive.indices;
  }

  // 3. プリミティブタイプ（TRIANGLES, POINTS, LINES）
  renderResources.primitiveType = primitive.primitiveType;

  // 4. GeometryStageVS/FS をシェーダーに追加
  shaderBuilder.addVertexLines("GeometryStageVS");
  shaderBuilder.addFragmentLines("GeometryStageFS");
};
```

### MaterialPipelineStage の詳細

**ファイル**: `MaterialPipelineStage.js` L52-195

```javascript
MaterialPipelineStage.process = function(renderResources, primitive, frameState) {
  const material = primitive.material;

  // 1. マテリアルタイプに応じた Uniform 設定
  if (material.metallicRoughness) {
    // baseColorFactor, metallicFactor, roughnessFactor
    // baseColorTexture, metallicRoughnessTexture
    processMetallicRoughness(renderResources, material.metallicRoughness);
  } else if (material.specularGlossiness) {
    processSpecularGlossiness(renderResources, material.specularGlossiness);
  }

  // 2. 共通マテリアル Uniform
  // normalTexture, occlusionTexture, emissiveTexture, emissiveFactor

  // 3. ライティングモデル設定
  if (material.unlit) {
    renderResources.lightingOptions.lightingModel = LightingModel.UNLIT;
  } else {
    renderResources.lightingOptions.lightingModel = LightingModel.PBR;
  }

  // 4. Alpha mode
  // OPAQUE / MASK (alphaCutoff) / BLEND

  // 5. Back-face culling
  if (!material.doubleSided) {
    renderResources.renderStateOptions.cull.enabled = true;
  }
};
```

## DrawCommand の生成

**ファイル**: `ModelDrawCommands.js` L99-192

パイプラインステージ処理完了後、PrimitiveRenderResources から DrawCommand を生成:

```javascript
function buildDrawCommandForModel(primitiveRenderResources, frameState) {
  // 1. VertexArray 生成
  const vertexArray = new VertexArray({
    context: frameState.context,
    attributes: primitiveRenderResources.attributes,
    indexBuffer: primitiveRenderResources.indices,
  });

  // 2. modelMatrix 計算
  //    Model.modelMatrix × Node.computedTransform × instancing
  const modelMatrix = Matrix4.multiplyTransformation(
    model.modelMatrix,
    primitiveRenderResources.runtimeNode.computedTransform,
    new Matrix4()
  );

  // 3. BoundingSphere 計算（modelMatrix 適用済み）
  const boundingSphere = BoundingSphere.transform(
    primitiveRenderResources.boundingSphere,
    modelMatrix,
    new BoundingSphere()
  );

  // 4. ShaderProgram 生成
  const shaderProgram = ShaderProgram.fromCache({
    context: frameState.context,
    vertexShaderSource: shaderBuilder.buildVertexShader(),
    fragmentShaderSource: shaderBuilder.buildFragmentShader(),
    attributeLocations: shaderBuilder.attributeLocations,
  });

  // 5. DrawCommand 生成
  return new DrawCommand({
    modelMatrix: modelMatrix,
    uniformMap: primitiveRenderResources.uniformMap,
    renderState: RenderState.fromCache(primitiveRenderResources.renderStateOptions),
    vertexArray: vertexArray,
    shaderProgram: shaderProgram,
    pass: primitiveRenderResources.alphaOptions.pass,  // OPAQUE or TRANSLUCENT
    boundingVolume: boundingSphere,
    // ...
  });
}
```

## Model コンストラクタの主要プロパティ

**ファイル**: `Model.js` L179-500

| プロパティ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `_loader` | GltfLoader | - | glTF ローダー |
| `type` | ModelType | GLTF | GLTF or TILESET |
| `modelMatrix` | Matrix4 | IDENTITY | モデルの変換行列 |
| `_scale` | number | 1.0 | スケール |
| `_minimumPixelSize` | number | 0.0 | 最小ピクセルサイズ |
| `_maximumScale` | number | - | 最大スケール |
| `color` | Color | - | モデル全体の色 |
| `colorBlendMode` | ColorBlendMode | HIGHLIGHT | 色の合成方法 |
| `colorBlendAmount` | number | 0.5 | 合成量 |
| `_activeAnimations` | ModelAnimationCollection | - | アクティブなアニメーション |
| `_clippingPlanes` | ClippingPlaneCollection | - | クリッピング平面 |
| `_customShader` | CustomShader | - | カスタムシェーダー |
| `_sceneGraph` | ModelSceneGraph | - | シーングラフ（ロード完了後に設定） |
| `_drawCommandsBuilt` | boolean | false | DrawCommand 構築済みフラグ |
| `_ready` | boolean | false | ロード完了フラグ |

### dirty フラグパターン

Model は多数の dirty フラグで変更を追跡し、必要な更新のみ実行:

```javascript
// 代表的な dirty フラグ
this._colorDirty = false;
this._styleDirty = false;
this._silhouetteDirty = false;
this._clippingPlanesDirty = false;
this._modelMatrixDirty = false;
this._drawCommandsBuilt = false;  // true に戻すと DrawCommand 再構築
```

## submitDrawCommands - frameState への DrawCommand 登録

**ファイル**: `Model.js` L2530-2560

```javascript
function submitDrawCommands(model, frameState) {
  // 1. 可視性チェック
  if (!model.show) return;
  if (!model._ready) return;

  // 2. BoundingSphere による視錐台カリング
  const dominated = frameState.cullingVolume.computeVisibility(
    model._boundingSphere
  );
  if (dominated === Intersect.OUTSIDE) return;

  // 3. DrawCommand を frameState に登録
  model._sceneGraph.pushDrawCommands(frameState);
}
```

`ModelSceneGraph.pushDrawCommands()` は各 ModelDrawCommand の `pushCommands()` を呼び、
最終的に `frameState.commandList.push(drawCommand)` で描画キューに登録されます。

## Cesium3DTileset との統合

3D Tiles のタイルコンテンツとして Model が使用される場合:

```
Cesium3DTileset
  └── Cesium3DTile
       └── Cesium3DTileContent (Model3DTileContent)
            └── Model (type: ModelType.TILESET)
                 └── Model.update(frameState)  ← タイルの updateContent から呼ばれる
```

### Tileset モード時の違い

| 項目 | 通常の Model | Tileset 内の Model |
|---|---|---|
| `type` | GLTF | TILESET |
| パイプライン | 標準ステージ | + TilesetPipelineStage |
| modelMatrix | ユーザー指定 | Tile の transform |
| Feature ID | なし（通常） | あり（バッチ処理用） |
| Style | なし | Cesium3DTileStyle 適用 |

## データフロー全体図

```
glTF ファイル (.glb/.gltf)
  │
  ▼
GltfLoader.load()
  ├── ResourceCache.getGltfJsonLoader()  ← JSON パース
  ├── ResourceCache.getBufferViewLoader() ← バイナリデータ
  ├── ResourceCache.getTextureLoader()    ← テクスチャ
  └── ResourceCache.getDracoLoader()      ← Draco 圧縮展開
  │
  ▼
GltfLoader.components  ← 解析済みシーン構造
  │
  ▼
ModelSceneGraph(model)  ← ランタイム構造に変換
  ├── ModelRuntimeNode[]
  │    └── computedTransform (Node ツリーの行列累積)
  └── ModelRuntimePrimitive[]
       └── pipelineStages[] (条件に応じて設定)
  │
  ▼
buildRenderResources()  ← 3階層パイプライン実行
  │
  │  Model レベル: ModelRenderResources
  │   └── [ModelColorStage, IBLStage, ClippingStage, ...]
  │
  │  Node レベル: NodeRenderResources
  │   └── modelMatrix に Node transform を合成
  │
  │  Primitive レベル: PrimitiveRenderResources
  │   └── [GeometryStage, MaterialStage, LightingStage, ...]
  │        ↓ 各ステージが ShaderBuilder + UniformMap を構築
  │
  ▼
createDrawCommands()
  └── buildDrawCommandForModel(primitiveRenderResources)
       ├── VertexArray 生成
       ├── ShaderProgram 生成 (ShaderBuilder → GLSL ソース)
       ├── RenderState 生成
       └── DrawCommand 生成
  │
  ▼
submitDrawCommands()
  └── frameState.commandList.push(drawCommand)
  │
  ▼
Scene.executeFrustumCommands()  ← WebGL 描画実行
```

## ShaderBuilder - 動的シェーダー生成

パイプラインステージは ShaderBuilder を使って段階的にシェーダーを組み立てます:

```javascript
// 各ステージが ShaderBuilder に追加していく
shaderBuilder.addDefine("HAS_NORMALS", undefined, ShaderDestination.BOTH);
shaderBuilder.addDefine("HAS_BASE_COLOR_TEXTURE", undefined, ShaderDestination.FRAGMENT);

shaderBuilder.addAttribute("vec3", "a_positionMC");
shaderBuilder.addAttribute("vec3", "a_normalMC");

shaderBuilder.addVarying("vec3", "v_positionWC");
shaderBuilder.addVarying("vec3", "v_normalEC");

shaderBuilder.addUniform("sampler2D", "u_baseColorTexture", ShaderDestination.FRAGMENT);
shaderBuilder.addUniform("vec4", "u_baseColorFactor", ShaderDestination.FRAGMENT);

// 最終的にビルド
const vertexSource = shaderBuilder.buildVertexShader();
const fragmentSource = shaderBuilder.buildFragmentShader();
```

結果として生成されるシェーダーは、有効なステージの組み合わせに応じて動的に異なります。
例: スキニング有効 + PBR + 法線マップ + ピッキング → これらのステージの GLSL が全て結合。

## ResourceCache - GPU リソースの共有管理

GltfLoader は ResourceCache を介して GPU リソースを管理します:

```
ResourceCache (シングルトン)
  ├── GltfJsonLoader    ← glTF JSON の共有キャッシュ
  ├── BufferViewLoader  ← Buffer / BufferView の共有
  ├── TextureLoader     ← テクスチャの共有（同じ URL は1回だけロード）
  ├── DracoLoader       ← Draco 展開結果の共有
  └── VertexBufferLoader / IndexBufferLoader
```

複数の Model（例: 3D Tiles の複数タイル）が同じテクスチャやバッファを参照する場合、
ResourceCache が重複ロードを防ぎ、参照カウントで管理します。

## 関連ファイル

| ファイル | 関係 |
|---|---|
| `Scene/Model/Model.js` | エントリーポイント |
| `Scene/Model/ModelSceneGraph.js` | シーングラフ管理 |
| `Scene/Model/ModelRuntimePrimitive.js` | パイプラインステージ構成 |
| `Scene/Model/ModelDrawCommands.js` | DrawCommand 生成 |
| `Scene/GltfLoader.js` | glTF 解析・ロード |
| `Scene/ResourceCache.js` | GPU リソース共有管理 |
| `Scene/Model/GeometryPipelineStage.js` | 頂点属性処理 |
| `Scene/Model/MaterialPipelineStage.js` | マテリアル処理 |
| `Scene/Model/LightingPipelineStage.js` | ライティング処理 |
| `Scene/Model/ModelRenderResources.js` | Model レベルリソース |
| `Scene/Model/NodeRenderResources.js` | Node レベルリソース |
| `Scene/Model/PrimitiveRenderResources.js` | Primitive レベルリソース |
| `Renderer/ShaderBuilder.js` | 動的シェーダー生成 |
| `Scene/Model/Model3DTileContent.js` | 3D Tiles との統合 |
