# 12. FrameState - フレーム情報の受け渡し構造体

## 概要

FrameState は **1フレームの描画に必要な全情報を集約した構造体**です。
Scene が毎フレーム設定し、全ての Primitive の `update(frameState)` に渡されます。

CesiumJS の描画パイプラインでは、Primitive は Scene を直接参照しません。
代わりに FrameState を介して必要な情報を受け取ります。これにより:

- Primitive と Scene の**疎結合**を実現
- テスト時に FrameState をモックできる
- 複数パス（render/pick/depth）で異なる設定を注入できる

## FrameState の生成と設定

**ファイル**: `packages/engine/Source/Scene/FrameState.js` (~468行)

### 生成（1回のみ）

```javascript
// Scene.js L168
this._frameState = new FrameState(context, creditDisplay, jobScheduler);
```

Scene のコンストラクタで1回だけ生成され、以降は毎フレーム再利用（プロパティの更新のみ）。

### 毎フレームの更新

```javascript
// Scene.js L1977 - Scene.prototype.updateFrameState()
frameState.commandList.length = 0;     // コマンドリストをクリア
frameState.shadowMaps.length = 0;

// Scene のプロパティを転写
frameState.mode = this._mode;          // SceneMode (3D/2D/CV)
frameState.morphTime = this.morphTime;
frameState.mapProjection = this.mapProjection;
frameState.camera = camera;
frameState.cullingVolume = camera.frustum.computeCullingVolume(...);
frameState.occluder = getOccluder(this);
frameState.light = this.light;
frameState.useLogDepth = this._logDepthBuffer && ...;
frameState.maximumScreenSpaceError = this.globe.maximumScreenSpaceError;
// ... 約30プロパティ
```

## プロパティ一覧

### コアプロパティ

| プロパティ | 型 | 説明 |
|---|---|---|
| `context` | Context | WebGL コンテキスト（drawingBufferHeight 等） |
| `commandList` | DrawCommand[] | **描画コマンドの収集配列** - Primitive が push する |
| `frameNumber` | number | フレーム番号（0 から増加） |
| `newFrame` | boolean | 新しいフレームが発行されたか |
| `time` | JulianDate | シーンの現在時刻 |

### カメラ・ビュー

| プロパティ | 型 | 説明 |
|---|---|---|
| `camera` | Camera | 現在のカメラ |
| `cullingVolume` | CullingVolume | **視錐台カリングボリューム** - BV との交差判定用 |
| `occluder` | Occluder | 地球によるオクルージョン判定用 |
| `cameraUnderground` | boolean | カメラが地下にいるか |
| `frustumSplits` | number[] | マルチフラスタムの分割距離 |

### シーンモード

| プロパティ | 型 | 説明 |
|---|---|---|
| `mode` | SceneMode | SCENE3D / SCENE2D / COLUMBUS_VIEW / MORPHING |
| `morphTime` | number | モーフ遷移 (0=2D, 1=3D) |
| `mapProjection` | MapProjection | 2D/CV の投影法 |
| `scene3DOnly` | boolean | 3D モードのみに最適化 |

### パス制御

| プロパティ | 型 | 説明 |
|---|---|---|
| `passes.render` | boolean | **描画パスか** |
| `passes.pick` | boolean | **ピッキングパスか** |
| `passes.pickVoxel` | boolean | Voxel ピッキングか |
| `passes.depth` | boolean | 深度のみパスか |
| `passes.postProcess` | boolean | ポストプロセスパスか |
| `passes.offscreen` | boolean | オフスクリーンパスか |

### 霧 (Fog)

| プロパティ | 型 | 説明 |
|---|---|---|
| `fog.enabled` | boolean | 霧が有効か |
| `fog.renderable` | boolean | 霧を描画するか |
| `fog.density` | number | 霧の密度 |
| `fog.sse` | number | SSE への霧の影響係数 |
| `fog.minimumBrightness` | number | 霧適用時の最低輝度 |
| `fog.visualDensityScalar` | number | 視覚的密度スカラー |

### シャドウ

