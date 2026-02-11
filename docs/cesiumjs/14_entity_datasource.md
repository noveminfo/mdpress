# 14. Entity / DataSource - 高レベル描画 API

## 概要

Entity / DataSource は CesiumJS の**高レベル API**です。
開発者は Entity を追加するだけで、内部的に適切な Primitive が生成・管理され、
DrawCommand として描画されます。

```
ユーザーコード (Entity API)
  ↓
DataSourceDisplay (Visualizer 管理)
  ↓
Visualizer (Entity → Primitive 変換)
  ↓
Primitive / Collection (DrawCommand 生成)
  ↓
Scene.render() → WebGL 描画
```

## クラス構成

```
Viewer
 └── CesiumWidget
      ├── DataSourceDisplay              ← Visualizer の統括管理
      │    ├── _dataSourceCollection      ← DataSource 群
      │    │    ├── CzmlDataSource        ← CZML フォーマット
      │    │    ├── GeoJsonDataSource     ← GeoJSON フォーマット
      │    │    └── CustomDataSource      ← カスタムデータ
      │    │         └── EntityCollection ← Entity の集合
      │    │              └── Entity[]    ← 個々のエンティティ
      │    └── _defaultDataSource         ← viewer.entities 用
      │
      └── Scene
           └── PrimitiveCollection       ← Visualizer が管理する Primitive 群
```

## Entity - 高レベルオブジェクト

**ファイル**: `packages/engine/Source/DataSources/Entity.js`

### コンストラクタ

```javascript
const entity = new Entity({
  id: "myEntity",           // 省略時は GUID 自動生成
  name: "東京タワー",
  show: true,
  position: Cartesian3.fromDegrees(139.7454, 35.6586, 333),
  point: { pixelSize: 10, color: Color.RED },
  // billboard, box, corridor, cylinder, ellipse, ellipsoid,
  // label, model, tileset, path, plane, polygon, polyline,
  // polylineVolume, rectangle, wall も設定可能
});
```

### プロパティ構造

Entity は **22種類のプロパティ**を持つ:

| カテゴリ | プロパティ |
|---|---|
| **基本** | id, name, show, availability, description, parent |
| **空間** | position, orientation, viewFrom |
| **描画型** | billboard, box, corridor, cylinder, ellipse, ellipsoid, label, model, tileset, path, plane, point, polygon, polyline, polylineVolume, rectangle, wall |
| **カスタム** | properties, trackingReferenceFrame |

### プロパティの自動変換

```javascript
// ユーザーが設定
entity.point = { pixelSize: 10, color: Color.RED };

// 内部で自動変換:
// → new PointGraphics({ pixelSize: 10, color: Color.RED })

// さらに PointGraphics 内で:
// pixelSize: 10 → new ConstantProperty(10)
// color: Color.RED → new ConstantProperty(Color.RED)
```

`createPropertyTypeDescriptor` により、プレーンオブジェクトが適切な Graphics クラスに自動変換される。

### definitionChanged イベント

Entity のプロパティが変更されると `definitionChanged` イベントが発火:

```javascript
entity.definitionChanged.addEventListener(function(entity, propertyName, newValue, oldValue) {
  console.log(`${propertyName} が変更された`);
});
```

これを EntityCollection が監視し、Visualizer に変更を通知する。

## Property システム - 時間変化する値

**ファイル**: `packages/engine/Source/DataSources/Property.js`

### Property インターフェース

```javascript
// Property は抽象クラス（インスタンス化不可）
class Property {
  get isConstant() { ... }         // 時間に依存しないか
  get definitionChanged() { ... }  // 定義変更イベント
  getValue(time, result) { ... }   // 指定時刻の値を取得
  equals(other) { ... }
}
```

### Property の実装クラス

| クラス | 説明 | 例 |
|---|---|---|
| **ConstantProperty** | 固定値 | `color: Color.RED` |
| **SampledProperty** | 時系列サンプル（補間あり） | GPS 軌跡 |
| **TimeIntervalCollectionProperty** | 時間区間ごとの値 | 状態変化 |
| **CompositeProperty** | 複数 Property の合成 | 区間ごとに異なる補間 |
| **ConstantPositionProperty** | 固定位置（参照フレーム付き） | 静止オブジェクト |
| **SampledPositionProperty** | 位置の時系列 | 衛星軌道 |
| **ReferenceProperty** | 他 Entity のプロパティ参照 | CZML で使用 |
| **CallbackProperty** | コールバック関数 | 動的計算値 |

