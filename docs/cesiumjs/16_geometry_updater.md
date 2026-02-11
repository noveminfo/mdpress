# 16. GeometryUpdater — Entity → GeometryInstance 変換の詳細

## 概要

GeometryUpdater は **Entity の Graphics プロパティ（EllipseGraphics, PolygonGraphics 等）を描画可能な GeometryInstance に変換する中間層**です。

Entity API のユーザーは「楕円を描きたい」と宣言的に記述しますが、WebGL 描画には頂点データ（GeometryInstance）と外観（Appearance）を持つ Primitive が必要です。この変換を担うのが GeometryUpdater 系クラスです。

```
Entity.ellipse (EllipseGraphics)
    │
    ▼
EllipseGeometryUpdater
    │  _onEntityPropertyChanged() → Static/Dynamic 判定
    │  createFillGeometryInstance(time) → GeometryInstance 生成
    │
    ▼
GeometryVisualizer → バッチ振り分け
    │
    ▼
StaticGeometryColorBatch / DynamicGeometryBatch
    │  Batch.update() → new Primitive({ geometryInstances: [...] })
    │
    ▼
Primitive → DrawCommand → WebGL
```

## クラス階層

### 継承構造

```
GeometryUpdater (基底クラス)
├── GroundGeometryUpdater (地形対応拡張)
│   ├── EllipseGeometryUpdater
│   ├── CorridorGeometryUpdater
│   ├── PolygonGeometryUpdater
│   ├── RectangleGeometryUpdater
│   └── PlaneGeometryUpdater
├── BoxGeometryUpdater
├── CylinderGeometryUpdater
├── EllipsoidGeometryUpdater
├── PolylineVolumeGeometryUpdater
└── WallGeometryUpdater
```

### 10種類の GeometryUpdater

**ファイル**: `packages/engine/Source/DataSources/GeometryUpdaterSet.js` L15-26

```javascript
const geometryUpdaters = [
  BoxGeometryUpdater,
  CylinderGeometryUpdater,
  CorridorGeometryUpdater,
  EllipseGeometryUpdater,
  EllipsoidGeometryUpdater,
  PlaneGeometryUpdater,
  PolygonGeometryUpdater,
  PolylineVolumeGeometryUpdater,
  RectangleGeometryUpdater,
  WallGeometryUpdater,
];
```

Entity 1つにつき **10個全ての GeometryUpdater** が生成される（GeometryUpdaterSet）。
実際にアクティブになるのは該当する Graphics プロパティが定義されているものだけ。

## GeometryUpdater 基底クラス

**ファイル**: `packages/engine/Source/DataSources/GeometryUpdater.js`

### コンストラクタ (L39-73)

```javascript
function GeometryUpdater(options) {
  const entity = options.entity;
  const geometryPropertyName = options.geometryPropertyName;

  this._entity = entity;
  this._scene = options.scene;
  this._fillEnabled = false;
  this._isClosed = false;
  this._onTerrain = false;
  this._dynamic = false;              // ★ Static か Dynamic か
  this._outlineEnabled = false;
  this._geometryChanged = new Event(); // ★ 変更通知イベント
  this._materialProperty = undefined;
  this._options = options.geometryOptions;
  this._geometryPropertyName = geometryPropertyName;
  this._id = `${geometryPropertyName}-${entity.id}`;
  this._observedPropertyNames = options.observedPropertyNames;
}
```

### 主要プロパティ（getter）

| プロパティ | 型 | 説明 |
|---|---|---|
| `entity` | Entity | 対象エンティティ |
| `id` | string | `"ellipse-entity123"` 形式の一意ID |
| `fillEnabled` | boolean | 塗りつぶし有効か |
| `outlineEnabled` | boolean | アウトライン有効か |
| `isDynamic` | boolean | **動的プロパティを含むか** |
| `isClosed` | boolean | 閉じたジオメトリか（背面カリング用） |
| `onTerrain` | boolean | 地形上に描画するか |
| `fillMaterialProperty` | MaterialProperty | 塗りつぶしマテリアル |
| `outlineColorProperty` | Property | アウトライン色 |
| `shadowsProperty` | Property | シャドウモード |
| `geometryChanged` | Event | ジオメトリ変更イベント |

## _onEntityPropertyChanged — 変更検知と分類

**ファイル**: `GeometryUpdater.js` L408-503

Entity のプロパティが変更されると呼ばれる**最重要メソッド**。
Static/Dynamic の判定とプロパティ収集を行う。

