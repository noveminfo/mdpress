# 07. コードベース学習ロードマップ

## 推奨アプローチ: 「上から下へ、使う順に」

CesiumJS は ~367K LOC、972ファイルと巨大です。
4つのフェーズに分けて段階的に読むのが最も効率的です。

## Phase 1: エントリーポイント (1-2日)

**目標**: Viewer → CesiumWidget → Scene の生成チェーンを理解する

### 読むファイル

| ファイル | 行数 | ポイント |
|---|---|---|
| `engine/Source/Widget/CesiumWidget.js` | ~1600行 | 全ての起点。Scene/Globe/Camera の生成 |
| `widgets/Source/Viewer/Viewer.js` | ~2030行 | CesiumWidget のラッパー。実際に使う API |

### 理解すべきこと

- Viewer が CesiumWidget を作り、CesiumWidget が Scene/Globe/Camera を作る
- `startRenderLoop()` で requestAnimationFrame ループが開始
- 毎フレーム `render()` → `_onTick()` → `scene.render()` が呼ばれる

→ 詳細: [04_entry_points.md](./04_entry_points.md)

## Phase 2: Scene レイヤー (1週間)

**目標**: 描画ループ (render pipeline) を理解する

### 読むファイル

| 優先度 | ファイル | ポイント |
|---|---|---|
| 1 | `Scene/Scene.js` | `render()` メソッド = 毎フレームの描画ループ |
| 2 | `Scene/Globe.js` | 地球の描画、タイルシステム |
| 3 | `Scene/Camera.js` | カメラ制御、視錐台、飛行アニメーション |
| 4 | `Scene/FrameState.js` | フレーム情報の受け渡し構造体 |
| 5 | `Scene/Primitive.js` | プリミティブの基本パターン |
| 6 | `Renderer/Pass.js` | レンダリングパス定義 |
| 7 | `Renderer/DrawCommand.js` | 描画コマンド構造 |

### 理解すべきこと

- Scene.render() の 2 つの関数 (公開 + 内部)
- マルチフラスタム描画 (広大な距離レンジ対応)
- パス順序 (ENVIRONMENT → GLOBE → 3D_TILE → OPAQUE → TRANSLUCENT)
- コマンドパターン (Primitive.update() → DrawCommand → WebGL)

→ 詳細: [03_rendering_pipeline.md](./03_rendering_pipeline.md)

### 実践テクニック

**Scene.render() にブレークポイントを置いて 1 フレームの処理を追跡する**

```javascript
// DevTools Console で
Cesium.Scene.prototype.render = (function(original) {
  return function(time) {
    debugger; // ここで停止
    return original.call(this, time);
  };
})(Cesium.Scene.prototype.render);
```

## Phase 3: 座標系と数学 (3-4日)

**目標**: CesiumJS の座標系を理解する

### 読むファイル

| ファイル | ポイント |
|---|---|
| `Core/Cartesian3.js` | 3D ベクトル (ECEF 座標系) |
| `Core/Cartographic.js` | 経緯度+高度 (ラジアン) |
| `Core/Ellipsoid.js` | WGS84 楕円体、座標変換の中心 |
| `Core/Transforms.js` | ENU/ECEF/固定フレーム変換 |
| `Core/Matrix4.js` | 変換行列 |
| `Core/Math.js` | 数学ユーティリティ (度⇔ラジアン等) |

### 重要な概念

#### ECEF 座標系 (Earth-Centered, Earth-Fixed)

CesiumJS の全 Cartesian3 は **ECEF 座標系** です。

```
原点: 地球の中心
X軸: 赤道面上、グリニッジ子午線方向
Y軸: 赤道面上、東経90度方向
Z軸: 北極方向

地表の点の Cartesian3 値:
  東京 ≈ (-3959000, 3352000, 3698000) メートル
```

#### 座標変換の流れ

```
経緯度 (Cartographic)
  ↕ Ellipsoid.cartographicToCartesian()
ECEF (Cartesian3)
  ↕ Transforms.eastNorthUpToFixedFrame()
ローカル ENU フレーム
  ↕ Camera の view matrix
カメラ空間
  ↕ Camera の projection matrix
クリップ空間 → 画面
```

## Phase 4: Entity/DataSource (3-4日)

**目標**: 高レベル API の仕組みを理解する

### 読むファイル

| ファイル | ポイント |
|---|---|
| `DataSources/Entity.js` | 高レベルオブジェクト |
| `DataSources/Property.js` | 時間変化プロパティの抽象化 |
| `DataSources/DataSourceDisplay.js` | Entity → Primitive への変換ハブ |
| `DataSources/GeometryVisualizer.js` | ジオメトリ描画の仕組み |
| `DataSources/CzmlDataSource.js` | CZML パーサー (大規模) |

### 理解すべきこと

Entity 追加から描画までのフロー:

```
viewer.entities.add({ position, point: { pixelSize: 10 } })
  │
  ├─ Entity 作成 (EntityCollection に追加)
  │
  ├─ DataSourceDisplay._onTick() で検知
  │    └─ Visualizer.update(time)
  │         └─ PointVisualizer → PointPrimitiveCollection に追加
  │
  └─ Scene.render()
       └─ primitives.update(frameState)
            └─ PointPrimitiveCollection.update()
                 └─ DrawCommand 生成 → WebGL 描画
```

## 共通: 先に読むべきユーティリティ

Phase に入る前に、全体で使われるパターンを理解しておくと楽です:

| ファイル | 行数 | 重要度 |
|---|---|---|
| `Core/defined.js` | ~10行 | ★★★ null チェック |
| `Core/Check.js` | ~200行 | ★★★ 開発時バリデーション |
| `Core/DeveloperError.js` | ~50行 | ★★ 開発時エラー |
| `Core/Event.js` | ~150行 | ★★★ イベントシステム |
| `Core/destroyObject.js` | ~30行 | ★★ リソース解放 |
| `Core/defaultValue.js` | ~20行 | ★★ デフォルト値 |

## 学習テクニック

### 1. Sandcastle をデバッガとして使う

```bash
npm start
# → http://localhost:8080/Apps/Sandcastle/
```

デモを動かしながら DevTools でブレークポイントを仕掛ける。

### 2. 「1つのオブジェクトのライフサイクル」を追う

例: Entity を 1 つ追加して画面に描画されるまで:

```javascript
const entity = viewer.entities.add({
  position: Cesium.Cartesian3.fromDegrees(139.7, 35.7, 100),
  point: { pixelSize: 10, color: Cesium.Color.RED }
});
```

→ Entity 作成 → PointVisualizer 検知 → PointPrimitiveCollection → DrawCommand → WebGL

### 3. grep でパターンを探す

```bash
# 特定の関数がどこから呼ばれているか
grep -r "globe.update" packages/engine/Source/Scene/

# 特定のクラスの使用箇所
grep -r "new DrawCommand" packages/engine/Source/
```

### 4. テストを読む

Spec ファイルはクラスの使い方の最良のドキュメントです:

```
packages/engine/Specs/Core/Cartesian3Spec.js
packages/engine/Specs/Scene/SceneSpec.js
packages/engine/Specs/DataSources/EntitySpec.js
```
