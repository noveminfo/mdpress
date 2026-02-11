# 03. レンダリングパイプライン

## 概要

CesiumJS のレンダリングは **コマンドベース** のアーキテクチャです。

> 全プリミティブの `update()` で DrawCommand を集め、フラスタムごとにパス順でソートして WebGL で実行する

## 1フレームの全体フロー

```
requestAnimationFrame
  └→ CesiumWidget.render()
      └→ Scene.prototype.render(time)         ← 公開メソッド (Scene.js:4368)
          │
          │  ① preUpdate イベント発火
          │  ② カメラ変更チェック (view.checkForCameraUpdates)
          │  ③ shouldRender 判定 (requestRenderMode 対応)
          │  ④ フレーム番号更新 (updateFrameNumber)
          │
          ├→ prePassesUpdate()                  ← Scene.js:4239
          │    ├ jobScheduler.resetBudgets()
          │    ├ primitives.prePassesUpdate(frameState)
          │    ├ globe.update(frameState)
          │    └ picking.update()
          │
          ├→ updateMostDetailedRayPicks()       ← レイキャスト更新
          ├→ updatePreloadPass()                ← タイルプリロード
          ├→ updatePreloadFlightPass()          ← 飛行中プリロード
          │
          │  ⑤ postUpdate イベント発火
          │  ⑥ preRender イベント発火
          │  ⑦ creditDisplay.beginFrame()
          │
          ├→ render(scene)                      ← 内部関数 (Scene.js:4266) ★核心
          │
          │  ⑧ debugShowFramesPerSecond 更新
          ├→ postPassesUpdate()
          ├→ callAfterRenderFunctions()         ← 遅延コールバック実行
          │  ⑨ postRender イベント発火
          │  ⑩ creditDisplay.endFrame()
          └─ done
```

## 内部 render(scene) の詳細

Scene.js には `render` という名前の関数が **2つ** あります:
- `Scene.prototype.render(time)` (L4368) - 公開API、フレーム全体統括
- `function render(scene)` (L4266) - 内部関数、実際の描画処理

### 内部 render(scene) (L4266-4345)

```
render(scene)
  │
  ├─ updateFrameState()             カメラ・パス情報をフレームに設定
  ├─ 背景色の HDR ガンマ補正
  ├─ fog.update(frameState)         フォグ更新
  ├─ uniformState.update(frameState) GPU ユニフォーム更新
  ├─ シャドウマップのライト方向設定
  ├─ ビューポート設定 (0, 0, drawingBufferWidth, drawingBufferHeight)
  │
  ├─ context.beginFrame()           ★ WebGL フレーム開始
  ├─ globe.beginFrame(frameState)   地球のフレーム開始
  │
  ├─ updateEnvironment()            環境オブジェクト更新 (天体の可視性判定)
  ├─ updateAndExecuteCommands()     ★★★ 描画コマンド実行
  ├─ resolveFramebuffers()          ポストプロセス・OIT 解決
  │
  ├─ executeOverlayCommands()       オーバーレイ描画 (Pass.OVERLAY)
  ├─ globe.endFrame(frameState)     地球のフレーム終了
  └─ context.endFrame()             ★ WebGL フレーム終了
```

## コマンド生成と実行

### updateAndExecuteCommands (L3181)

```
updateAndExecuteCommands(passState, backgroundColor)
  │
  ├─ updateAndClearFramebuffers()       FBO クリア
  │
  └─ (3Dモードの場合)
      executeCommandsInViewport()        ← L3455
        │
        ├─ updateAndRenderPrimitives()   ★ 全プリミティブの update() 呼び出し
        │    ├ groundPrimitives.update(frameState)
        │    ├ primitives.update(frameState)  ← ここで DrawCommand 生成
        │    ├ shadowMaps 更新
        │    └ globe.render(frameState)
        │
        ├─ view.createPotentiallyVisibleSet()  ★ 視錐台カリング・コマンドソート
        │
        ├─ executeComputeCommands()      GPU コンピュート実行
        ├─ executeShadowMapCastCommands() シャドウキャスト
        │
        └─ executeCommands()             ★★★ メインの描画ループ
```

### コマンドパターンの流れ

```
1. Primitive.update(frameState)
   → DrawCommand を生成
   → frameState.commandList に追加

2. view.createPotentiallyVisibleSet(scene)
   → commandList を frustum ごとに分類
   → pass ごとにソート

3. executeCommands(scene, passState)
   → frustum ごと、pass ごとに実行
   → executeCommand(cmd, scene, passState)
      → cmd.execute(context, passState)
         → WebGL draw call
```

## レンダリングパス (Pass)

### Pass 定数一覧 (Renderer/Pass.js)

