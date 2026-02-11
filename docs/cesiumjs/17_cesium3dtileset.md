# 17. Cesium3DTileset — 3D Tiles の内部構造

## 概要

Cesium3DTileset は **OGC 3D Tiles 仕様に基づく空間データのストリーミング描画エンジン**です。
都市モデル、点群、BIM/CAD データなど大規模 3D データセットを、ツリー構造のタイルとして
LOD (Level of Detail) 制御しながら段階的にロード・描画します。

```
tileset.json (ルート)
├── root (geometricError: 500)
│   ├── child_0 (geometricError: 200)
│   │   ├── child_0_0 (geometricError: 50)  ← .glb/.b3dm
│   │   └── child_0_1 (geometricError: 50)
│   └── child_1 (geometricError: 200)
│       └── child_1_0 (geometricError: 50)
```

## 主要クラスと関係

```
Cesium3DTileset
├── _root: Cesium3DTile              ← ツリーのルート
├── _cache: Cesium3DTilesetCache     ← LRU キャッシュ
├── _statistics: Cesium3DTilesetStatistics
├── _styleEngine: Cesium3DTileStyleEngine
├── _selectedTiles: Cesium3DTile[]   ← 描画選択されたタイル
├── _requestedTiles: Cesium3DTile[]  ← ロード要求されたタイル
├── _processingQueue: Cesium3DTile[] ← 処理中タイル
└── getTraversal() → Traversal       ← トラバーサル戦略

Cesium3DTile
├── children: Cesium3DTile[]
├── parent: Cesium3DTile
├── _content: Cesium3DTileContent    ← glTF Model 等
├── _boundingVolume: TileBoundingVolume
├── geometricError: number
├── refine: REPLACE | ADD
├── transform / computedTransform
└── cacheNode: DoublyLinkedListNode  ← LRU キャッシュノード

Cesium3DTilesetTraversal (基底)
├── Cesium3DTilesetBaseTraversal     ← 標準トラバーサル
├── Cesium3DTilesetSkipTraversal     ← LOD スキップ
└── Cesium3DTilesetMostDetailedTraversal  ← 最高精度
```

## Cesium3DTileset コンストラクタ

**ファイル**: `packages/engine/Source/Scene/Cesium3DTileset.js` L202-1079

### 主要パラメータ

| パラメータ | デフォルト | 説明 |
|---|---|---|
| `maximumScreenSpaceError` | 16 | **SSE 閾値** — 小さいほど高精度（タイル数増加） |
| `cacheBytes` | 512 MB | タイルキャッシュの目標サイズ |
| `maximumCacheOverflowBytes` | 512 MB | キャッシュの最大超過許容量 |
| `dynamicScreenSpaceError` | true | 水平線付近の解像度を下げる最適化 |
| `foveatedScreenSpaceError` | true | 画面中央優先ロード |
| `skipLevelOfDetail` | false | LOD レベルスキップ |
| `cullRequestsWhileMoving` | true | カメラ移動中の不要リクエスト抑制 |
| `progressiveResolutionHeightFraction` | 0.3 | 低解像度タイルの先行表示 |
| `preloadFlightDestinations` | true | カメラ飛行先のプリロード |
| `shadows` | ShadowMode.ENABLED | シャドウモード |

### 内部状態

```javascript
this._selectedTiles = [];       // トラバーサルで選択されたタイル
this._requestedTiles = [];      // ロード要求キュー
this._processingQueue = [];     // コンテンツ処理中キュー
this._requestedTilesInFlight = []; // リクエスト中タイル

this._memoryAdjustedScreenSpaceError = this._maximumScreenSpaceError;
// ↑ メモリ圧力で動的に調整される SSE
```

## Cesium3DTile — タイルノード

**ファイル**: `packages/engine/Source/Scene/Cesium3DTile.js` L60-535

### 重要プロパティ

