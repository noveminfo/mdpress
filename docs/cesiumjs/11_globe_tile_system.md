# 11. Globe - タイルベース地球描画システム

## 概要

Globe は CesiumJS の地球描画を担当するコンポーネントです。
地球全体を一度に高解像度で描画することは不可能なため、**Quadtree（四分木）タイルシステム**で
カメラに近い領域だけを高解像度で描画し、遠い領域は低解像度にする LOD（Level of Detail）を実現しています。

## クラス構成

```
Globe
 ├── _surface: QuadtreePrimitive        ← タイル選択・管理
 │    ├── _tileProvider: GlobeSurfaceTileProvider  ← タイル描画・ロード
 │    └── _tilesToRender: QuadtreeTile[]           ← 選択されたタイル群
 ├── _terrainProvider: TerrainProvider   ← 地形データソース
 ├── _imageryLayerCollection: ImageryLayerCollection  ← 衛星画像レイヤー
 └── 各種描画設定（大気、海洋、ライティング等）
```

### 役割分担

| クラス | 役割 |
|---|---|
| **Globe** | 設定の保持、フレームフックの委譲 |
| **QuadtreePrimitive** | タイル選択アルゴリズム（どのタイルを描画するか） |
| **GlobeSurfaceTileProvider** | タイルのロード・DrawCommand 生成（どう描画するか） |
| **QuadtreeTile** | 個々のタイルのデータ構造 |

## フレームごとの描画フロー

```
Scene.render()
  └── Globe.beginFrame()          ← 設定同期
  └── Globe.render()
       └── QuadtreePrimitive.render()
            ├── tileProvider.beginUpdate()
            ├── selectTilesForRendering()   ← ★ タイル選択
            ├── createRenderCommandsForSelectedTiles()
            │    └── tileProvider.showTileThisFrame(tile)  ← テクスチャ数でグループ化
            └── tileProvider.endUpdate()
                 └── addDrawCommandsForTile()  ← ★ DrawCommand 生成
  └── Globe.endFrame()
```

## Globe.js の構造

**ファイル**: `packages/engine/Source/Scene/Globe.js` (~1100行)

### コンストラクタ (L41-372)

```javascript
function Globe(ellipsoid) {
  const terrainProvider = new EllipsoidTerrainProvider({ ellipsoid });
  const imageryLayerCollection = new ImageryLayerCollection();

  // GlobeSurfaceTileProvider = タイル描画担当
  this._surface = new QuadtreePrimitive({
    tileProvider: new GlobeSurfaceTileProvider({
      terrainProvider,
      imageryLayers: imageryLayerCollection,
      surfaceShaderSet: new GlobeSurfaceShaderSet(),
    }),
  });

  // 描画設定
  this._terrainProvider = terrainProvider;
  this._imageryLayerCollection = imageryLayerCollection;
  this.showGroundAtmosphere = true;
  this.enableLighting = false;
  this.showWaterEffect = true;
  this.maximumScreenSpaceError = 2;  // LOD 品質設定
  // ... 多数の視覚設定
}
```

### beginFrame (L971-1060)

Globe のプロパティを tileProvider に同期する:

```javascript
Globe.prototype.beginFrame = function(frameState) {
  // Globe の設定を tileProvider に転写
  tileProvider.terrainProvider = this._terrainProvider;
  tileProvider.lightingFadeOutDistance = this.lightingFadeOutDistance;
  tileProvider.showWaterEffect = this.showWaterEffect;
  // ... 約30個のプロパティを転写

  surface.beginFrame(frameState);
};
```

**設計意図**: Globe は「設定の窓口」、描画の実体は QuadtreePrimitive + GlobeSurfaceTileProvider。

### render / update / endFrame

全て `_surface` に委譲するだけ:

```javascript
Globe.prototype.update = function(frameState) {
  this._surface.update(frameState);      // タイルロードキュー処理
};
Globe.prototype.render = function(frameState) {
  this._surface.render(frameState);      // タイル選択 + 描画コマンド生成
};
Globe.prototype.endFrame = function(frameState) {
  this._surface.endFrame(frameState);    // クリーンアップ
};
```

