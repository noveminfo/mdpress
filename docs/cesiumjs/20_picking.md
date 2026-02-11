# 20. Picking - オブジェクト選択とレイキャスト

## 概要

Picking は **画面座標やレイからシーン内のオブジェクトを特定する**システムです。
CesiumJS のピッキングは GPU ベースの **カラーピッキング**（Color Picking）を核としており、
各オブジェクトに一意の色を割り当ててオフスクリーンレンダリングし、ピクセル色からオブジェクトを逆引きします。

主な機能:
- **pick()**: 画面座標のオブジェクト特定（カラーピッキング）
- **pickPosition()**: 画面座標の 3D 位置取得（深度バッファ読み取り）
- **drillPick()**: 重なったオブジェクトを貫通ピッキング
- **pickFromRay()**: レイキャストによるオブジェクト・位置特定
- **sampleHeight() / clampToHeight()**: 地形・3D Tiles 上の高さ取得
- **pickMetadata()**: 3D Tiles メタデータの値取得

## アーキテクチャ全体図

```
Scene.pick(windowPosition)
  │
  ├─ Picking.pick()
  │   │
  │   ├─ pickBegin()
  │   │   ├── window → drawingBuffer 座標変換
  │   │   ├── ピック用 CullingVolume 生成（狭い視錐台）
  │   │   ├── frameState.passes.pick = true  ← ★ピックパス
  │   │   ├── PickFramebuffer.begin()        ← FBO にバインド
  │   │   └── scene.updateAndExecuteCommands() ← ピック色で描画
  │   │
  │   ├─ PickFramebuffer.end()
  │   │   ├── readPixels() でピクセル色を読み取り
  │   │   ├── スパイラル探索で中心から外側へ
  │   │   └── context.getObjectByPickColor() で逆引き
  │   │
  │   └─ pickEnd()
  │
  └─ pickedObject を返す
```

## カラーピッキングの仕組み

### Pick ID の割り当て

**ファイル**: `Renderer/Context.js` L1706-1722

各 Primitive（あるいは個別の GeometryInstance）は `context.createPickId(object)` で一意の Pick ID を取得:

```javascript
Context.prototype.createPickId = function(object) {
  ++this._nextPickColor[0];  // Uint32 のインクリメント
  const key = this._nextPickColor[0];

  this._pickObjects.set(key, object);  // Map<uint32, object>
  return new PickId(this._pickObjects, key, Color.fromRgba(key));
  // key=1 → Color(0, 0, 0, 1/255)
  // key=2 → Color(0, 0, 0, 2/255)
  // key=256 → Color(0, 0, 1/255, 0)  ← RGBA の各バイトに分散
};
```

Pick 色は **32bit の RGBA** としてエンコードされ、最大 **約 42 億** のオブジェクトを識別可能です。

### Pick 色からオブジェクトの逆引き

```javascript
Context.prototype.getObjectByPickColor = function(pickColor) {
  return this._pickObjects.get(pickColor);  // RGBA → uint32 → object
};
```

### ピッキング時のシェーダー

`frameState.passes.pick = true` の場合、Primitive はピッキング用の DrawCommand を生成します。
ピッキング用シェーダーは **フラグメント出力を Pick 色に置換**:

```glsl
// ピッキング用フラグメントシェーダー（自動変形）
uniform vec4 czm_pickColor;  // or: in vec4 czm_pickColor;
void main() {
    czm_old_main();             // 元の main() を実行
    if (out_FragColor.a == 0.0) discard;  // 透明ならスキップ
    out_FragColor = czm_pickColor;  // ★Pick 色を出力
}
```

## Picking クラス

**ファイル**: `Scene/Picking.js` (1684行)

### コンストラクタ

```javascript
function Picking(scene) {
  this._mostDetailedRayPicks = [];   // 非同期レイピッキングのキュー
  this.pickRenderStateCache = {};    // RenderState キャッシュ
  this._pickPositionCache = {};      // 位置キャッシュ
  this._pickPositionCacheDirty = false;

  // レイピッキング用のオフスクリーンカメラ
  this._pickOffscreenView = new View(
    scene,
    pickOffscreenCamera,       // OrthographicFrustum (width=0.1)
    pickOffscreenViewport,     // BoundingRectangle(0,0,1,1)
  );
}
```

## pick() - 基本カラーピッキング

**ファイル**: `Picking.js` L404-422

### フロー