| プロパティ | 型 | 説明 |
|---|---|---|
| `shadowState.shadowsEnabled` | boolean | シャドウ有効か |
| `shadowState.shadowMaps` | ShadowMap[] | 有効なシャドウマップ |
| `shadowState.lightShadowMaps` | ShadowMap[] | 光源シャドウマップ |
| `shadowState.nearPlane` | number | シャドウ near 面 |
| `shadowState.farPlane` | number | シャドウ far 面 |
| `shadowState.closestObjectSize` | number | 最近オブジェクトサイズ |

### ライティング・環境

| プロパティ | 型 | 説明 |
|---|---|---|
| `light` | Light | シーンの光源（太陽等） |
| `atmosphere` | Atmosphere | 大気設定 |
| `backgroundColor` | Color | 背景色 |
| `environmentMap` | CubeMap | 環境マップ（SkyBox） |
| `brdfLutGenerator` | BrdfLutGenerator | PBR 用 BRDF LUT |
| `specularEnvironmentMaps` | Texture | PBR 用スペキュラ環境マップ |
| `sphericalHarmonicCoefficients` | Cartesian3[] | PBR 用球面調和係数 |

### 地形・Globe

| プロパティ | 型 | 説明 |
|---|---|---|
| `maximumScreenSpaceError` | number | **LOD の SSE 閾値**（デフォルト: 2） |
| `minimumTerrainHeight` | number | 描画タイルの最低地形高 |
| `verticalExaggeration` | number | 垂直誇張倍率 |
| `verticalExaggerationRelativeHeight` | number | 垂直誇張の基準高度 |
| `globeTranslucencyState` | GlobeTranslucencyState | 地球半透明状態 |

### 描画制御

| プロパティ | 型 | 説明 |
|---|---|---|
| `pixelRatio` | number | デバイスピクセル比 |
| `useLogDepth` | boolean | 対数深度バッファ使用 |
| `splitPosition` | number | スプリッター位置 (0-1) |
| `invertClassification` | boolean | 3D Tiles 分類反転 |
| `invertClassificationColor` | Color | 反転時の色 |
| `minimumDisableDepthTestDistance` | number | 深度テスト無効化距離 |

### その他

| プロパティ | 型 | 説明 |
|---|---|---|
| `creditDisplay` | CreditDisplay | クレジット表示管理 |
| `jobScheduler` | JobScheduler | ジョブスケジューラ |
| `afterRender` | Function[] | **フレーム後コールバック** |
| `tilesetPassState` | Cesium3DTilePassState | 3D Tiles パス状態 |
| `pickingMetadata` | boolean | メタデータピッキング中か |
| `edgeVisibilityRequested` | boolean | エッジ可視性要求フラグ |

## FrameState のライフサイクル（1フレーム内）

```
Scene.render()
  │
  ├─ updateFrameState()           ←① FrameState をリセット・設定
  │   commandList.length = 0      ← コマンドリストをクリア
  │   camera, mode, light, ...    ← Scene のプロパティを転写
  │   passes をクリア
  │
  ├─ Fog.update(frameState)       ←② 霧パラメータを設定
  │   frameState.fog.enabled/density/sse
  │
  ├─ passes.render = true         ←③ パスフラグを設定
  │
  ├─ updateAndRenderPrimitives()  ←④ 全 Primitive に配布
  │   ├── globe.beginFrame(frameState)
  │   ├── globe.render(frameState)
  │   │    └── QuadtreePrimitive.render(frameState)
  │   │         └── visitTile() → SSE 計算に frameState を使用
  │   │
  │   ├── primitives.update(frameState)
  │   │    └── 各 Primitive.update(frameState)
  │   │         └── frameState.commandList.push(drawCommand)  ← ★
  │   │
  │   └── globe.endFrame(frameState)
  │
  ├─ executeFrustumCommands()     ←⑤ commandList を消費
  │   commandList をパス別・フラスタム別にソート
  │   各 DrawCommand を実行 → WebGL 描画
  │
  └─ afterRender コールバック実行  ←⑥ フレーム後処理
      frameState.afterRender.forEach(cb => cb())
```

## commandList - 描画パイプラインの中核

FrameState の最も重要なプロパティは **`commandList`** です。

### データフロー

