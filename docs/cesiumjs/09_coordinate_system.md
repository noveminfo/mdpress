# 09. 座標系と座標変換

## 概要

CesiumJS は地球全体を扱う 3D エンジンなので、座標系の理解が極めて重要です。
主に **4つの座標系** と、それらを相互変換する仕組みで成り立っています。

## 4つの座標系

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  1. Cartographic (経緯度)                                    │
│     longitude, latitude (ラジアン), height (メートル)         │
│     人間にとって直感的。API の入口。                          │
│                                                             │
│         ↕ Ellipsoid.cartographicToCartesian()               │
│         ↕ Ellipsoid.cartesianToCartographic()               │
│                                                             │
│  2. ECEF - Cartesian3 (地心地球固定座標)                     │
│     x, y, z (メートル)。CesiumJS の内部基準座標系。          │
│     原点 = 地球の中心                                        │
│                                                             │
│         ↕ Transforms.eastNorthUpToFixedFrame()              │
│         ↕ (逆行列で ECEF → ローカル)                        │
│                                                             │
│  3. ローカルフレーム (ENU/NED 等)                            │
│     地表のある点を原点とした直交座標系。                      │
│     East-North-Up (ENU) が最もよく使われる。                 │
│                                                             │
│         ↕ Camera の viewMatrix (view + projection)          │
│                                                             │
│  4. 画面座標 (Screen / Window)                               │
│     ピクセル座標。scene.pickPosition() 等で使用。             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 1. Cartographic - 経緯度座標

**ファイル**: `Core/Cartographic.js`

```javascript
// コンストラクタ: 全てラジアン + メートル
new Cartographic(longitude, latitude, height)
// longitude: 経度 (ラジアン), -π 〜 +π
// latitude:  緯度 (ラジアン), -π/2 〜 +π/2
// height:    楕円体表面からの高度 (メートル)

// 度数から作成 (便利メソッド)
Cartographic.fromDegrees(longitude, latitude, height)
// → 内部で Math.toRadians() してから new Cartographic()

// ラジアンから作成
Cartographic.fromRadians(longitude, latitude, height)
```

**注意**: Cartographic は **常にラジアン** です。度数で直接指定はできません。

## 2. ECEF 座標 - Cartesian3

**ファイル**: `Core/Cartesian3.js`

CesiumJS の **全ての 3D 位置** は ECEF (Earth-Centered, Earth-Fixed) 座標系の Cartesian3 です。

```
ECEF 座標系:
  原点: 地球の中心
  X軸: 赤道面上、グリニッジ子午線方向 (経度 0°)
  Y軸: 赤道面上、東経 90° 方向
  Z軸: 北極方向

単位: メートル

具体例:
  東京 (139.7°E, 35.7°N) ≈ (-3959000, 3352000, 3698000)
  ロンドン (0°, 51.5°N)    ≈ (3980000, 0, 4967000)
  北極 (0°, 90°N)          ≈ (0, 0, 6356752)
```

### 主要メソッド

```javascript
// 度数 → ECEF (最もよく使う変換)
const position = Cartesian3.fromDegrees(139.7, 35.7, 100);
// → Cartographic.fromDegrees() → Ellipsoid.cartographicToCartesian()

// ラジアン → ECEF
const position = Cartesian3.fromRadians(lng, lat, height, ellipsoid, result);

// ベクトル演算 (全て静的メソッド + result パターン)
Cartesian3.add(a, b, result)           // a + b
Cartesian3.subtract(a, b, result)      // a - b
Cartesian3.multiplyByScalar(a, s, result) // a * s
Cartesian3.normalize(a, result)        // 正規化
Cartesian3.dot(a, b)                   // 内積
Cartesian3.cross(a, b, result)         // 外積
Cartesian3.distance(a, b)             // 距離
Cartesian3.magnitude(a)               // 長さ
```

### fromRadians の内部処理 (L865-893)

```javascript
static fromRadians(longitude, latitude, height, ellipsoid, result) {
  height = height ?? 0.0;
  const radiiSquared = ellipsoid?.radiiSquared ?? Cartesian3._ellipsoidRadiiSquared;

  // 1. 経緯度から方向ベクトル (測地線法線) を計算
  const cosLatitude = Math.cos(latitude);
  scratchN.x = cosLatitude * Math.cos(longitude);  // 方向ベクトル
  scratchN.y = cosLatitude * Math.sin(longitude);
  scratchN.z = Math.sin(latitude);
  scratchN = Cartesian3.normalize(scratchN, scratchN);

  // 2. 楕円体表面上の点を計算 (radiiSquared で楕円体の歪みを反映)
  Cartesian3.multiplyComponents(radiiSquared, scratchN, scratchK);
  const gamma = Math.sqrt(Cartesian3.dot(scratchN, scratchK));
  scratchK = Cartesian3.divideByScalar(scratchK, gamma, scratchK);

  // 3. 法線方向に height 分だけオフセット
  scratchN = Cartesian3.multiplyByScalar(scratchN, height, scratchN);

  // 4. 表面点 + 高度オフセット = 最終位置
  return Cartesian3.add(scratchK, scratchN, result);
}
```