```
Scene.pick(windowPosition, width=3, height=3)
  └── Picking.pick(scene, windowPosition, width, height, limit=1)
       │
       ├── pickBegin(scene, windowPosition, rect, width, height)
       │   │
       │   ├── window 座標 → drawingBuffer 座標に変換
       │   │
       │   ├── computePickingDrawingBufferRectangle()
       │   │   → クリック周辺の矩形を計算（デフォルト 3×3 ピクセル）
       │   │
       │   ├── scene.updateFrameState()
       │   │
       │   ├── frameState.cullingVolume = getPickCullingVolume()
       │   │   → クリック位置を中心とした狭い視錐台を生成
       │   │   → Perspective or Orthographic に応じて計算
       │   │
       │   ├── frameState.passes.pick = true     ← ★ピックモード
       │   ├── frameState.invertClassification = false
       │   │
       │   ├── PickFramebuffer.begin(rect, viewport)
       │   │   → FBO を生成/更新、scissorTest を設定
       │   │   → passState.framebuffer = pickFBO
       │   │
       │   └── scene.updateAndExecuteCommands(passState)
       │       → 全 Primitive がピック色で描画される
       │
       ├── PickFramebuffer.end(rect, limit=1)
       │   │
       │   ├── context.readPixels({ framebuffer: pickFBO })
       │   │   → ピック FBO からピクセルデータを読み取り
       │   │
       │   └── pickObjectsFromPixels(context, pixels, width, height)
       │       → スパイラル探索で中心ピクセルから走査
       │       → Color.bytesToRgba() → context.getObjectByPickColor()
       │       → 最大 limit 個のオブジェクトを返す
       │
       └── pickEnd(scene)
            → context.endFrame()
```

### スパイラル探索

`pickObjectsFromPixels()` は中心ピクセルから外側に向かってスパイラル状に走査し、
最も近い（中心に近い）オブジェクトを優先して見つけます:

```
       ┌───┬───┬───┐
       │ 5 │ 4 │ 3 │
       ├───┼───┼───┤
       │ 6 │ 0 │ 2 │  ← 0 が中心、数字は探索順序
       ├───┼───┼───┤
       │ 7 │ 8 │ 1 │
       └───┴───┴───┘
```

これにより、クリック位置がオブジェクトの境界付近でも、近くのオブジェクトが優先的に選択されます。

### pickAsync() - 非同期ピッキング

WebGL2 環境では **Pixel Buffer Object (PBO)** と **GPU Sync** を使用して非同期にピクセルを読み取り、
メインスレッドのブロッキングを回避:

```javascript
Picking.prototype.pickAsync = async function(scene, windowPosition, ...) {
  pickBegin(scene, windowPosition, ...);

  if (context.webgl2) {
    // PBO にコピー → GPU Sync で完了待ち → readback
    pickedObjects = pickFramebuffer.endAsync(rect, frameState, limit);
  } else {
    // WebGL1 フォールバック: 同期 readPixels
    pickedObjects = pickFramebuffer.end(rect, limit);
  }

  pickEnd(scene);
  return pickedObjects;
};
```

`endAsync()` は以下の流れ:
1. `context.readPixelsToPBO()` で GPU メモリにコピー
2. `Sync.create()` で GPU フェンスを設定
3. `sync.waitForSignal()` で `afterRender` コールバック経由で完了通知を待機
4. `pbo.getBufferData(pixels)` で CPU メモリに読み戻し
5. `pickObjectsFromPixels()` でオブジェクトを特定

## pickPosition() - 深度バッファからの 3D 位置取得

**ファイル**: `Picking.js` L676-783

画面座標から **ワールド座標の 3D 位置**を取得。深度バッファの値を使用:

```
Scene.pickPosition(windowPosition)
  └── Picking.pickPositionWorldCoordinates()
       │
       ├── キャッシュチェック（同一フレーム内の同一座標を再利用）
       │
       ├── 半透明深度の場合: renderTranslucentDepthForPick()
       │   → passes.pick = true, passes.depth = true で描画
       │
       ├── 各フラスタムの PickDepth を走査
       │   for (i = 0; i < numFrustums; i++):
       │     pickDepth = getPickDepth(scene, i)
       │     depth = pickDepth.getDepth(context, x, y)
       │     → FBO から 1 ピクセル読み取り
       │     → RGBA → float に展開（パックされた深度値）
       │
       │   if (0 < depth < 1):
       │     → 有効な深度値
       │     → フラスタムの near/far から実距離を計算
       │
       └── SceneTransforms.drawingBufferToWorldCoordinates()
            → (x, y, depth) をスクリーン → ワールド座標に変換
```