| プロパティ | 型 | 説明 |
|---|---|---|
| `geometricError` | number | **このタイルの幾何誤差（メートル）** |
| `refine` | Cesium3DTileRefine | **REPLACE**（子で置換）or **ADD**（子を追加） |
| `transform` | Matrix4 | ローカル変換行列 |
| `computedTransform` | Matrix4 | 親を含む累積変換 |
| `_boundingVolume` | TileBoundingVolume | バウンディングボリューム（Box/Region/Sphere） |
| `_contentBoundingVolume` | TileBoundingVolume | コンテンツのタイトなバウンディング |
| `_content` | Cesium3DTileContent | 描画コンテンツ（Model 等） |
| `_contentState` | ContentState | UNLOADED → LOADING → PROCESSING → READY / FAILED |
| `children` | Cesium3DTile[] | 子タイル配列 |
| `parent` | Cesium3DTile | 親タイル |
| `cacheNode` | DoublyLinkedListNode | LRU キャッシュ内のノード |

### フレームごとの更新値

```javascript
this._distanceToCamera = 0.0;    // カメラまでの距離
this._screenSpaceError = 0.0;    // 計算された SSE
this._visible = false;           // 可視性
this._depth = 0;                 // ツリー内の深さ
this._priority = 0.0;            // リクエスト優先度
this._foveatedFactor = 0.0;      // 中心からの離れ度（foveated 用）
```

### Refinement（細分化戦略）

```
REPLACE モード:
  親タイル（低精度） → 全子タイル準備完了 → 親を非表示、子を表示
  ※ 子が全てロードされるまで親を表示し続ける

ADD モード:
  親タイル（粗いデータ） + 子タイル（詳細データ） = 両方表示
  ※ 点群などで使用 — 親の点群に子の点群を追加
```

## Screen Space Error (SSE) 計算

**ファイル**: `Cesium3DTile.js` L910-960

```javascript
getScreenSpaceError(frameState, useParentGeometricError, heightFraction) {
  const geometricError = useParentGeometricError
    ? parent.geometricError    // 親の誤差（ルートの場合は tileset の誤差）
    : this.geometricError;

  if (geometricError === 0.0) return 0.0;  // 葉タイル

  // 透視投影: SSE = (geometricError × height) / (distance × sseDenominator)
  const distance = Math.max(this._distanceToCamera, EPSILON7);
  error = (geometricError * height) / (distance * sseDenominator);

  // Dynamic SSE: 水平線付近で SSE を減算 → 低解像度で済ませる
  if (tileset.dynamicScreenSpaceError) {
    const dynamicError = fog(distance, density) * factor;
    error -= dynamicError;
  }

  error /= frameState.pixelRatio;
  return error;
}
```

### canTraverse — 子タイルに降りるか判定

**ファイル**: `Cesium3DTilesetTraversal.js` L57-67

```javascript
canTraverse(tile) {
  if (tile.children.length === 0) return false;             // 葉
  if (tile.hasTilesetContent || tile.hasImplicitContent) {
    return !tile.contentExpired;                            // 外部タイルセット
  }
  return tile._screenSpaceError > tileset.memoryAdjustedScreenSpaceError;
  // ↑ SSE が閾値を超えている → もっと精細なタイルが必要 → 子へ降りる
}
```

## トラバーサル — タイル選択アルゴリズム

### 3つのトラバーサル戦略

**ファイル**: `Cesium3DTileset.js` L3465-3476

```javascript
getTraversal(passOptions) {
  if (pass === MOST_DETAILED_PRELOAD || pass === MOST_DETAILED_PICK) {
    return Cesium3DTilesetMostDetailedTraversal;  // ピッキング用
  }
  return this.isSkippingLevelOfDetail
    ? Cesium3DTilesetSkipTraversal    // LOD スキップ有効
    : Cesium3DTilesetBaseTraversal;   // ★ 標準トラバーサル
}
```

### BaseTraversal.selectTiles()