## 3. Ellipsoid - 楕円体

**ファイル**: `Core/Ellipsoid.js`

地球の形状を表す楕円体。全ての座標変換の基盤です。

### WGS84 定数

```javascript
// 地球の WGS84 楕円体 (デフォルト)
Ellipsoid.WGS84 = new Ellipsoid(6378137.0, 6378137.0, 6356752.3142451793);
//                               ↑赤道半径(m)  ↑赤道半径  ↑極半径(m)
// X, Y は同じ値 → 赤道は完全な円
// Z は少し短い → 地球は赤道方向に膨らんだ楕円体

// その他のプリセット
Ellipsoid.UNIT_SPHERE  // 単位球
Ellipsoid.MOON         // 月
Ellipsoid.MARS         // 火星
```

### 初期化時に事前計算される値 (initialize, L9-52)

```javascript
function initialize(ellipsoid, x, y, z) {
  ellipsoid._radii = new Cartesian3(x, y, z);              // (a, a, b)
  ellipsoid._radiiSquared = new Cartesian3(x*x, y*y, z*z); // (a², a², b²)
  ellipsoid._radiiToTheFourth = ...;                         // (a⁴, a⁴, b⁴)
  ellipsoid._oneOverRadii = new Cartesian3(1/x, 1/y, 1/z); // (1/a, 1/a, 1/b)
  ellipsoid._oneOverRadiiSquared = ...;                      // (1/a², 1/a², 1/b²)
  ellipsoid._minimumRadius = Math.min(x, y, z);             // b (極半径)
  ellipsoid._maximumRadius = Math.max(x, y, z);             // a (赤道半径)
}
```

**ポイント**: 頻繁に使う逆数・二乗値を事前計算してパフォーマンスを確保。

### 主要メソッド

#### cartographicToCartesian (L444-458)

経緯度 → ECEF 変換。

```javascript
Ellipsoid.prototype.cartographicToCartesian = function(cartographic, result) {
  // 1. 経緯度から測地線法線 (地表の垂直方向) を計算
  const n = this.geodeticSurfaceNormalCartographic(cartographic, ...);

  // 2. 楕円体表面上の点を計算
  //    k = radiiSquared * n / sqrt(dot(n, radiiSquared * n))
  Cartesian3.multiplyComponents(this._radiiSquared, n, k);
  const gamma = Math.sqrt(Cartesian3.dot(n, k));
  Cartesian3.divideByScalar(k, gamma, k);

  // 3. 法線方向に高さ分オフセット
  Cartesian3.multiplyByScalar(n, cartographic.height, n);

  // 4. 表面点 + 高度 = ECEF 座標
  return Cartesian3.add(k, n, result);
};
```

#### cartesianToCartographic (L511-534)

ECEF → 経緯度変換 (逆変換)。

```javascript
Ellipsoid.prototype.cartesianToCartographic = function(cartesian, result) {
  // 1. ECEF点を楕円体表面に投影 (最近接点)
  const p = this.scaleToGeodeticSurface(cartesian, ...);

  // 2. 表面点での測地線法線を計算
  const n = this.geodeticSurfaceNormal(p, ...);

  // 3. ECEF点と表面点の差 = 高度ベクトル
  const h = Cartesian3.subtract(cartesian, p, ...);

  // 4. 法線から経緯度を算出
  const longitude = Math.atan2(n.y, n.x);          // 経度
  const latitude = Math.asin(n.z);                   // 緯度
  const height = sign(dot(h, cartesian)) * magnitude(h);  // 高度 (符号付き)

  return new Cartographic(longitude, latitude, height);
};
```

#### geodeticSurfaceNormal (L406-427) - 測地線法線

楕円体表面のある点での **外向き垂直方向** ベクトル。

```javascript
Ellipsoid.prototype.geodeticSurfaceNormal = function(cartesian, result) {
  // ECEF座標を oneOverRadiiSquared で成分ごとに掛けて正規化
  // → 楕円体の歪みを考慮した法線
  result = Cartesian3.multiplyComponents(cartesian, this._oneOverRadiiSquared, result);
  return Cartesian3.normalize(result, result);
};
```