## QuadtreePrimitive - タイル選択エンジン

**ファイル**: `packages/engine/Source/Scene/QuadtreePrimitive.js`

### render() の流れ (L357-373)

```javascript
QuadtreePrimitive.prototype.render = function(frameState) {
  tileProvider.beginUpdate(frameState);

  selectTilesForRendering(this, frameState);        // タイル選択
  createRenderCommandsForSelectedTiles(this, frameState); // 描画準備

  tileProvider.endUpdate(frameState);               // DrawCommand 生成
};
```

### selectTilesForRendering() (L503-606)

タイル選択アルゴリズムの入口:

```
1. Level 0 タイル群を取得（通常 2枚: 東半球 + 西半球）
2. カメラからの距離でソート（近い順）
3. 各タイルを深さ優先で走査 → visitTile()
```

```javascript
function selectTilesForRendering(primitive, frameState) {
  // Level 0 タイルの取得/生成
  let levelZeroTiles = primitive._levelZeroTiles;
  if (!defined(levelZeroTiles)) {
    levelZeroTiles = QuadtreeTile.createLevelZeroTiles(tilingScheme);
    primitive._levelZeroTiles = levelZeroTiles;
  }

  // カメラ距離でソート
  primitive._tileProvider.computeDistanceToTile(tile, frameState);
  levelZeroTiles.sort(%.._distance比較);

  // 各ルートタイルから深さ優先探索
  for (let i = 0; i < levelZeroTiles.length; ++i) {
    if (%.._%.visitIfVisible(tile)) {
      visitTile(primitive, frameState, tile, ...);
    }
  }
}
```

### visitTile() - LOD 判定の核心 (L713-986)

各タイルに対して **「描画」「分割」「スキップ」** のいずれかを判定:

```
visitTile(tile)
  │
  ├── SSE <= maximumScreenSpaceError?
  │    └── YES → RENDERED (このタイルを描画)
  │
  ├── NO → 子タイルに分割可能か?
  │    ├── 全子タイルが renderable
  │    │    └── REFINED → 4つの子タイルを再帰的に visit
  │    │
  │    └── 一部/全部の子タイルが未ロード
  │         ├── このタイル自体が renderable
  │         │    └── RENDERED + 子タイルをロードキューに追加
  │         └── renderable でない
  │              └── KICKED → 親タイルで代替描画
  │
  └── ロードキューへの追加（High/Medium/Low 優先度）
```

### Screen Space Error (SSE) の計算 (L1247-1273)

LOD 判定の数値基準。タイルの「画面上での誤差ピクセル数」を計算:

```javascript
function screenSpaceError(primitive, frameState, tile) {
  const maxGeometricError =
    primitive._tileProvider.getLevelMaximumGeometricError(tile.level);
  const distance = tile._distance;
  const height = frameState.context.drawingBufferHeight;
  const sseDenominator = frameState.camera.frustum.sseDenominator;

  // 核心の公式: SSE = (幾何誤差 × 画面高さ) / (距離 × sseDenominator)
  let error = (maxGeometricError * height) / (distance * sseDenominator);

  // 霧による減衰（遠くのタイルは霧で隠れるので誤差を減らす）
  if (frameState.fog.enabled) {
    error -= CesiumMath.fog(distance, frameState.fog.density) * frameState.fog.sse;
  }

  error /= frameState.pixelRatio;  // HiDPI 対応
  return error;
}
```

**判定**: `SSE > maximumScreenSpaceError（デフォルト: 2px）` なら分割が必要。

**直感的理解**:
- `maxGeometricError`: タイルレベルごとの地形の最大誤差（メートル）。高レベルほど小さい
- 近いタイル → distance 小 → SSE 大 → 分割される → 高解像度
- 遠いタイル → distance 大 → SSE 小 → そのまま描画 → 低解像度

