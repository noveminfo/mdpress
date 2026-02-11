# 02. エンジンアーキテクチャ

## レイヤー構造

```
┌─────────────────────────────────────────────┐
│  アプリケーション層 (あなたのコード)           │
│  viewer.entities.add(), viewer.flyTo() 等    │
├─────────────────────────────────────────────┤
│  Viewer (widgets)                            │
│  UI ウィジェット + CesiumWidget ラッパー       │
├─────────────────────────────────────────────┤
│  CesiumWidget (engine/Widget)                │
│  Canvas + Scene + レンダーループ管理           │
├─────────────────────────────────────────────┤
│  DataSources (engine/DataSources)            │
│  Entity API, Property, Visualizer            │
├─────────────────────────────────────────────┤
│  Scene (engine/Scene)                        │
│  描画エンジン, Primitive, Camera, Globe       │
├─────────────────────────────────────────────┤
│  Renderer (engine/Renderer)                  │
│  WebGL 抽象化 (非公開API)                     │
├─────────────────────────────────────────────┤
│  Core (engine/Core)                          │
│  数学, 座標系, ジオメトリ, ユーティリティ       │
└─────────────────────────────────────────────┘
```

## 各モジュールの詳細

### Core/ (287ファイル) - 基盤ライブラリ

#### 座標系・数学
- `Cartesian2/3/4.js` - 2D/3D/4D ベクトル
- `Cartographic.js` - 経緯度+高度 (ラジアン)
- `Matrix2/3/4.js` - 行列演算
- `Quaternion.js` - 四元数 (回転表現)
- `Ellipsoid.js` - WGS84 楕円体、座標変換の中心
- `Transforms.js` - ENU/ECEF/固定フレーム変換
- `BoundingSphere.js` - バウンディングスフィア

#### ジオメトリ (30+ クラス)
- `BoxGeometry`, `SphereGeometry`, `CylinderGeometry`
- `PolygonGeometry`, `RectangleGeometry`, `EllipseGeometry`
- `PolylineGeometry`, `WallGeometry`, `CorridorGeometry`
- 各 `*OutlineGeometry` (アウトラインバージョン)

#### テレインプロバイダ
- `CesiumTerrainProvider` - Cesium 標準
- `ArcGISTiledElevationTerrainProvider` - ArcGIS
- `Cesium3DTilesTerrainProvider` - 3D Tiles テレイン
- `CustomHeightmapTerrainProvider` - カスタム

#### 時間・イベント
- `JulianDate`, `TimeInterval`, `Clock`
- `Event`, `EventHelper`

#### ネットワーク
- `Resource` - HTTP リクエスト抽象化
- `Request`, `RequestScheduler` - リクエスト管理

#### ユーティリティ
- `defined()` - null/undefined チェック
- `Check` - 開発時バリデーション
- `Color`, `Credit`, `Ion`

### Scene/ (477ファイル) - 描画エンジン

#### コアレンダリング
- `Scene.js` - メインシーン (render() が描画ループ)
- `Camera.js` - カメラ制御
- `Globe.js` - 地球描画
- `FrameState.js` - フレーム情報構造体

#### プリミティブ
- `Primitive.js` - 基本プリミティブ
- `GroundPrimitive.js` - 地表プリミティブ
- `ClassificationPrimitive.js` - 分類プリミティブ
- `BillboardCollection.js` - ビルボード集合
- `LabelCollection.js` - ラベル集合
- `PointPrimitiveCollection.js` - ポイント集合
- `PolylineCollection.js` - ポリライン集合

#### 3D Tiles
- `Cesium3DTileset.js` - タイルセット管理
- `Cesium3DTile.js` - 個別タイル
- `Cesium3DTileContent.js` - タイルコンテンツ
- `Cesium3DTileStyle.js` - スタイリング
- パーサー: `B3dmParser`, `I3dmParser`, `PntsParser`

#### モデル
- `Model/` サブディレクトリ - glTF モデル
- `GltfLoader.js` - glTF ロード
- `DracoLoader.js` - Draco 圧縮対応