**球体の場合**: 法線 = 位置ベクトルの正規化 (中心→表面方向)
**楕円体の場合**: oneOverRadiiSquared による重み付けが必要 (極方向が扁平なため)

#### geodeticSurfaceNormalCartographic (L374-397) - 経緯度から法線

```javascript
// 経緯度から直接法線を計算 (三角関数のみ)
const x = cos(latitude) * cos(longitude);
const y = cos(latitude) * sin(longitude);
const z = sin(latitude);
return normalize(new Cartesian3(x, y, z));
```

## 4. Transforms - 座標変換マトリクス

**ファイル**: `Core/Transforms.js`

### ローカルフレーム変換の生成

`localFrameToFixedFrameGenerator(firstAxis, secondAxis)` が全ての基盤です。

```javascript
// ENU (East-North-Up): 最も一般的
Transforms.eastNorthUpToFixedFrame =
  Transforms.localFrameToFixedFrameGenerator("east", "north");
// → Matrix4: 列0=East, 列1=North, 列2=Up, 列3=origin

// NED (North-East-Down): 航空・ドローン系でよく使う
Transforms.northEastDownToFixedFrame =
  Transforms.localFrameToFixedFrameGenerator("north", "east");

// NUE (North-Up-East)
Transforms.northUpEastToFixedFrame =
  Transforms.localFrameToFixedFrameGenerator("north", "up");

// NWU (North-West-Up)
Transforms.northWestUpToFixedFrame =
  Transforms.localFrameToFixedFrameGenerator("north", "west");
```

### localFrameToFixedFrameGenerator の内部処理 (L98-252)

この関数は **関数を返す関数** (ジェネレータパターン) です。

```javascript
Transforms.localFrameToFixedFrameGenerator("east", "north")
// → function(origin, ellipsoid, result) { ... } を返す

// 返された関数の内部処理:
function(origin, ellipsoid, result) {
  // 1. origin での測地線法線 = Up 方向
  ellipsoid.geodeticSurfaceNormal(origin, up);

  // 2. East 方向 = (-origin.y, origin.x, 0) を正規化
  //    (Z軸との外積 ≒ 東方向)
  east.x = -origin.y;
  east.y = origin.x;
  east.z = 0.0;
  Cartesian3.normalize(east);

  // 3. North = cross(Up, East)
  Cartesian3.cross(up, east, north);

  // 4. down/west/south は反転で計算

  // 5. 4x4 行列を組み立て:
  //    [firstAxis | secondAxis | thirdAxis | origin]
  //    [    0     |     0      |     0     |   1   ]
  result = Matrix4(
    first.x,  second.x,  third.x,  origin.x,
    first.y,  second.y,  third.y,  origin.y,
    first.z,  second.z,  third.z,  origin.z,
       0,        0,         0,        1
  );
}
```

**ポイント**: この行列を使うと、ローカル座標の (1, 0, 0) が東方向、(0, 1, 0) が北方向、
(0, 0, 1) が上方向の ECEF 座標に変換されます。

### 特殊ケース処理

- **原点が地球の中心 (0,0,0)**: 退化ケース → 固定のローカルフレームを使用
- **原点が北極/南極 (x=0, y=0)**: East の計算が不定 → 特別処理

### Heading-Pitch-Roll 変換

```javascript
// HPR (heading/pitch/roll) → 変換行列
Transforms.headingPitchRollToFixedFrame(origin, hpr, ellipsoid, fixedFrameTransform, result)

// 処理:
// 1. HPR → Quaternion
// 2. Quaternion → 回転行列
// 3. ENU行列 × 回転行列 = 最終変換行列

// 逆変換: 変換行列 → HPR
Transforms.fixedFrameToHeadingPitchRoll(transform, ellipsoid, fixedFrameTransform, result)
```

**Heading**: 北を基準とした水平回転 (時計回りが正)
**Pitch**: 水平面からの仰角 (上向きが正)
**Roll**: 前方軸周りの回転

## 座標変換パイプライン全体図

