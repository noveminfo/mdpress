# 04. エントリーポイント解説

## オブジェクト生成チェーン

```
あなたのコード: new Cesium.Viewer("container", options)
    │
    ▼
Viewer.js (packages/widgets/Source/Viewer/Viewer.js, 2030行)
    │ ── UI ウィジェット群を作成
    │ ── CesiumWidget を作成 (L475-513)
    │
    ▼
CesiumWidget.js (packages/engine/Source/Widget/CesiumWidget.js, 1607行)
    │ ── Canvas (HTML5) 作成
    │ ── Scene 作成 (← 描画エンジンの核)
    │ ── Globe, SkyBox, SkyAtmosphere 作成
    │ ── DataSourceDisplay 作成
    │ ── レンダーループ開始
    │
    ▼
毎フレーム: CesiumWidget.render()
    → Scene.render(time)
    → 全プリミティブ描画
```

## CesiumWidget.js 詳細

**ファイル**: `packages/engine/Source/Widget/CesiumWidget.js`
**行数**: 1607行
**役割**: 描画エンジンのコンテナ。UI なしで CesiumJS を使いたい場合はこれだけで動く

### コンストラクタ (L205-497) での初期化順序

| # | 処理 | 行 | 生成されるもの |
|---|---|---|---|
| 1 | DOM要素取得 | L217 | container 要素 |
| 2 | Canvas作成 | L221 | HTML5 Canvas |
| 3 | 高DPI対応 | L222-248 | image-rendering: pixelated |
| 4 | クレジット表示 | L260-270 | creditContainer, creditViewport |
| 5 | **Scene作成** | L314-329 | `new Scene(...)` |
| 6 | Globe作成 | L337 | `new Globe(ellipsoid)` |
| 7 | SkyBox作成 | L346 | 星空テクスチャ |
| 8 | SkyAtmosphere | L360 | 大気散乱効果 |
| 9 | ベースレイヤー | L370 | 画像レイヤー (衛星写真等) |
| 10 | エラーハンドラ | L412-421 | レンダーエラー処理 |
| 11 | **DataSource系** | L424-434 | DataSourceCollection + Display |
| 12 | イベント登録 | L436-476 | DataSource変更監視 |
| 13 | **レンダーループ** | L45-87 | `startRenderLoop()` |

### 主要プロパティ

| プロパティ | 型 | 説明 |
|---|---|---|
| `container` | Element | DOM コンテナ |
| `canvas` | HTMLCanvasElement | 描画キャンバス |
| `scene` | Scene | 描画エンジン |
| `camera` | Camera | カメラ (= scene.camera) |
| `clock` | Clock | 時間管理 |
| `ellipsoid` | Ellipsoid | 楕円体 (デフォルト: WGS84) |
| `entities` | EntityCollection | デフォルト Entity 集合 |
| `dataSources` | DataSourceCollection | DataSource 集合 |
| `dataSourceDisplay` | DataSourceDisplay | Entity → Primitive 変換 |
| `imageryLayers` | ImageryLayerCollection | 画像レイヤー |
| `terrainProvider` | TerrainProvider | テレインプロバイダ |
| `trackedEntity` | Entity | カメラ追従対象 |

### レンダーループ (startRenderLoop, L45-87)

```javascript
function startRenderLoop(widget) {
  // requestAnimationFrame ベース
  // targetFrameRate でフレームレート制限可能
  // エラー発生時は showErrorPanel で表示
  // useDefaultRenderLoop: false で自前ループに切替可能
}
```

### 毎フレームの処理フロー

```
CesiumWidget.render() (L1073)
  ├─ resize()           キャンバスサイズ・解像度調整
  ├─ _onTick()          Clock 更新 → DataSource 更新 → Entity 追跡
  ├─ scene.render(time) ★実際の描画 (→ 03_rendering_pipeline.md)
  └─ _postRender()      ポストレンダー処理
```

## Viewer.js 詳細

**ファイル**: `packages/widgets/Source/Viewer/Viewer.js`
**行数**: 2030行
**役割**: CesiumWidget + 全 UI ウィジェットのオーケストレーター

### コンストラクタ (L395-929) での初期化順序

| # | コンポーネント | 行 | 説明 |
|---|---|---|---|
| 1 | viewerContainer | L445 | Viewer 全体のコンテナ |
| 2 | cesiumWidgetContainer | L450 | CesiumWidget のコンテナ |
| 3 | **CesiumWidget** | L475-513 | ★描画エンジン |
| 4 | EventHelper | L517 | イベント管理 |
| 5 | SelectionIndicator | L522 | 選択インジケータ |
| 6 | InfoBox | L538 | 情報ボックス |
| 7 | toolbar | L559 | ツールバーコンテナ |
| 8 | Geocoder | L564 | ジオコーダー (検索) |
| 9 | HomeButton | L599 | ホームボタン |
| 10 | SceneModePicker | L630 | 2D/3D/Columbus 切替 |
| 11 | ProjectionPicker | L638 | 投影法切替 |
| 12 | BaseLayerPicker | L644 | ベースレイヤー選択 |
| 13 | NavigationHelpButton | L705 | ナビゲーションヘルプ |
| 14 | Animation | L735 | アニメーションコントロール |
| 15 | Timeline | L747 | タイムライン |
| 16 | FullscreenButton | L758 | フルスクリーン |
| 17 | VRButton | L791 | VR モード |

### Viewer が CesiumWidget に追加する機能

| 機能 | メソッド/プロパティ | 説明 |
|---|---|---|
| Entity 選択 | `selectedEntity` | クリックで選択、InfoBox に表示 |
| Entity 追跡 | `trackedEntity` | カメラが Entity を追従 |
| カメラ移動 | `zoomTo()`, `flyTo()` | CesiumWidget に委譲 |
| リサイズ | `resize()` | ウィジェットレイアウト調整 |
| Mixin | `extend(mixin)` | 機能追加パターン |

### Mixin パターン

Viewer は `extend()` で機能を追加できます:

```javascript
// 組み込み Mixin 一覧
viewerDragDropMixin         // ファイルドラッグ&ドロップ
viewerCesiumInspectorMixin  // Cesium Inspector パネル
viewerCesium3DTilesInspectorMixin  // 3D Tiles Inspector
viewerVoxelInspectorMixin   // Voxel Inspector
viewerPerformanceWatchdogMixin     // パフォーマンス監視

// 使用例
viewer.extend(Cesium.viewerCesiumInspectorMixin);
```

### ピッキングフロー

```
マウスクリック
  → ScreenSpaceEventHandler
  → pickEntity(viewer, e.position) (L103)
    → scene.pick(position)
    → entity または Cesium3DTileFeature を取得
  → viewer.selectedEntity = entity
  → InfoBox に情報表示
```

## Viewer vs CesiumWidget の使い分け

| | Viewer | CesiumWidget |
|---|---|---|
| UI ウィジェット | 全て含む | なし |
| 依存パッケージ | @cesium/widgets + engine | @cesium/engine のみ |
| バンドルサイズ | 大きい | 小さい |
| カスタマイズ性 | options で ON/OFF | 完全に自由 |
| 推奨用途 | 通常のアプリ | カスタム UI、軽量アプリ |

```javascript
// Viewer (一般的)
const viewer = new Cesium.Viewer("container");

// CesiumWidget (UI なし)
const widget = new Cesium.CesiumWidget("container");
```