| ID | 名前 | 描画対象 | 実行タイミング |
|---|---|---|---|
| 0 | ENVIRONMENT | 空、太陽、月 | frustum ループ前 |
| 1 | COMPUTE | GPU コンピュート | frustum ループ前 |
| 2 | GLOBE | 地球の地形タイル | frustum ごと |
| 3 | TERRAIN_CLASSIFICATION | 地形上のポリゴン分類 | frustum ごと |
| 4 | CESIUM_3D_TILE_EDGES | 3D Tiles エッジ描画 | frustum ごと |
| 5 | CESIUM_3D_TILE | **3D Tiles 本体** | frustum ごと |
| 6 | CESIUM_3D_TILE_CLASSIFICATION | 3D Tiles 分類 | frustum ごと |
| 7 | CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW | 反転分類用 | frustum ごと |
| 8 | OPAQUE | **不透明プリミティブ** | frustum ごと |
| 9 | TRANSLUCENT | **半透明プリミティブ** | frustum ごと |
| 10 | VOXELS | ボクセル | frustum ごと |
| 11 | GAUSSIAN_SPLATS | ガウシアンスプラット | frustum ごと |
| 12 | OVERLAY | UI オーバーレイ | frustum ループ後 |

### executeCommands 内の実行順序 (L2628-2980)

```
for each frustum (奥から手前へ):
  │
  ├─ frustum near/far 設定
  ├─ 深度バッファクリア
  ├─ ステンシルクリア
  │
  ├─ ENVIRONMENT       ← renderEnvironment()
  │    ├ SkyBox (星空)
  │    ├ SkyAtmosphere (大気)
  │    ├ Sun (太陽 + ブルーム効果)
  │    └ Moon (月)
  │
  ├─ GLOBE             ← 地球の地形タイル描画
  ├─ (Globe 深度コピー)
  ├─ TERRAIN_CLASSIFICATION
  ├─ (clearGlobeDepth → depthPlane)
  │
  ├─ CESIUM_3D_TILE_EDGES
  ├─ CESIUM_3D_TILE     ← 3D Tiles 本体
  │    └ (深度更新)
  ├─ CESIUM_3D_TILE_CLASSIFICATION
  │
  ├─ VOXELS             ← ボクセル
  ├─ OPAQUE             ← 不透明プリミティブ (Entity 等)
  ├─ GAUSSIAN_SPLATS    ← ガウシアンスプラット
  │
  ├─ TRANSLUCENT        ← 半透明 (OIT or ソート)
  ├─ 半透明 3D Tiles 分類
  │
  └─ (ピック ID パス - ポストプロセス選択用)
```

## 重要な概念

### マルチフラスタム

CesiumJS は near plane (0.1m) から far plane (地球の反対側) までの広大な距離レンジを描画する必要があります。
1つの深度バッファでは精度が足りないため、**複数のフラスタムに分割** して描画します。

```
例: 3つのフラスタム
  frustum[0]: 0.1m  〜  10m      (近距離)
  frustum[1]: 10m   〜  10km     (中距離)
  frustum[2]: 10km  〜  10000km  (遠距離)

各 frustum ごとに:
  1. 深度バッファクリア
  2. 全パスのコマンド実行
  → 深度精度が各レンジで保たれる
```

奥のフラスタムから手前へ描画することで、近距離のオブジェクトが遠距離のものを正しく上書きします。

### requestRenderMode

パフォーマンス最適化機能。カメラが静止中はレンダリングをスキップします。

```javascript
// shouldRender の判定条件
shouldRender =
  !this.requestRenderMode     // requestRenderMode が OFF なら常にレンダリング
  || this._renderRequested    // scene.requestRender() が呼ばれた
  || cameraChanged            // カメラが動いた
  || this._logDepthBufferDirty // ログ深度バッファ変更
  || this._hdrDirty           // HDR 設定変更
  || this.mode === SceneMode.MORPHING  // 2D↔3D モーフィング中
```

### OIT (Order Independent Translucency)

半透明オブジェクトの描画順序に依存しない正確な合成を実現します。
`resolveFramebuffers()` で OIT の結果を解決します。

### ポストプロセス

`resolveFramebuffers()` (L3871-3928) で実行:
1. Globe 深度テクスチャ準備
2. OIT 解決 (半透明合成)
3. ポストプロセスステージ実行 (FXAA, bloom, ambient occlusion 等)
4. 最終結果をスクリーンにコピー

## イベントフック

レンダリング各段階でイベントが発火され、ユーザーコードからフックできます:

| イベント | タイミング | 用途例 |
|---|---|---|
| `scene.preUpdate` | フレーム開始直後 | データ準備 |
| `scene.postUpdate` | パス更新後 | UI 同期 |
| `scene.preRender` | 描画直前 | 最終調整 |
| `scene.postRender` | 描画完了後 | スクリーンショット取得 |

## 関連ファイル

- `packages/engine/Source/Scene/Scene.js` - メインレンダリングロジック
- `packages/engine/Source/Renderer/Pass.js` - パス定義
- `packages/engine/Source/Renderer/DrawCommand.js` - 描画コマンド
- `packages/engine/Source/Renderer/Context.js` - WebGL コンテキスト
- `packages/engine/Source/Scene/FrameState.js` - フレーム情報
- `packages/engine/Source/Scene/Camera.js` - カメラ