### Property.getValueOrDefault パターン

Visualizer は毎フレーム Property から値を取得する:

```javascript
// null チェック + デフォルト値 + result 再利用を一括処理
const color = Property.getValueOrDefault(
  entity._point._color,     // Property (undefined の可能性あり)
  time,                      // JulianDate
  defaultColor,              // デフォルト値
  colorScratch,              // result パラメータ (GC 回避)
);
```

内部実装:
```javascript
Property.getValueOrUndefined = function(property, time, result) {
  return defined(property) ? property.getValue(time, result) : undefined;
};
```

### SampledProperty の補間

```javascript
const position = new SampledPositionProperty();
position.addSample(time0, cartesian0);
position.addSample(time1, cartesian1);
position.addSample(time2, cartesian2);

// 補間アルゴリズムの設定
position.setInterpolationOptions({
  interpolationAlgorithm: LagrangePolynomialApproximation,
  interpolationDegree: 5,
});

// time0 と time1 の間の任意の時刻で補間値を取得
position.getValue(timeBetween0And1);  // → 補間された Cartesian3
```

## DataSource - データの入口

### DataSource インターフェース

全ての DataSource が持つプロパティ:

| プロパティ | 型 | 説明 |
|---|---|---|
| `entities` | EntityCollection | Entity の集合 |
| `name` | string | データソース名 |
| `show` | boolean | 表示/非表示 |
| `clock` | DataSourceClock | 時間設定 |
| `clustering` | EntityCluster | クラスタリング設定 |
| `isLoading` | boolean | ロード中か |
| `changedEvent` | Event | 変更イベント |
| `errorEvent` | Event | エラーイベント |
| `loadingEvent` | Event | ロード状態変更イベント |

### DataSource の種類

| クラス | 入力 | 用途 |
|---|---|---|
| **CustomDataSource** | なし | `viewer.entities` 用、手動 Entity 管理 |
| **GeoJsonDataSource** | GeoJSON/TopoJSON | 地理データの読み込み |
| **CzmlDataSource** | CZML | 時系列データの読み込み |
| **KmlDataSource** | KML/KMZ | Google Earth データ |
| **GpxDataSource** | GPX | GPS トラックデータ |

### DataSource の使い方

```javascript
// 1. CustomDataSource (viewer.entities は内部的にこれ)
viewer.entities.add({ position: ..., point: { ... } });

// 2. GeoJsonDataSource
const geoJson = await GeoJsonDataSource.load("data.geojson", {
  stroke: Color.HOTPINK,
  fill: Color.PINK.withAlpha(0.5),
  strokeWidth: 3,
});
viewer.dataSources.add(geoJson);

// 3. CzmlDataSource
const czml = await CzmlDataSource.load("satellite.czml");
viewer.dataSources.add(czml);
```

## EntityCollection - Entity の管理

**ファイル**: `packages/engine/Source/DataSources/EntityCollection.js`

```javascript
const collection = new EntityCollection();

// CRUD 操作
collection.add(entity);           // 追加
collection.remove(entity);        // 削除
collection.removeById(id);        // ID で削除
collection.removeAll();           // 全削除
collection.getById(id);           // ID で取得
collection.getOrCreateEntity(id); // 取得 or 作成
collection.contains(entity);      // 含まれるか

// イベント
collection.collectionChanged.addEventListener(
  function(collection, added, removed, changed) {
    // added: 追加された Entity[]
    // removed: 削除された Entity[]
    // changed: 変更された Entity[]
  }
);

// イベントのバッチ処理
collection.suspendEvents();  // イベント発火を一時停止
// ... 大量の add/remove ...
collection.resumeEvents();   // まとめてイベント発火
```

## DataSourceDisplay - Visualizer の統括

**ファイル**: `packages/engine/Source/DataSources/DataSourceDisplay.js`

### 役割

1. DataSource が追加されたら Visualizer 群を生成
2. 毎フレーム（`_onTick`）で全 Visualizer の `update(time)` を呼ぶ
3. DataSource ごとに PrimitiveCollection を管理

### Visualizer の生成 (defaultVisualizersCallback)

DataSource が追加されると、8種類の Visualizer が自動生成される:

```javascript
DataSourceDisplay.defaultVisualizersCallback = function(scene, entityCluster, dataSource) {
  return [
    new BillboardVisualizer(entityCluster, entities),   // ビルボード
    new GeometryVisualizer(scene, entities, ...),       // ジオメトリ全般
    new LabelVisualizer(entityCluster, entities),       // ラベル
    new ModelVisualizer(scene, entities),               // glTF モデル
    new Cesium3DTilesetVisualizer(scene, entities),     // 3D Tiles
    new PointVisualizer(entityCluster, entities),       // ポイント
    new PathVisualizer(scene, entities),                // パス（軌跡）
    new PolylineVisualizer(scene, entities, ...),       // ポリライン
  ];
};
```

### 毎フレームの update フロー

```
CesiumWidget._onTick(clock)
  └── DataSourceDisplay.update(time)
       ├── dataSource.update(time)              ← DataSource 自体の更新
       └── for each visualizer:
            visualizer.update(time)             ← Entity → Primitive 変換
                ├── Property.getValue(time)     ← 時刻に応じた値取得
                └── primitive の属性更新        ← Primitive に反映
```

## Visualizer - Entity → Primitive 変換

### Visualizer の種類と担当

| Visualizer | Entity プロパティ | 内部 Primitive |
|---|---|---|
| **PointVisualizer** | point | PointPrimitiveCollection / BillboardCollection |
| **BillboardVisualizer** | billboard | BillboardCollection |
| **LabelVisualizer** | label | LabelCollection |
| **ModelVisualizer** | model | Model |
| **Cesium3DTilesetVisualizer** | tileset | Cesium3DTileset |
| **PathVisualizer** | path | PolylineCollection |
| **PolylineVisualizer** | polyline | PolylineCollection / GroundPolylinePrimitive |
| **GeometryVisualizer** | box, corridor, cylinder, ellipse, ellipsoid, plane, polygon, polylineVolume, rectangle, wall | Primitive / GroundPrimitive |

### PointVisualizer の update 例

毎フレーム、Entity の Point プロパティから値を読み取り、Primitive に反映:

```javascript
PointVisualizer.prototype.update = function(time) {
  for (each tracked entity) {
    // 1. 表示判定
    let show = entity.isShowing
            && entity.isAvailable(time)
            && Property.getValueOrDefault(pointGraphics._show, time, true);

    // 2. 位置取得
    const position = Property.getValueOrUndefined(entity._position, time, scratch);

    // 3. HeightReference による分岐
    if (heightReference !== HeightReference.NONE) {
      // → Billboard を使用（地形クランプ対応）
      billboard.position = position;
      billboard.heightReference = heightReference;
      // ... Billboard にポイント画像を生成
    } else {
      // → PointPrimitive を使用
      pointPrimitive.position = position;
      pointPrimitive.color = Property.getValueOrDefault(color, time, defaultColor);
      pointPrimitive.pixelSize = Property.getValueOrDefault(pixelSize, time, 1);
      // ...
    }
  }
};
```

### GeometryVisualizer のバッチ処理

GeometryVisualizer は**10種類のジオメトリ**を担当し、効率化のためバッチ処理を行う:

```
GeometryVisualizer
 ├── GeometryUpdaterSet (Entity ごと)
 │    └── [BoxGeometryUpdater, CylinderGeometryUpdater, CorridorGeometryUpdater,
 │         EllipseGeometryUpdater, EllipsoidGeometryUpdater, PlaneGeometryUpdater,
 │         PolygonGeometryUpdater, PolylineVolumeGeometryUpdater,
 │         RectangleGeometryUpdater, WallGeometryUpdater]
 │
 ├── Static バッチ (isConstant な Entity をまとめて1つの Primitive に)
 │    ├── StaticGeometryColorBatch        ← 単色ジオメトリのバッチ
 │    ├── StaticGeometryPerMaterialBatch  ← マテリアル別バッチ
 │    ├── StaticOutlineGeometryBatch      ← アウトライン別バッチ
 │    ├── StaticGroundGeometryColorBatch  ← 地表貼り付け色バッチ
 │    └── StaticGroundGeometryPerMaterialBatch ← 地表マテリアルバッチ
 │
 └── DynamicGeometryBatch                ← 動的 Entity（毎フレーム再生成）
```