```
Primitive.update(frameState)
  └── frameState.commandList.push(drawCommand)
           ↓
      commandList: [cmd0, cmd1, cmd2, ..., cmdN]
           ↓
Scene.executeFrustumCommands()
  └── パス別に分類 (GLOBE, GROUND, OPAQUE, TRANSLUCENT, ...)
  └── フラスタム別に分類 (near, mid, far)
  └── 各コマンドを実行 → context.draw()
```

### commandList に push するクラス群

| クラス | 説明 |
|---|---|
| Primitive.js | 汎用ジオメトリ |
| GlobeSurfaceTileProvider.js | 地球タイル |
| BillboardCollection.js | ビルボード |
| PointPrimitiveCollection.js | ポイント |
| PolylineCollection.js | ポリライン |
| Model/ModelDrawCommand.js | glTF モデル |
| Cesium3DTileset.js | 3D Tiles |
| GaussianSplatPrimitive.js | ガウシアンスプラット |
| VoxelPrimitive.js | ボクセル |
| CloudCollection.js | 雲 |
| ... | 約25クラス |

## passes - マルチパス描画

同じフレームで異なる目的の描画を行うために `passes` フラグを使用:

```javascript
// 通常の描画パス
frameState.passes.render = true;
primitives.update(frameState);  // Primitive は passes.render を見て DrawCommand を生成

// ピッキングパス（別途実行）
frameState.passes.pick = true;
primitives.update(frameState);  // Primitive は passes.pick を見てピック用 DrawCommand を生成
```

Primitive 側での使い分け:

```javascript
Primitive.prototype.update = function(frameState) {
  if (frameState.passes.render) {
    // 描画用コマンドを push
    frameState.commandList.push(colorCommand);
  }
  if (frameState.passes.pick) {
    // ピッキング用コマンドを push
    frameState.commandList.push(pickCommand);
  }
};
```

## afterRender - 安全なイベント発火

`afterRender` は「フレーム描画後に実行するコールバック」の配列です:

```javascript
// Primitive.update() 内で
frameState.afterRender.push(function() {
  // ここでは Scene 状態を安全に変更できる
  // 例: カメラ移動、エンティティ追加
  primitive.readyEvent.raiseEvent(primitive);
  return true;  // true を返すと追加フレームが描画される
});
```

**なぜ必要か**: `update()` 中に Scene 状態を変更すると、
同じフレーム内の他の Primitive に影響する。afterRender に遅延させることで安全に操作できる。

## 実用パターン

### frameState を利用した LOD 判定

```javascript
MyPrimitive.prototype.update = function(frameState) {
  // カメラ距離に基づく LOD
  const distance = Cartesian3.distance(
    frameState.camera.positionWC,
    this._position
  );

  // SSE 閾値を参照
  if (this._sse > frameState.maximumScreenSpaceError) {
    // 高解像度版を描画
  }
};
```

### frameState を利用したカリング

```javascript
MyPrimitive.prototype.update = function(frameState) {
  // 視錐台カリング
  const visibility = frameState.cullingVolume.computeVisibility(
    this._boundingSphere
  );
  if (visibility === Intersect.OUTSIDE) {
    return; // 画面外 → 描画しない
  }

  frameState.commandList.push(this._drawCommand);
};
```

### 2D/3D モード切り替え

```javascript
MyPrimitive.prototype.update = function(frameState) {
  if (frameState.mode === SceneMode.SCENE3D) {
    // 3D 描画ロジック
  } else if (frameState.mode === SceneMode.SCENE2D) {
    // 2D 描画ロジック
  }
};
```

## 関連ファイル

| ファイル | 関係 |
|---|---|
| `Scene/Scene.js` | FrameState を生成・更新する |
| `Scene/Fog.js` | fog プロパティを設定する |
| `Renderer/DrawCommand.js` | commandList に格納されるコマンド |
| `Scene/Primitive.js` | frameState を受け取って commandList に push |
| `Core/CullingVolume.js` | cullingVolume のカリング判定 |
| `Core/Occluder.js` | occluder のオクルージョン判定 |
| `Scene/ShadowMap.js` | shadowState を設定・参照 |