**ファイル**: `Cesium3DTilesetBaseTraversal.js` L34-71

```
selectTiles(tileset, frameState)
    │
    ├── リストクリア: _selectedTiles, _requestedTiles, _emptyTiles
    │
    ├── root タイルを updateTile() で更新
    │
    ├── root が不可視 or SSE ≤ 閾値 → return（何も描画しない）
    │
    ├── ★ executeTraversal(root, frameState)
    │
    └── requestedTiles の優先度を更新・正規化
```

### executeTraversal — 深さ優先探索

**ファイル**: `Cesium3DTilesetBaseTraversal.js` L188-235

```
stack.push(root)
while (stack.length > 0) {
    tile = stack.pop()
    │
    ├── canTraverse(tile)?
    │   ├── YES → updateAndPushChildren(tile, stack)
    │   │         → 可視な子をスタックに push
    │   │         → REPLACE の場合、全子の contentAvailable を確認
    │   │         → refines = 全子が準備完了
    │   │
    │   └── NO  → tile._refines = false（これ以上降りない）
    │
    ├── stoppedRefining = !tile._refines && parentRefines
    │
    ├── Refinement 別の処理:
    │   ├── hasRenderableContent === false（空タイル）
    │   │   → loadTile + stoppedRefining なら selectDesiredTile
    │   │
    │   ├── refine === ADD
    │   │   → ★ 常に selectDesiredTile + loadTile
    │   │
    │   └── refine === REPLACE
    │       → loadTile + stoppedRefining なら selectDesiredTile
    │
    ├── visitTile(tile)    → 統計カウント
    └── touchTile(tile)    → LRU キャッシュ更新
}
```

### updateAndPushChildren — 子タイルの処理

**ファイル**: `Cesium3DTilesetBaseTraversal.js` L93-177

```
updateAndPushChildren(tile, stack, frameState)
    │
    ├── 全子タイルを updateTile() で可視性更新
    │
    ├── 距離でソート（early-Z 最適化）
    │
    ├── 各子タイル:
    │   ├── isVisible → stack.push(child)
    │   │
    │   └── !isVisible && (checkRefines || loadSiblings)
    │       → 非可視でもロード（REPLACE の場合、親の解除に必要）
    │
    ├── REPLACE 細分化チェック:
    │   → 全可視子が contentAvailable なら refines = true
    │   → 1つでも未ロード → refines = false → 親を表示し続ける
    │
    └── 優先度チェーン（foveated 最適化）
        → 最も近い子の優先度を祖先に伝播
```

### タイル可視性判定

**ファイル**: `Cesium3DTilesetTraversal.js` L207-242

```
updateTileVisibility(tile, frameState)
    │
    ├── tile.updateVisibility(frameState)
    │   → バウンディングボリューム vs カリングボリューム
    │   → viewerRequestVolume チェック
    │   → SSE 計算・距離計算
    │
    ├── 外部タイルセット → 子（ルート）の可視性を使用
    │
    ├── meetsScreenSpaceErrorEarly → SSE が小さすぎ → 不可視
    │
    └── REPLACE + 子の結合バウンディング最適化
        → 全子が不可視 → 親も不可視
```

## ロード・リクエストパイプライン

### フレーム内の処理順序

```
Scene.render()
    │
    ├── prePassesUpdate()        ①
    │   ├── processTiles()       ← 処理中タイルの progress
    │   │   └── tile.process()   ← コンテンツのデコード・構築
    │   │   └── メモリ圧力チェック → SSE 動的調整
    │   │
    │   ├── clippingPlanes.update()
    │   ├── updateDynamicScreenSpaceError()
    │   └── cache.reset()        ← sentinel をリストの先頭に移動
    │
    ├── updateForPass()          ②
    │   └── update()
    │       ├── traversal.selectTiles()  ← ★ タイル選択
    │       ├── requestTiles()           ← ★ ロードリクエスト発行
    │       └── updateTiles()            ← ★ 選択タイルの描画
    │
    └── postPassesUpdate()       ③
        ├── cancelOutOfViewRequests()   ← 画面外タイルのリクエスト取消
        ├── raiseLoadProgressEvent()
        └── cache.unloadTiles()         ← ★ LRU アンロード
```