### タイルロードキュー (L1310-1354)

3段階の優先度キューでタイルデータをロード:

```javascript
function processTileLoadQueue(primitive, frameState) {
  // 不要タイルの解放
  primitive._tileReplacementQueue.trimTiles(primitive.tileCacheSize);

  const endTime = getTimestamp() + primitive._loadQueueTimeSlice;

  // High → Medium → Low の優先度順でロード
  // 時間制限内で処理（フレーム落ちを防ぐ）
  processSinglePriorityLoadQueue(..., tileLoadQueueHigh, ...);
  processSinglePriorityLoadQueue(..., tileLoadQueueMedium, ...);
  processSinglePriorityLoadQueue(..., tileLoadQueueLow, ...);
}
```

| 優先度 | 用途 |
|---|---|
| **High** | 現在描画中だが子タイルが必要なタイル |
| **Medium** | 直近で必要になりそうなタイル |
| **Low** | プリフェッチ |

## QuadtreeTile - タイルデータ構造

**ファイル**: `packages/engine/Source/Scene/QuadtreeTile.js`

```javascript
function QuadtreeTile(options) {
  this._tilingScheme = options.tilingScheme;
  this._x = options.x;            // 列番号
  this._y = options.y;            // 行番号
  this._level = options.level;    // ズームレベル
  this._parent = options.parent;
  this._rectangle = tilingScheme.tileXYToRectangle(x, y, level);

  // 4つの子タイル（遅延生成）
  this._southwestChild = undefined;
  this._southeastChild = undefined;
  this._northwestChild = undefined;
  this._northeastChild = undefined;

  this._distance = 0.0;           // カメラからの距離
  this._loadPriority = 0.0;       // ロード優先度

  this.state = QuadtreeTileLoadState.START;  // ロード状態
  this.renderable = false;        // 描画可能か
  this.upsampledFromParent = false; // 親からアップサンプルされたか
  this.data = undefined;          // GlobeSurfaceTile（地形+画像データ）
}
```

### タイル座標系

```
Level 0:  2枚（東/西半球）
Level 1:  8枚（2×4）
Level 2:  32枚（4×8）
...
Level n:  2^n × 2^(n+1) 枚

タイル(x, y, level) → 地理的矩形 (Rectangle)
  tilingScheme.tileXYToRectangle(x, y, level)
```

## GlobeSurfaceTileProvider - DrawCommand 生成

**ファイル**: `packages/engine/Source/Scene/GlobeSurfaceTileProvider.js` (~2900行)

### showTileThisFrame() (L1088-1122)

タイルをテクスチャ数でグループ化:

```javascript
GlobeSurfaceTileProvider.prototype.showTileThisFrame = function(tile, frameState) {
  // テクスチャ数をカウント（画像レイヤーの枚数）
  let readyTextureCount = 0;
  for (imagery of tile.data.imagery) {
    if (imagery.readyImagery && imagery.readyImagery.imageryLayer.alpha !== 0) {
      ++readyTextureCount;
    }
  }

  // テクスチャ数ごとのバケットに分類
  this._tilesToRenderByTextureCount[readyTextureCount].push(tile);
};
```

**なぜグループ化するか**: 同じテクスチャ数のタイルは同じシェーダーバリアントを使えるため、
シェーダー切替コストを削減できる。

### endUpdate() → addDrawCommandsForTile()

`endUpdate()` (L442-554) がテクスチャ数順にソートされたタイル群を走査し、
各タイルに対して `addDrawCommandsForTile()` (L2126-2908) を呼ぶ。

`addDrawCommandsForTile()` は ~780行の巨大関数で、以下を行う:

```
1. 地形メッシュの取得（vertexArray or TerrainFillMesh）
2. Uniform 設定
   - 初期色、海洋ノーマルマップ、ライティング距離
   - 大気パラメータ（Rayleigh/Mie 散乱）
   - 地下色、垂直誇張、クリッピング
3. 画像テクスチャのバインド（do-while ループ）
   - maxTextures 制限内で dayTextures[] にセット
   - 各レイヤーの alpha/brightness/contrast/hue/saturation/gamma
   - カットアウト矩形、colorToAlpha
4. シェーダープログラムの選択
   - surfaceShaderSet.getShaderProgram(options)
   - テクスチャ数・エフェクト有無でバリアント選択
5. DrawCommand の組み立て
   command.vertexArray = surfaceTile.vertexArray;
   command.shaderProgram = selected shader;
   command.pass = Pass.GLOBE;
   command.uniformMap = uniformMap;
6. frameState.commandList に push
```

### シェーダーバリアント

GlobeSurfaceTileProvider は **30以上のシェーダーオプション** を組み合わせて
最適なシェーダーを動的に選択する:

| オプション | 内容 |
|---|---|
| numberOfDayTextures | 衛星画像テクスチャ数 |
| enableFog | 霧エフェクト |
| enableLighting | 太陽光ライティング |
| showGroundAtmosphere | 地上大気 |
| showReflectiveOcean | 反射海洋 |
| showOceanWaves | 海洋波ノーマルマップ |
| hasVertexNormals | 頂点法線（地形影） |
| enableClippingPlanes | クリッピング平面 |
| enableClippingPolygons | クリッピングポリゴン |
| hasExaggeration | 垂直誇張 |
| translucent | 半透明地球 |
| colorCorrect | 色補正（HSB シフト） |

## タイル選択の全体像

```
                    Level 0
               ┌──────┴──────┐
            tile(0,0)     tile(1,0)
           ┌──┴──┐       ┌──┴──┐
          ↙ ↘   ↙ ↘    ↙ ↘   ↙ ↘    Level 1
         ...  ...             ...

カメラに近い方から深さ優先探索:

  tile → SSE 計算 → SSE > 閾値?
    │
    ├─ NO  → 「RENDERED」(この解像度で十分)
    │         → _tilesToRender に追加
    │
    └─ YES → 子タイル4枚を確認
              │
              ├─ 全部 renderable → 「REFINED」
              │   → 4子タイルを再帰的に visit
              │
              └─ 一部未ロード → 「このタイルで仮描画」
                  → 子タイルをロードキューに追加
                  → 次フレームで子タイルが利用可能に
```

## パフォーマンスチューニング

### maximumScreenSpaceError

```javascript
viewer.scene.globe.maximumScreenSpaceError = 2;  // デフォルト（高品質）
viewer.scene.globe.maximumScreenSpaceError = 4;  // 低品質（タイル数半減）
```

- 値を大きくする → SSE 閾値が上がる → タイル分割が少ない → 描画タイル数減少
- 値を小さくする → より高解像度だがタイル数・メモリ増加

### tileCacheSize

```javascript
viewer.scene.globe.tileCacheSize = 100;  // デフォルト
```

- 使い終わったタイルのキャッシュ数
- 大きくするとメモリ使用量増加だが再訪時のロード削減

### 時間スライス

`_loadQueueTimeSlice` でフレームあたりのタイルロード時間を制限し、フレーム落ちを防止。

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `Scene/Globe.js` | 設定窓口、フレームフック委譲 |
| `Scene/QuadtreePrimitive.js` | タイル選択アルゴリズム |
| `Scene/QuadtreeTile.js` | タイルデータ構造 |
| `Scene/GlobeSurfaceTileProvider.js` | タイルロード・DrawCommand生成 |
| `Scene/GlobeSurfaceTile.js` | タイルの地形+画像データ |
| `Scene/GlobeSurfaceShaderSet.js` | シェーダーバリアント管理 |
| `Scene/ImageryLayer.js` | 画像レイヤー（衛星写真等） |
| `Scene/TerrainFillMesh.js` | 未ロードタイルの穴埋めメッシュ |
| `Scene/TileBoundingRegion.js` | タイルのバウンディングボリューム |
| `Scene/QuadtreeTileLoadState.js` | タイルロード状態列挙 |