```
Entity.definitionChanged
    │
    ▼
_onEntityPropertyChanged(entity, propertyName, newValue, oldValue)
    │
    ├── observedPropertyNames に含まれない → return（無関係な変更）
    │
    ├── geometry が undefined → fillEnabled/outlineEnabled = false
    │
    ├── fill/outline 両方 false → 無効化
    │
    ├── _isHidden() → show が定数 false → 無効化
    │
    ├── プロパティ収集:
    │   materialProperty, fillProperty, showProperty,
    │   outlineColorProperty, shadowsProperty, etc.
    │
    ├── onTerrain 判定:
    │   _isOnTerrain() && (supportsMaterials || ColorMaterial)
    │
    └── ★ 分岐:
        ├── _isDynamic() → true  → this._dynamic = true
        │                         → geometryChanged.raiseEvent()
        │
        └── _isDynamic() → false → _setStaticOptions() でオプション確定
                                  → _getIsClosed() で閉じ判定
                                  → this._dynamic = false
                                  → geometryChanged.raiseEvent()
```

### _isDynamic の判定基準（EllipseGeometryUpdater の例）

**ファイル**: `EllipseGeometryUpdater.js` L221-238

```javascript
function _isDynamic(entity, ellipse) {
  return (
    !entity.position.isConstant ||        // 位置が動的
    !ellipse.semiMajorAxis.isConstant ||   // 長軸が動的
    !ellipse.semiMinorAxis.isConstant ||   // 短軸が動的
    !Property.isConstant(ellipse.rotation) ||
    !Property.isConstant(ellipse.height) ||
    !Property.isConstant(ellipse.extrudedHeight) ||
    !Property.isConstant(ellipse.granularity) ||
    !Property.isConstant(ellipse.stRotation) ||
    !Property.isConstant(ellipse.outlineWidth) ||
    !Property.isConstant(ellipse.numberOfVerticalLines) ||
    !Property.isConstant(ellipse.zIndex) ||
    (this._onTerrain && !Property.isConstant(this._materialProperty) &&
      !(this._materialProperty instanceof ColorMaterialProperty))
  );
}
```

**ポイント**: ジオメトリの**形状に影響するプロパティ**が1つでも動的（SampledProperty 等）なら Dynamic。
色だけが動的な場合は Static（per-instance attribute で更新可能なため）。

## GeometryInstance の生成

### createFillGeometryInstance (EllipseGeometryUpdater の例)

**ファイル**: `EllipseGeometryUpdater.js` L80-139

```javascript
function createFillGeometryInstance(time) {
  const entity = this._entity;
  const isAvailable = entity.isAvailable(time);

  // ① per-instance attributes の構築
  const attributes = {
    show: new ShowGeometryInstanceAttribute(
      isAvailable && entity.isShowing &&
      this._showProperty.getValue(time) &&
      this._fillProperty.getValue(time)
    ),
    distanceDisplayCondition: DistanceDisplayConditionGeometryInstanceAttribute
      .fromDistanceDisplayCondition(this._distanceDisplayConditionProperty.getValue(time)),
    offset: undefined,
    color: undefined,
  };

  // ② ColorMaterial の場合は色を attribute に
  if (this._materialProperty instanceof ColorMaterialProperty) {
    let currentColor = this._materialProperty.color.getValue(time, scratchColor);
    if (!defined(currentColor)) currentColor = Color.WHITE;
    attributes.color = ColorGeometryInstanceAttribute.fromColor(currentColor);
  }

  // ③ GeometryInstance を返す
  return new GeometryInstance({
    id: entity,                          // ★ id に Entity を設定（ピッキング用）
    geometry: new EllipseGeometry(this._options),  // ★ 実際のジオメトリ
    attributes: attributes,
  });
}
```

### _setStaticOptions — Static ジオメトリのオプション確定

**ファイル**: `EllipseGeometryUpdater.js` L240-322

Static の場合、`Iso8601.MINIMUM_VALUE`（= 最初の時刻）で全プロパティを評価し、
options オブジェクトに格納する。以降これが `EllipseGeometry` のコンストラクタに渡る。