```
ユーザー入力
  "東京駅: 139.7°E, 35.68°N, 高度0m"
     │
     │ CesiumMath.toRadians()
     ▼
Cartographic(2.4386, 0.6228, 0)   ← ラジアン
     │
     │ Ellipsoid.WGS84.cartographicToCartesian()
     │   geodeticSurfaceNormalCartographic() → 法線 n
     │   楕円体表面点 k = radiiSquared * n / gamma
     │   最終点 = k + height * n
     ▼
Cartesian3(-3959000, 3352000, 3698000)  ← ECEF (メートル)
     │
     │ Transforms.eastNorthUpToFixedFrame(position)
     ▼
Matrix4 (4x4 変換行列)              ← ローカル ENU フレーム
  [East.x  North.x  Up.x  pos.x]      この行列でローカル座標を
  [East.y  North.y  Up.y  pos.y]      ECEF に変換できる
  [East.z  North.z  Up.z  pos.z]
  [  0       0       0      1  ]
     │
     │ Camera.viewMatrix (= inverse(camera.transform))
     ▼
Eye Space (カメラ空間)               ← カメラから見た相対位置
     │
     │ Camera.frustum.projectionMatrix
     ▼
Clip Space (クリップ空間)            ← [-1, 1] の正規化空間
     │
     │ Viewport Transform
     ▼
Window Coordinates (画面座標)        ← ピクセル座標
```

## よく使う変換パターン

### 1. 経緯度 → 画面座標

```javascript
const position = Cartesian3.fromDegrees(139.7, 35.68, 0);
const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(
  scene, position
);
// → Cartesian2(x_pixel, y_pixel) or undefined (画面外)
```

### 2. 画面座標 → 経緯度

```javascript
const cartesian = scene.pickPosition(windowPosition);  // ECEF
if (defined(cartesian)) {
  const cartographic = Cartographic.fromCartesian(cartesian);
  const lng = CesiumMath.toDegrees(cartographic.longitude);
  const lat = CesiumMath.toDegrees(cartographic.latitude);
}
```

### 3. モデルの配置 (位置 + 向き)

```javascript
const position = Cartesian3.fromDegrees(139.7, 35.68, 0);
const hpr = new HeadingPitchRoll(
  CesiumMath.toRadians(90),  // heading: 東向き
  0,                          // pitch: 水平
  0                           // roll: なし
);
const modelMatrix = Transforms.headingPitchRollToFixedFrame(position, hpr);
// → この行列を Entity や Model の modelMatrix に設定
```

### 4. 2点間の距離

```javascript
const a = Cartesian3.fromDegrees(139.7, 35.68, 0);
const b = Cartesian3.fromDegrees(140.0, 36.0, 0);
const distance = Cartesian3.distance(a, b);  // メートル
```

### 5. ローカル座標での操作

```javascript
// ある地点から東に100m, 北に200m の位置を計算
const origin = Cartesian3.fromDegrees(139.7, 35.68, 0);
const enuMatrix = Transforms.eastNorthUpToFixedFrame(origin);

// ローカルオフセット (East=100, North=200, Up=0)
const localOffset = new Cartesian3(100, 200, 0);

// ECEF に変換
const worldOffset = Matrix4.multiplyByPoint(enuMatrix, localOffset, new Cartesian3());
```

## 天体座標系 (上級)

Transforms には地球の自転・歳差を考慮した座標変換もあります:

| メソッド | 変換 | 用途 |
|---|---|---|
| `computeIcrfToFixedMatrix` | ICRF → ECEF | 慣性座標系から地球固定系 |
| `computeFixedToIcrfMatrix` | ECEF → ICRF | 地球固定系から慣性座標系 |
| `computeTemeToPseudoFixedMatrix` | TEME → 疑似固定 | 簡易版 (EOP 不要) |
| `computeIcrfToMoonFixedMatrix` | ICRF → 月固定 | 月面座標系 |
| `computeMoonFixedToIcrfMatrix` | 月固定 → ICRF | 月面から慣性系 |

これらは太陽の位置計算、衛星軌道の表示、慣性フレームでのカメラ制御等に使います。

## 関連ファイル一覧

| ファイル | 行数 | 役割 |
|---|---|---|
| `Core/Cartesian3.js` | ~1121行 | 3D ベクトル (ECEF 座標) |
| `Core/Cartesian2.js` | ~700行 | 2D ベクトル (画面座標等) |
| `Core/Cartographic.js` | ~200行 | 経緯度座標 |
| `Core/Ellipsoid.js` | ~650行 | 楕円体、座標変換の中心 |
| `Core/Transforms.js` | ~1260行 | フレーム変換行列群 |
| `Core/Matrix4.js` | ~2000行 | 4x4 変換行列 |
| `Core/Matrix3.js` | ~1300行 | 3x3 回転行列 |
| `Core/Quaternion.js` | ~1000行 | クォータニオン回転 |
| `Core/HeadingPitchRoll.js` | ~150行 | HPR 角度 |
| `Core/Math.js` | ~700行 | toRadians/toDegrees 等ユーティリティ |
| `Scene/SceneTransforms.js` | ~300行 | World ↔ Window 変換ヘルパー |