**バッチの分類基準**:
- **Closed vs Open**: 閉じたジオメトリ（Box 等）vs 開いたジオメトリ（Wall 等）→ 背面カリング設定
- **Color vs Material**: PerInstanceColor vs MaterialAppearance
- **ShadowMode**: シャドウ設定ごとにバッチ
- **Ground vs Normal**: 地表貼り付けか通常描画か

## 全体データフロー

```
viewer.entities.add({
  position: Cartesian3.fromDegrees(139.7, 35.7, 100),
  point: { pixelSize: 10, color: Color.RED }
})
  │
  ├─① Entity 生成
  │   entity.point = new PointGraphics({ pixelSize: new ConstantProperty(10), ... })
  │
  ├─② EntityCollection.add(entity)
  │   → collectionChanged イベント発火
  │
  ├─③ PointVisualizer._onCollectionChanged(added=[entity])
  │   → items に entity を追加
  │
  ├─④ 毎フレーム: CesiumWidget._onTick()
  │   └─ DataSourceDisplay.update(time)
  │       └─ PointVisualizer.update(time)
  │           ├─ entity._point._color.getValue(time) → Color.RED
  │           ├─ entity._position.getValue(time) → Cartesian3
  │           └─ pointPrimitive.position = position
  │              pointPrimitive.color = color
  │              pointPrimitive.pixelSize = 10
  │
  └─⑤ Scene.render()
      └─ PointPrimitiveCollection.update(frameState)
          └─ frameState.commandList.push(drawCommand)
              → WebGL 描画
```

## CZML DataSource

**ファイル**: `packages/engine/Source/DataSources/CzmlDataSource.js` (~大規模ファイル)

CZML は CesiumJS 独自の JSON ベース時系列データフォーマット:

```json
[{
  "id": "document",
  "version": "1.0"
}, {
  "id": "satellite",
  "position": {
    "epoch": "2024-01-01T00:00:00Z",
    "cartographicDegrees": [
      0, 139.7, 35.7, 400000,
      3600, 140.0, 36.0, 400000
    ],
    "interpolationAlgorithm": "LAGRANGE",
    "interpolationDegree": 5
  },
  "point": {
    "pixelSize": 8,
    "color": { "rgba": [255, 0, 0, 255] }
  }
}]
```

CzmlDataSource は CZML パケットをパースし、適切な Property（SampledProperty 等）に変換:

```
CZML packet.position
  → processPositionPacketData()
    → SampledPositionProperty.addSamples(times, values)

CZML packet.point.color
  → processPacketData()
    → ConstantProperty(Color.RED)
```

## GeoJSON DataSource

**ファイル**: `packages/engine/Source/DataSources/GeoJsonDataSource.js`

GeoJSON の各 feature type を Entity に変換:

| GeoJSON Type | Entity プロパティ |
|---|---|
| Point / MultiPoint | billboard + label |
| LineString / MultiLineString | polyline |
| Polygon / MultiPolygon | polygon |
| GeometryCollection | 複合 |

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `DataSources/Entity.js` | Entity 本体 |
| `DataSources/EntityCollection.js` | Entity の集合管理 |
| `DataSources/DataSourceDisplay.js` | Visualizer 統括 |
| `DataSources/Property.js` | Property インターフェース |
| `DataSources/ConstantProperty.js` | 固定値 Property |
| `DataSources/SampledProperty.js` | 時系列サンプル Property |
| `DataSources/SampledPositionProperty.js` | 位置の時系列 |
| `DataSources/CallbackProperty.js` | コールバック Property |
| `DataSources/ReferenceProperty.js` | 参照 Property |
| `DataSources/PointVisualizer.js` | Point Visualizer |
| `DataSources/BillboardVisualizer.js` | Billboard Visualizer |
| `DataSources/GeometryVisualizer.js` | ジオメトリ Visualizer |
| `DataSources/GeometryUpdaterSet.js` | ジオメトリ Updater 管理 |
| `DataSources/PointGraphics.js` | Point の描画設定 |
| `DataSources/PolygonGraphics.js` | Polygon の描画設定 |
| `DataSources/CustomDataSource.js` | カスタム DataSource |
| `DataSources/CzmlDataSource.js` | CZML パーサー |
| `DataSources/GeoJsonDataSource.js` | GeoJSON パーサー |