```javascript
function _setStaticOptions(entity, ellipse) {
  const options = this._options;

  // vertexFormat: ColorMaterial → PerInstanceColor 用、それ以外 → MaterialAppearance 用
  options.vertexFormat =
    this._materialProperty instanceof ColorMaterialProperty
      ? PerInstanceColorAppearance.VERTEX_FORMAT
      : MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat;

  // 全パラメータを Iso8601.MINIMUM_VALUE で評価
  options.center = entity.position.getValue(Iso8601.MINIMUM_VALUE, options.center);
  options.semiMajorAxis = ellipse.semiMajorAxis.getValue(Iso8601.MINIMUM_VALUE);
  options.semiMinorAxis = ellipse.semiMinorAxis.getValue(Iso8601.MINIMUM_VALUE);
  options.rotation = Property.getValueOrUndefined(ellipse.rotation, Iso8601.MINIMUM_VALUE);
  // ... 他のパラメータも同様

  // 高さ参照の処理（CLAMP_TO_GROUND の場合は地形高取得）
  options.height = GroundGeometryUpdater.getGeometryHeight(heightValue, heightReferenceValue);
  options.extrudedHeight = extrudedHeightValue;
}
```

### createOutlineGeometryInstance

**ファイル**: `EllipseGeometryUpdater.js` L149-204

Fill と同じ構造だが、`EllipseOutlineGeometry` を使用し、色は `outlineColor` を設定:

```javascript
return new GeometryInstance({
  id: entity,
  geometry: new EllipseOutlineGeometry(this._options),  // ★ Outline 用ジオメトリ
  attributes: attributes,
});
```

## GroundGeometryUpdater — 地形対応拡張

**ファイル**: `packages/engine/Source/DataSources/GroundGeometryUpdater.js`

GeometryUpdater を継承し、地形クランプ関連の機能を追加:

```javascript
function GroundGeometryUpdater(options) {
  GeometryUpdater.call(this, options);
  this._zIndex = 0;
  this._terrainOffsetProperty = undefined;
}
```

### 静的メソッド

| メソッド | 説明 |
|---|---|
| `getGeometryHeight(height, ref)` | HeightReference に応じた高さ計算 |
| `getGeometryExtrudedHeight(height, ref)` | 押し出し高さの計算 |
| `computeGeometryOffsetAttribute(...)` | オフセット属性の決定 |

EllipseGeometryUpdater, CorridorGeometryUpdater, PolygonGeometryUpdater, RectangleGeometryUpdater, PlaneGeometryUpdater がこれを継承。

## GeometryVisualizer — バッチ管理

**ファイル**: `packages/engine/Source/DataSources/GeometryVisualizer.js`

GeometryVisualizer は GeometryUpdater の結果を**バッチに分類**し、
同じ特性のジオメトリをまとめて1つの Primitive にする。

### バッチ配列の構成（コンストラクタ L32-205）

```
GeometryVisualizer
├── _outlineBatches[8]          ← StaticOutlineGeometryBatch × (4 shadow × 2 offset)
├── _closedColorBatches[8]      ← StaticGeometryColorBatch × (4 shadow × 2 offset)
├── _closedMaterialBatches[8]   ← StaticGeometryPerMaterialBatch × (4 shadow × 2 offset)
├── _openColorBatches[8]        ← StaticGeometryColorBatch × (4 shadow × 2 offset)
├── _openMaterialBatches[8]     ← StaticGeometryPerMaterialBatch × (4 shadow × 2 offset)
├── _groundColorBatches[3]      ← StaticGroundGeometryColorBatch × 3 classification
├── _groundMaterialBatches[3]   ← StaticGroundGeometryPerMaterialBatch × 3 classification
└── _dynamicBatch              ← DynamicGeometryBatch（1つ）
```

合計: **最大 47 バッチ**（+ Dynamic 1つ）

### バッチの分類軸

| 軸 | 値 | 説明 |
|---|---|---|
| **Static/Dynamic** | 2 | プロパティが定数か動的か |
| **Color/Material** | 2 | ColorMaterialProperty か否か |
| **Closed/Open** | 2 | 閉じたジオメトリか（背面カリング） |
| **ShadowMode** | 4 | DISABLED/ENABLED/CAST_ONLY/RECEIVE_ONLY |
| **TerrainOffset** | 2 | 高さオフセットの有無 |
| **Ground/Normal** | 2 | 地形上か空中か |
| **ClassificationType** | 3 | TERRAIN/CESIUM_3D_TILE/BOTH（Ground のみ） |

### _insertUpdaterIntoBatch — 振り分けロジック

**ファイル**: `GeometryVisualizer.js` L428-497