### requestTiles — リクエスト発行

**ファイル**: `Cesium3DTileset.js` L2735-2741

```javascript
function requestTiles(tileset) {
  const requestedTiles = tileset._requestedTiles;
  requestedTiles.sort(sortTilesByPriority);  // ★ 優先度順ソート
  for (let i = 0; i < requestedTiles.length; ++i) {
    requestContent(tileset, requestedTiles[i]);
  }
}
```

### requestContent — コンテンツ取得

**ファイル**: `Cesium3DTileset.js` L2590-2626

```
requestContent(tileset, tile)
    │
    ├── tile.requestContent()
    │   ├── requestSingleContent(tile)    ← 単一コンテンツ
    │   └── requestMultipleContents(tile) ← 複数コンテンツ
    │
    ├── promise.then(content =>
    │     tileset._processingQueue.push(tile)  ← 処理キューに追加
    │   )
    │
    └── tileset._requestedTilesInFlight.push(tile)
```

### processTiles — コンテンツ処理

**ファイル**: `Cesium3DTileset.js` L2857-2890

```
processTiles(tileset, frameState)
    │
    ├── メモリ上限チェック: totalMemoryUsageInBytes > cacheBytes + maxOverflow
    │
    ├── 各タイル: tile.process(tileset, frameState)
    │   → ArrayBuffer → glTF → Model → DrawCommand
    │   → contentReady → tileLoad イベント発火
    │
    └── ★ メモリ動的調整:
        ├── メモリ < cacheBytes → decreaseScreenSpaceError()
        │   → memoryAdjustedSSE = max(memoryAdjustedSSE / 1.02, maximumSSE)
        │
        └── メモリ超過 → increaseScreenSpaceError()
            → memoryAdjustedSSE *= 1.02  ← SSE を上げて精度を下げる
```

## LRU キャッシュ

**ファイル**: `packages/engine/Source/Scene/Cesium3DTilesetCache.js`

### データ構造

```
DoublyLinkedList:
  [head] ← LRU (最も古い) ... [sentinel] ... MRU (最も新しい) → [tail]

  ← unloadTiles() はここから削除     touch() でここに移動 →
```

- **sentinel**: 使用中/未使用の境界ノード
- **touch(tile)**: タイルが今フレームで使われた → sentinel の右に移動（MRU）
- **reset()**: sentinel をリストの先頭に移動 → 全タイルが「未使用」扱い
- **unloadTiles()**: head から sentinel まで走査、`totalMemoryUsageInBytes > cacheBytes` の間アンロード

### アンロード判定

```
postPassesUpdate()
  └── cache.unloadTiles(tileset, unloadCallback)
        │
        ├── head から sentinel まで（= 今フレーム未使用タイル）を走査
        │
        ├── totalMemoryUsageInBytes > cacheBytes の間、古い順にアンロード
        │
        └── unloadTile(tileset, tile)
              → tile.unloadContent()
              → tileset.tileUnload.raiseEvent(tile)
```

## Dynamic Screen Space Error

**ファイル**: `Cesium3DTileset.js` L2486-2583

水平線付近のタイルの SSE を下げて、ロード量を減らす最適化。

```
カメラ高さ:  high → density 減少（最適化弱い）
             low  → density 増加（最適化強い）

カメラ方向:  上向き → horizonFactor 小（最適化弱い）
             水平   → horizonFactor 大（最適化強い）

computedDensity = dynamicScreenSpaceErrorDensity × horizonFactor × (1 - t)
  where t = clamp((height - heightClose) / (heightFar - heightClose), 0, 1)

// SSE 計算時に適用:
error = (geometricError × screenHeight) / (distance × sseDenominator)
error -= fog(distance, computedDensity) × dynamicScreenSpaceErrorFactor
```