#### イメージリプロバイダ
- `BingMapsImageryProvider`
- `WebMapServiceImageryProvider` (WMS)
- `ArcGisMapServerImageryProvider`
- `OpenStreetMapImageryProvider`
- `TileMapServiceImageryProvider` (TMS)
- `GoogleEarthEnterpriseImageryProvider`

#### 環境
- `SkyBox.js`, `SkyAtmosphere.js`
- `Sun.js`, `Moon.js`, `Fog.js`
- `Atmosphere.js`

#### インタラクション
- `ScreenSpaceCameraController.js` - カメラ操作
- `CameraEventAggregator.js` - イベント集約
- `Picking.js` - ピッキング

### DataSources/ (108ファイル) - Entity API

#### Entity システム
- `Entity.js` - 高レベルオブジェクト
- `EntityCollection.js` - Entity の集合
- `DataSource.js` - データソース抽象
- `DataSourceDisplay.js` - Entity → Primitive 変換ハブ

#### データフォーマット
- `CzmlDataSource.js` - CZML
- `GeoJsonDataSource.js` - GeoJSON
- `KmlDataSource.js` - KML
- `GpxDataSource.js` - GPX
- `CustomDataSource.js` - カスタム

#### Property システム
- `Property.js` - 時間変化プロパティ抽象
- `ConstantProperty` - 固定値
- `SampledProperty` - サンプリング値 (補間)
- `CallbackProperty` - コールバック
- `ReferenceProperty` - 他Entity参照
- `CompositeProperty` - 合成

#### Visualizer (Entity → Primitive 変換)
- `BillboardVisualizer`, `LabelVisualizer`
- `PolylineVisualizer`, `PointVisualizer`
- `ModelVisualizer`, `GeometryVisualizer`
- `PathVisualizer`

### Renderer/ (46ファイル) - WebGL 抽象化

- `Context.js` - WebGL コンテキストラッパー
- `ShaderProgram.js`, `ShaderSource.js` - シェーダー管理
- `Texture.js`, `CubeMap.js` - テクスチャ
- `Buffer.js`, `VertexArray.js` - バッファ
- `Framebuffer.js` - フレームバッファ
- `RenderState.js` - レンダリングステート
- `DrawCommand.js` - 描画コマンド
- `UniformState.js` - ユニフォーム管理
- `Pass.js` - レンダリングパス定義

### Workers/ (53ファイル) - Web Worker

- ジオメトリ生成: `create*Geometry.js`
- テレイン処理: `createVerticesFrom*.js`, `upsample*.js`
- データ変換: `decodeDraco`, `transcodeKTX2`, `decodeI3S`
- ガウシアンスプラット: `gaussianSplatSorter`, `gaussianSplatTextureGenerator`

### Shaders/ (304 GLSL) - シェーダー

```
Shaders/
├── Builtin/           ← 組み込みシェーダー関数 (czm_* プレフィックス)
├── Materials/         ← マテリアルシェーダー
├── Appearances/       ← アピアランスシェーダー
├── Model/             ← glTF モデル用
├── Voxels/            ← ボクセル用
├── PostProcessStages/ ← ポストプロセス (FXAA, bloom 等)
└── *.glsl             ← Globe, Billboard, Polyline, Sky 等
```

## オブジェクト所有権の関係図

```
Viewer
 ├── CesiumWidget
 │    ├── Scene
 │    │    ├── Camera
 │    │    ├── Globe
 │    │    │    └── ImageryLayerCollection
 │    │    ├── SkyBox
 │    │    ├── SkyAtmosphere
 │    │    ├── Sun, Moon
 │    │    ├── PrimitiveCollection (primitives)
 │    │    ├── PrimitiveCollection (groundPrimitives)
 │    │    ├── PostProcessStageCollection
 │    │    └── ScreenSpaceCameraController
 │    ├── DataSourceDisplay
 │    │    └── Visualizer 群
 │    ├── DataSourceCollection
 │    └── Clock
 ├── Animation (widget)
 ├── Timeline (widget)
 ├── BaseLayerPicker (widget)
 ├── Geocoder (widget)
 ├── HomeButton (widget)
 ├── InfoBox (widget)
 └── ... (他ウィジェット)
```