```
_insertUpdaterIntoBatch(time, updater)
    │
    ├── updater.isDynamic?
    │   └── YES → _dynamicBatch.add(time, updater)
    │
    ├── updater.outlineEnabled?
    │   └── YES → _outlineBatches[shadow + offset].add(time, updater)
    │
    └── updater.fillEnabled?
        ├── updater.onTerrain?
        │   ├── ColorMaterial → _groundColorBatches[classificationType]
        │   └── Other        → _groundMaterialBatches[classificationType]
        │
        ├── updater.isClosed?
        │   ├── ColorMaterial → _closedColorBatches[shadow + offset]
        │   └── Other        → _closedMaterialBatches[shadow + offset]
        │
        └── Open
            ├── ColorMaterial → _openColorBatches[shadow + offset]
            └── Other        → _openMaterialBatches[shadow + offset]
```

## Static バッチ — 複数 Entity → 1 Primitive

### StaticGeometryColorBatch

**ファイル**: `packages/engine/Source/DataSources/StaticGeometryColorBatch.js`

同じ描画特性を持つ Static Entity を**1つの Primitive にまとめる**。

#### 内部構造

```
StaticGeometryColorBatch
├── _solidItems: Batch[]       ← 不透明ジオメトリ群
└── _translucentItems: Batch[]  ← 半透明ジオメトリ群

Batch (内部クラス)
├── geometry: AssociativeArray       ← id → GeometryInstance
├── updaters: AssociativeArray       ← id → GeometryUpdater
├── updatersWithAttributes: AssociativeArray  ← 動的 attribute を持つ Updater
├── primitive: Primitive             ← ★ 生成された Primitive
├── createPrimitive: boolean         ← 再構築フラグ
└── waitingOnCreate: boolean         ← 非同期生成待ち
```

#### add() — Updater の追加 (L417-448)

```javascript
StaticGeometryColorBatch.prototype.add = function(time, updater) {
  // ① GeometryInstance を生成
  const instance = updater.createFillGeometryInstance(time);

  // ② 透明度で solid/translucent を振り分け
  if (instance.attributes.color.value[3] === 255) {
    items = this._solidItems;     // 不透明
    translucent = false;
  } else {
    items = this._translucentItems; // 半透明
    translucent = true;
  }

  // ③ 既存 Batch と互換性があれば追加、なければ新 Batch
  for (let i = 0; i < items.length; i++) {
    if (items[i].isMaterial(updater)) {
      items[i].add(updater, instance);
      return;
    }
  }
  const batch = new Batch(primitives, translucent, ...);
  batch.add(updater, instance);
  items.push(batch);
};
```

#### Batch.update() — Primitive の生成と更新 (L122-335)

```
Batch.update(time)
    │
    ├── createPrimitive === true ?
    │   │
    │   ├── geometries.length > 0
    │   │   ├── 旧 Primitive を oldPrimitive に退避
    │   │   ├── ★ new Primitive({
    │   │   │     geometryInstances: geometries.slice(),  ← 全 GeometryInstance をまとめて渡す
    │   │   │     appearance: new PerInstanceColorAppearance({...}),
    │   │   │     asynchronous: true,  ← WebWorker でジオメトリ構築
    │   │   │     shadows: this.shadows,
    │   │   │   })
    │   │   └── primitives.add(primitive)
    │   │
    │   └── geometries.length === 0
    │       └── 旧 Primitive を削除
    │
    └── primitive.ready ?
        ├── oldPrimitive を削除
        ├── ★ 動的 attribute の更新:
        │   ├── color: ColorGeometryInstanceAttribute.toValue()
        │   ├── show: ShowGeometryInstanceAttribute
        │   ├── distanceDisplayCondition
        │   └── offset
        │
        └── 透明度が変わった → itemsToRemove に追加（Batch 移動）
```

**重要ポイント**:
- `asynchronous: true` で Primitive を作成 → **WebWorker** でジオメトリのテッセレーションを実行
- Primitive が `ready` になるまで旧 Primitive を表示し続ける（ちらつき防止）
- 色の変化は `getGeometryInstanceAttributes()` で **per-instance attribute を直接更新**（Primitive 再構築不要）
- 透明度が solid ↔ translucent を跨ぐ場合は Batch 間移動

### StaticGeometryPerMaterialBatch

**ファイル**: `packages/engine/Source/DataSources/StaticGeometryPerMaterialBatch.js`

ColorMaterial 以外（画像テクスチャ等）の場合に使用。
構造は StaticGeometryColorBatch と似ているが、`MaterialAppearance` を使用し、
同じマテリアルタイプの Updater 同士を1つの Batch にまとめる。