## Foveated Rendering（中心視野優先）

画面中央のタイルを優先的にロードし、画面端のタイルは遅延ロードする。

### パラメータ

| パラメータ | デフォルト | 説明 |
|---|---|---|
| `foveatedScreenSpaceError` | true | 有効/無効 |
| `foveatedConeSize` | 0.1 | 中心コーンの半径（0-1） |
| `foveatedMinimumScreenSpaceErrorRelaxation` | 0.0 | 端のSSE緩和最小値 |
| `foveatedTimeDelay` | 0.2秒 | カメラ停止後のロード遅延 |

### ロード優先度の決定

```
tile._priority = 計算結果 (低い値 = 高優先度)

優先度要素:
1. foveatedFactor: 画面中央からの角度 (0=中央, 1=端)
2. distance: カメラまでの距離
3. depth: ツリー内の深さ
4. reverseScreenSpaceError: SSE の逆数

requestedTiles.sort(sortTilesByPriority)  → 優先度順にリクエスト
```

## updateTiles — 描画コマンド生成

**ファイル**: `Cesium3DTileset.js` L3078-3211

```
updateTiles(tileset, frameState, passOptions)
    │
    ├── styleEngine.applyStyle()  ← Cesium3DTileStyle の適用
    │
    ├── 各 selectedTile:
    │   ├── tileVisible.raiseEvent(tile)
    │   ├── tile.update(tileset, frameState, passOptions)
    │   │   └── updateContent(tile, ...)
    │   │       └── tile.content.update(tileset, frameState)
    │   │           └── ★ Model.update() → DrawCommand を commandList に push
    │   └── statistics.incrementSelectionCounts()
    │
    └── skipLevelOfDetail + mixedContent の場合:
        → stencil バッファで bivariate visibility test
        → 背面コマンドを先に描画（z バッファ構築）
        → 前面コマンドは stencil テストで祖先/子孫の重複を解決
```

### Tile.update() の内部

**ファイル**: `Cesium3DTile.js` L2244-2264

```javascript
Cesium3DTile.prototype.update = function(tileset, frameState, passOptions) {
  updateClippingPlanes(this, tileset);
  updateClippingPolygons(this, tileset);
  applyDebugSettings(this, tileset, frameState, passOptions);
  updateContent(this, tileset, frameState);
  // → tile.content.update(tileset, frameState)
  //   → Model が DrawCommand を frameState.commandList に push
};
```

## tileset.json のロード

**ファイル**: `Cesium3DTileset.js` L2293-2362

```
loadTileset(resource, tilesetJson, parentTile)
    │
    ├── バージョンチェック (0.0, 1.0, 1.1)
    ├── 拡張機能チェック
    │
    ├── rootTile = makeTile(this, resource, tilesetJson.root, parentTile)
    │
    └── スタックベースの深さ優先走査:
        while (stack.length > 0) {
          tile = stack.pop()
          → tile._header.children を走査
          → makeTile() で Cesium3DTile を生成
          → tile.children.push(childTile)
          → childTile._depth = tile._depth + 1
          → stack.push(childTile)
        }
```

**ポイント**: tileset.json のロード時に**ツリー全体の構造**（バウンディング、geometricError、refine）が
メモリに構築される。コンテンツ（.glb 等）は**オンデマンド**でロードされる。

## 全体フロー図