### PickDepth - 深度値の読み取り

**ファイル**: `Scene/PickDepth.js` (126行)

```javascript
PickDepth.prototype.getDepth = function(context, x, y) {
  // 深度 FBO から 1 ピクセル読み取り
  const pixels = context.readPixels({
    x: x, y: y, width: 1, height: 1,
    framebuffer: this.framebuffer,
  });

  // RGBA (4 × uint8) → float に展開
  // パックされた深度値: depth = R/255 + G/(255×256) + B/(255×65536) + A/(255×16777216)
  const packedDepth = Cartesian4.unpack(pixels, 0, scratchPackedDepth);
  Cartesian4.divideByScalar(packedDepth, 255.0, packedDepth);
  return Cartesian4.dot(packedDepth, packedDepthScale);
  // packedDepthScale = (1.0, 1.0/256.0, 1.0/65536.0, 1.0/16777216.0)
};
```

## drillPick() - 貫通ピッキング

**ファイル**: `Picking.js` L878-924, L926-949

重なったオブジェクトを全て取得。**ピック → 非表示 → 再ピック**のループ:

```
Scene.drillPick(windowPosition, limit)
  └── drillPick(pickCallback, limit)
       │
       │  ループ:
       ├── 1回目: pickCallback() → [objectA]
       │   → objectA を非表示 (show = false or attribute.show = false)
       │   → results に追加
       │
       ├── 2回目: pickCallback() → [objectB]  ← objectA は非表示
       │   → objectB を非表示
       │   → results に追加
       │
       ├── 3回目: pickCallback() → []  ← 何も無い
       │   → ループ終了
       │
       └── 全ての非表示を元に戻す
            ├── pickedPrimitives[i].show = true
            ├── pickedAttributes[i].show = true  (GeometryInstance)
            └── pickedFeatures[i].show = true   (Cesium3DTileFeature)
```

### 非表示の方法（3種類）

| 対象 | 非表示方法 | 復元方法 |
|---|---|---|
| `Cesium3DTileFeature` | `feature.show = false` | `feature.show = true` |
| `Primitive` (GeometryInstance) | `attributes.show = [0]` | `attributes.show = [1]` |
| その他の Primitive | `primitive.show = false` | `primitive.show = true` |

## pickFromRay() - レイキャストピッキング

**ファイル**: `Picking.js` L1096-1230

レイ（原点 + 方向）から最初に交差するオブジェクトと位置を特定:

```
Scene.pickFromRay(ray, objectsToExclude, width)
  └── Picking.pickFromRay()
       └── drillPickFromRay()
            └── getRayIntersection(picking, scene, ray, ...)
                 │
                 ├── オフスクリーンカメラをレイに合わせて設定
                 │   camera.position = ray.origin
                 │   camera.direction = ray.direction
                 │   camera.frustum = OrthographicFrustum (width)
                 │
                 ├── scene.view = pickOffscreenView (1×1 ビューポート)
                 │
                 ├── frameState.passes.pick = true
                 │   frameState.passes.offscreen = true
                 │
                 ├── scene.updateAndExecuteCommands()
                 │   → レイ方向に正射影でピック描画
                 │
                 ├── pickFramebuffer.end() → object 特定
                 │
                 └── 深度バッファから交差位置を計算
                     depth → distance = near + depth × (far - near)
                     position = Ray.getPoint(ray, distance)
```

### 戻り値

```javascript
{
  object: pickedObject,      // ピックされたオブジェクト
  position: Cartesian3,      // 交差位置（ワールド座標）
  exclude: boolean,          // 除外対象か
}
```

## MostDetailed 系 - 非同期高精度ピッキング

3D Tiles は LOD 構造のため、通常のピッキングでは低解像度タイルにヒットする可能性があります。
**MostDetailed** 系のメソッドは、最高精度のタイルがロードされるまで待ってからピッキングします。

### フロー

```
Scene.pickFromRayMostDetailed(ray)
  └── Picking.pickFromRayMostDetailed()
       └── launchMostDetailedRayPick()
            │
            ├── getTilesets() → 対象 Cesium3DTileset を収集
            │
            ├── new MostDetailedRayPick(ray, width, tilesets)
            │   → キューに追加
            │
            └── rayPick.promise.then(() => pickFromRay())
                                              ↑ 最高精度ロード後に実行

// 毎フレーム Scene.render() から呼ばれる:
Picking.updateMostDetailedRayPicks()
  └── for each rayPick:
       └── updateMostDetailedRayPick(picking, scene, rayPick)
            ├── オフスクリーンカメラをレイ方向に設定
            ├── tileset.updateForPass(frameState, mostDetailedPassState)
            │   → MostDetailedTraversal で全リーフタイルをロード要求
            │
            └── 全 tileset が ready → rayPick._completePick()
                → Promise が resolve → pickFromRay() 実行
```