### StaticOutlineGeometryBatch

**ファイル**: `packages/engine/Source/DataSources/StaticOutlineGeometryBatch.js`

アウトライン専用バッチ。`createOutlineGeometryInstance()` を使い、
`PerInstanceColorAppearance({ flat: true })` で描画。

### StaticGroundGeometryColorBatch / StaticGroundGeometryPerMaterialBatch

地形クランプ用のバッチ。`Primitive` の代わりに `GroundPrimitive` を使用。
ClassificationType ごとに分かれる。

## Dynamic バッチ — 毎フレーム再構築

### DynamicGeometryBatch

**ファイル**: `packages/engine/Source/DataSources/DynamicGeometryBatch.js`

Dynamic な Entity（形状が時間変化する）専用。

```javascript
function DynamicGeometryBatch(primitives, orderedGroundPrimitives) {
  this._primitives = primitives;
  this._orderedGroundPrimitives = orderedGroundPrimitives;
  this._dynamicUpdaters = new AssociativeArray();  // DynamicGeometryUpdater の集合
}
```

#### add() (L13-21)

```javascript
DynamicGeometryBatch.prototype.add = function(time, updater) {
  this._dynamicUpdaters.set(
    updater.id,
    updater.createDynamicUpdater(this._primitives, this._orderedGroundPrimitives)
  );
};
```

`createDynamicUpdater()` が **DynamicGeometryUpdater** サブクラスのインスタンスを生成。

#### update() (L32-38)

```javascript
DynamicGeometryBatch.prototype.update = function(time) {
  const geometries = this._dynamicUpdaters.values;
  for (let i = 0, len = geometries.length; i < len; i++) {
    geometries[i].update(time);  // ★ 毎フレーム各 DynamicUpdater を更新
  }
  return true;
};
```

### DynamicGeometryUpdater

**ファイル**: `packages/engine/Source/DataSources/DynamicGeometryUpdater.js`

**毎フレーム Primitive を破棄・再生成**する。

#### update() (L67-184) — 主要処理

```
DynamicGeometryUpdater.update(time)
    │
    ├── ① 既存 Primitive を remove（毎フレーム）
    │     onTerrain ? orderedGroundPrimitives.remove()
    │               : primitives.removeAndDestroy()
    │
    ├── ② _setOptions(entity, geometry, time)
    │     → 現在時刻の全プロパティ値で options を更新
    │
    ├── ③ _isHidden() → 非表示なら return
    │
    ├── ④ Fill Primitive の生成
    │   ├── Appearance の選択:
    │   │   ├── ColorMaterial → PerInstanceColorAppearance
    │   │   └── Other → MaterialAppearance
    │   │
    │   ├── onTerrain ?
    │   │   └── new GroundPrimitive({
    │   │         geometryInstances: updater.createFillGeometryInstance(time),
    │   │         asynchronous: false,  ← ★ Dynamic は同期生成
    │   │       })
    │   └── Normal
    │       └── new Primitive({
    │             geometryInstances: fillInstance,
    │             asynchronous: false,
    │           })
    │
    └── ⑤ Outline Primitive の生成（onTerrain でない場合のみ）
        └── new Primitive({
              geometryInstances: outlineInstance,
              appearance: PerInstanceColorAppearance({ flat: true }),
              asynchronous: false,
            })
```

**Static vs Dynamic の重要な違い**:

| 項目 | Static | Dynamic |
|---|---|---|
| Primitive 生成 | 初回のみ + 変更時 | **毎フレーム** |
| `asynchronous` | `true`（WebWorker） | `false`（メインスレッド） |
| バッチング | 複数 Entity → 1 Primitive | **1 Entity → 1 Primitive** |
| 属性更新 | per-instance attribute | Primitive 再構築 |
| パフォーマンス | 高い | 低い（毎フレーム再構築のコスト） |

## GeometryVisualizer.update() — 全体の更新フロー

**ファイル**: `GeometryVisualizer.js` の update 関数

```
GeometryVisualizer.update(time)
    │
    ├── ① 変更された Entity を処理
    │   ├── Added → new GeometryUpdaterSet(entity, scene)
    │   │            → 10個の GeometryUpdater を生成
    │   │            → geometryChanged イベントを購読
    │   │
    │   ├── Removed → _removeUpdater(updater)
    │   │              → 対応する Batch から remove
    │   │
    │   └── Changed → _removeUpdater + _insertUpdaterIntoBatch
    │                  → Batch を再割り当て
    │
    ├── ② geometryChanged が発火した Updater を再処理
    │   → _removeUpdater + _insertUpdaterIntoBatch
    │
    └── ③ 全バッチの update(time) を呼ぶ
        for (const batch of this._batches) {
          batch.update(time);  // → Primitive 生成 or 属性更新
        }
```