```
[初回ロード]
Cesium3DTileset.fromUrl("tileset.json")
  → JSON パース → loadTileset() → ツリー構築（Cesium3DTile ノード群）
  → root._contentState = UNLOADED

[毎フレーム]
Scene.render()
  │
  ├── prePassesUpdate()
  │   ├── processTiles()           ← LOADING → READY 遷移
  │   ├── dynamicScreenSpaceError  ← SSE 調整パラメータ計算
  │   └── cache.reset()            ← LRU sentinel リセット
  │
  ├── update(frameState)
  │   ├── selectTiles()            ← ツリートラバーサル
  │   │   ├── updateTileVisibility ← カリング・SSE 計算
  │   │   ├── canTraverse?         ← SSE > 閾値 → 子へ降りる
  │   │   ├── selectTile()         ← _selectedTiles に追加
  │   │   ├── loadTile()           ← _requestedTiles に追加
  │   │   └── touchTile()          ← LRU キャッシュ更新
  │   │
  │   ├── requestTiles()           ← 優先度順でリクエスト発行
  │   │   └── tile.requestContent() → HTTP fetch → _processingQueue
  │   │
  │   └── updateTiles()            ← 選択タイルの DrawCommand 生成
  │       └── tile.content.update() → commandList.push(drawCommand)
  │
  └── postPassesUpdate()
      ├── cancelOutOfViewRequests() ← 画面外リクエスト取消
      └── cache.unloadTiles()       ← メモリ超過タイルのアンロード
```

## パフォーマンスチューニング

### maximumScreenSpaceError

| 値 | 効果 |
|---|---|
| 16（デフォルト） | 品質とパフォーマンスのバランス |
| 2-8 | 高品質 — タイル数増加、メモリ・帯域増 |
| 32-64 | 低品質 — 高速ロード、メモリ節約 |

### メモリ管理

```
cacheBytes (デフォルト 512MB)
  → 目標キャッシュサイズ。超過すると LRU でアンロード。

maximumCacheOverflowBytes (デフォルト 512MB)
  → キャッシュ超過の許容量。
  → 超過すると memoryAdjustedScreenSpaceError が 1.02 倍ずつ増加
  → メモリ使用量 < cacheBytes になると SSE が戻る
```

### 最適化オプション

| オプション | 効果 |
|---|---|
| `dynamicScreenSpaceError` | 水平線付近の LOD を下げる |
| `foveatedScreenSpaceError` | 画面中央を優先ロード |
| `cullRequestsWhileMoving` | カメラ移動中のリクエスト抑制 |
| `skipLevelOfDetail` | LOD レベルをスキップ（メモリ大幅削減） |
| `preloadFlightDestinations` | カメラ飛行先のプリロード |
| `progressiveResolutionHeightFraction` | 低解像度タイルの先行表示 |

## 関連ファイル

| ファイル | 説明 |
|---|---|
| `Scene/Cesium3DTileset.js` | メインクラス（~3600行） |
| `Scene/Cesium3DTile.js` | タイルノード（~2300行） |
| `Scene/Cesium3DTilesetTraversal.js` | トラバーサル基底クラス |
| `Scene/Cesium3DTilesetBaseTraversal.js` | 標準トラバーサル |
| `Scene/Cesium3DTilesetSkipTraversal.js` | LOD スキップトラバーサル |
| `Scene/Cesium3DTilesetMostDetailedTraversal.js` | 最高精度トラバーサル |
| `Scene/Cesium3DTilesetCache.js` | LRU キャッシュ |
| `Scene/Cesium3DTilesetStatistics.js` | 統計情報 |
| `Scene/Cesium3DTileStyleEngine.js` | スタイルエンジン |
| `Scene/Cesium3DTileContentState.js` | コンテンツ状態遷移 |
| `Scene/Cesium3DTileRefine.js` | REPLACE / ADD 列挙 |
| `Scene/Cesium3DTilePass.js` | パス種別 |
| `Scene/TileBoundingRegion.js` | Region バウンディング |
| `Scene/TileOrientedBoundingBox.js` | OBB バウンディング |
| `Scene/TileBoundingSphere.js` | Sphere バウンディング |
| `Scene/Model/Model.js` | glTF コンテンツ描画 |