## sampleHeight() / clampToHeight() - 高さ取得

### sampleHeight()

**ファイル**: `Picking.js` L1510-1541

指定した経緯度の地形・3D Tiles 上の高さを取得:

```javascript
Picking.prototype.sampleHeight = function(scene, position, objectsToExclude, width) {
  // 1. 地表法線方向に上空からレイを生成
  const ray = getRayForSampleHeight(scene, position);
  //   origin: 地表 + 法線方向 × 大きな距離（上空）
  //   direction: -法線方向（下向き）

  // 2. レイピッキング（位置必須）
  const pickResult = pickFromRay(this, scene, ray, objectsToExclude, width, true, false);

  // 3. 交差位置から高さを抽出
  return getHeightFromCartesian(scene, pickResult.position);
};
```

### clampToHeight()

指定した Cartesian3 を地形・3D Tiles の表面にクランプ:

```javascript
Picking.prototype.clampToHeight = function(scene, cartesian, objectsToExclude, width) {
  // cartesian から地表面への法線方向レイを生成
  const ray = getRayForClampToHeight(scene, cartesian);

  const pickResult = pickFromRay(this, scene, ray, objectsToExclude, width, true, false);
  return defined(pickResult) ? pickResult.position : undefined;
};
```

## pickMetadata() - 3D Tiles メタデータピッキング

**ファイル**: `Picking.js` L527-617

3D Tiles のメタデータ値（建物の高さ、年代等）を画面座標から取得:

```
Scene.pickMetadata(windowPosition, pickedMetadataInfo)
  └── Picking.pickMetadata()
       │
       ├── frameState.passes.pick = true
       ├── frameState.pickingMetadata = true        ← ★メタデータモード
       ├── frameState.pickedMetadataInfo = {
       │     classProperty, metadataProperty, ...
       │   }
       │
       ├── scene.updateAndExecuteCommands()
       │   → メタデータ値をフラグメント色として出力するシェーダー
       │
       ├── pickFramebuffer.readCenterPixel()
       │   → 中心ピクセルの RGBA を取得
       │
       └── MetadataPicking.decodeMetadataValues()
            → RGBA → メタデータ値にデコード
```

## pickVoxelCoordinate() - Voxel ピッキング

**ファイル**: `Picking.js` L435-497

Voxel Primitive のボクセル座標を取得:

```javascript
frameState.passes.pickVoxel = true;  // ★Voxel ピックモード
// → VoxelPrimitive が voxel 座標をフラグメント色として出力
```

## PickFramebuffer - オフスクリーン FBO 管理

**ファイル**: `Scene/PickFramebuffer.js` (256行)

| メソッド | 説明 |
|---|---|
| `begin(rect, viewport)` | FBO を生成/更新、scissorTest 設定、passState を返す |
| `end(rect, limit)` | **同期** readPixels → pickObjectsFromPixels |
| `endAsync(rect, frameState, limit)` | **非同期** PBO + GPU Sync → readback |
| `readCenterPixel(rect)` | 中心ピクセルのみ読み取り（メタデータ用） |

## API 一覧

### 同期メソッド

| メソッド | 説明 | 戻り値 |
|---|---|---|
| `scene.pick(pos, w, h)` | オブジェクト特定 | `{ primitive, id, ... }` or `undefined` |
| `scene.pickAsync(pos, w, h)` | 非同期ピック（WebGL2） | `Promise<{ primitive, id, ... }>` |
| `scene.drillPick(pos, limit, w, h)` | 貫通ピック | `[{ primitive, id }, ...]` |
| `scene.pickPosition(pos)` | 3D 位置取得 | `Cartesian3` or `undefined` |
| `scene.pickVoxel(pos, w, h)` | Voxel 座標取得 | Voxel info or `undefined` |
| `scene.pickMetadata(pos, info)` | メタデータ取得 | 値 or `undefined` |
| `scene.pickFromRay(ray, exclude, w)` | レイキャスト | `{ object, position }` or `undefined` |
| `scene.drillPickFromRay(ray, limit, ...)` | レイキャスト貫通 | `[{ object, position }, ...]` |
| `scene.sampleHeight(pos, exclude, w)` | 高さ取得 | `number` or `undefined` |
| `scene.clampToHeight(pos, exclude, w)` | 表面クランプ | `Cartesian3` or `undefined` |