## データフローまとめ

```
Entity                                     WebGL
  │                                          ▲
  │ entity.ellipse = new EllipseGraphics()   │
  ▼                                          │
GeometryUpdaterSet                           │
  │ 10個の GeometryUpdater を生成            │
  ▼                                          │
EllipseGeometryUpdater                       │
  │ _onEntityPropertyChanged()               │
  │ → Static/Dynamic 判定                    │
  │ → _setStaticOptions() or skip            │
  │ → geometryChanged.raiseEvent()           │
  ▼                                          │
GeometryVisualizer._insertUpdaterIntoBatch() │
  │ 分類: Shadow × Color/Material ×          │
  │       Closed/Open × Ground × Offset      │
  ▼                                          │
┌─ Static Path ───────────────┐              │
│ StaticGeometryColorBatch    │              │
│   .add(time, updater)       │              │
│   → createFillGeometryInstance(time)       │
│   → GeometryInstance を Batch に蓄積       │
│   .update(time)             │              │
│   → new Primitive({         │              │
│       geometryInstances: [all], ← ★バッチ  │
│       asynchronous: true    │              │
│     })                      │──────────────┘
└─────────────────────────────┘
                                             │
┌─ Dynamic Path ──────────────┐              │
│ DynamicGeometryBatch        │              │
│   .add(time, updater)       │              │
│   → createDynamicUpdater()  │              │
│   .update(time)             │              │
│   → DynamicGeometryUpdater  │              │
│     .update(time)           │              │
│     → remove old Primitive  │              │
│     → _setOptions(time)     │              │
│     → createFillGeometryInstance(time)     │
│     → new Primitive({       │              │
│         asynchronous: false ← ★毎フレーム  │
│       })                    │──────────────┘
└─────────────────────────────┘
```

## パフォーマンスへの影響

### Static の利点
- **バッチング**: 同じ特性の Entity が1つの Primitive にまとまる
  - 例: 100個の赤い楕円 → 1つの Primitive（1回の drawCall）
- **非同期構築**: WebWorker でジオメトリ計算 → メインスレッドを阻害しない
- **属性更新**: 色・表示の変更は per-instance attribute で O(1)

### Dynamic の代償
- **バッチング不可**: 1 Entity = 1 Primitive
- **毎フレーム再構築**: Primitive を destroy → 新規作成 → ジオメトリ計算（同期）
- **対策**: 可能な限り SampledProperty を避け ConstantProperty を使う

### 最適化のヒント
1. **色だけ変える場合は Static のまま** — `color` が SampledProperty でも形状は Static
2. **SampledPositionProperty + CallbackProperty で形状を変えると Dynamic** — 避ける
3. **大量の Entity には DataSource.entities.suspendEvents()** — バッチ再構築を遅延

## 関連ファイル

| ファイル | 関係 |
|---|---|
| `DataSources/GeometryUpdater.js` | 基底クラス |
| `DataSources/GroundGeometryUpdater.js` | 地形対応サブクラス |
| `DataSources/EllipseGeometryUpdater.js` | 代表的なサブクラス実装 |
| `DataSources/GeometryUpdaterSet.js` | 10種全 Updater を管理 |
| `DataSources/GeometryVisualizer.js` | バッチ管理・全体制御 |
| `DataSources/StaticGeometryColorBatch.js` | Static + Color バッチ |
| `DataSources/StaticGeometryPerMaterialBatch.js` | Static + Material バッチ |
| `DataSources/StaticOutlineGeometryBatch.js` | Outline バッチ |
| `DataSources/StaticGroundGeometryColorBatch.js` | 地形 + Color バッチ |
| `DataSources/StaticGroundGeometryPerMaterialBatch.js` | 地形 + Material バッチ |
| `DataSources/DynamicGeometryBatch.js` | Dynamic バッチ管理 |
| `DataSources/DynamicGeometryUpdater.js` | Dynamic 毎フレーム更新 |
| `Scene/Primitive.js` | GeometryInstance → DrawCommand 変換 |
| `Scene/GroundPrimitive.js` | 地形クランプ Primitive |
| `Core/GeometryInstance.js` | ジオメトリ + attribute のコンテナ |