### 非同期 MostDetailed メソッド

| メソッド | 説明 | 戻り値 |
|---|---|---|
| `scene.pickFromRayMostDetailed(ray, ...)` | 高精度レイキャスト | `Promise<{ object, position }>` |
| `scene.drillPickFromRayMostDetailed(ray, ...)` | 高精度貫通レイキャスト | `Promise<[{ object, position }]>` |
| `scene.sampleHeightMostDetailed(positions, ...)` | 高精度高さ取得 | `Promise<Cartographic[]>` |
| `scene.clampToHeightMostDetailed(cartesians, ...)` | 高精度クランプ | `Promise<Cartesian3[]>` |

## データフロー全体図

```
ユーザーイベント（クリック等）
  │
  ▼
ScreenSpaceEventHandler
  └── callback(movement)
       │
       ▼
Scene.pick(movement.position)
  │
  ├─① ピック FBO にバインド
  │   PickFramebuffer.begin()
  │
  ├─② ピックパスで描画
  │   frameState.passes.pick = true
  │   Primitive.update(frameState)
  │     └── if (passes.pick) frameState.commandList.push(pickCommand)
  │
  │   pickCommand の fragmentShader:
  │     out_FragColor = czm_pickColor  ← 一意の RGBA
  │
  ├─③ ピクセル読み取り
  │   readPixels() → RGBA データ
  │   ↓
  │   スパイラル探索 → 中心に最も近いピクセルの色
  │   ↓
  │   Color.bytesToRgba() → uint32 キー
  │   ↓
  │   context._pickObjects.get(key) → オブジェクト
  │
  ├─④ 位置が必要な場合 (pickPosition/pickFromRay)
  │   PickDepth.getDepth(x, y) → 深度値 (0-1)
  │   ↓
  │   depth → distance (frustum near/far から計算)
  │   ↓
  │   SceneTransforms.drawingBufferToWorldCoordinates()
  │   → Cartesian3 (ワールド座標)
  │
  └─⑤ 結果を返す
      { primitive, id, ... } or { object, position }
```

## パフォーマンス考慮事項

### ピック用 CullingVolume

通常の描画と異なり、ピッキングではクリック位置を中心とした **非常に狭い視錐台** を生成:

```javascript
function getPickPerspectiveCullingVolume(scene, drawingBufferPosition, width, height, viewport) {
  // ピクセルサイズを計算
  const pixelSize = frustum.getPixelDimensions(viewport.width, viewport.height, 1.0, ...);

  // クリック位置を中心とした幅 width/height ピクセル分の視錐台
  const x = 2.0 * (drawingBufferPosition.x - viewport.x) / viewport.width - 1.0;
  // ... 狭い frustum を計算
  return pickFrustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
}
```

これにより、クリック位置から離れた Primitive は **カリング** されて描画されず、ピッキングのコストを大幅に削減します。

### キャッシュ

- **pickPositionCache**: 同一フレーム内で同じ座標の `pickPosition()` 呼び出しをキャッシュ
- **pickRenderStateCache**: ピッキング用 RenderState をキャッシュ

### MostDetailed の非同期設計

MostDetailed 系メソッドは:
1. 3D Tiles に最高精度タイルのロードを要求
2. 毎フレーム `updateMostDetailedRayPicks()` で進捗確認
3. 全タイルが ready になってから Promise を resolve してピッキング実行

これにより、大規模 3D Tiles でもメインスレッドをブロックせずに精密なピッキングが可能です。

## 関連ファイル

| ファイル | 責務 |
|---|---|
| `Scene/Picking.js` | ピッキングロジック全体 (1684行) |
| `Scene/PickFramebuffer.js` | ピック用 FBO 管理、ピクセル読み取り |
| `Scene/PickDepth.js` | 深度バッファからの深度値読み取り |
| `Renderer/Context.js` | Pick ID 管理 (createPickId, getObjectByPickColor) |
| `Scene/Scene.js` | 公開 API (pick, drillPick, pickPosition 等) |
| `Core/SceneTransforms.js` | 座標変換 (drawingBufferToWorldCoordinates) |
| `Scene/View.js` | ピック用オフスクリーンビュー |
