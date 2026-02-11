# 10. Camera - カメラ制御システム

## 概要

Camera は CesiumJS の **視点制御** の中心です。
位置 (position) + 姿勢 (direction/up/right) + 視錐台 (frustum) で定義され、
毎フレーム viewMatrix を生成して全ての描画に使用されます。

**ファイル**: `packages/engine/Source/Scene/Camera.js` (~3700行)

## カメラの基本構造

```
Camera {
  // === 位置・姿勢 (ローカル座標) ===
  position:   Cartesian3    ← transform 空間での位置
  direction:  Cartesian3    ← 視線方向 (正規化)
  up:         Cartesian3    ← 上方向 (正規化)
  right:      Cartesian3    ← 右方向 (direction × up)

  // === ワールド座標 (自動計算) ===
  positionWC:  Cartesian3   ← ECEF 位置 (= transform × position)
  directionWC: Cartesian3   ← ECEF 視線方向
  upWC:        Cartesian3   ← ECEF 上方向
  rightWC:     Cartesian3   ← ECEF 右方向

  // === 経緯度 (自動計算) ===
  positionCartographic: Cartographic  ← 現在位置の経緯度

  // === HPR角度 (自動計算) ===
  heading: number   ← 北基準の方位角 (0=北, π/2=東)
  pitch:   number   ← 仰角 (-π/2=真下, 0=水平, π/2=真上)
  roll:    number   ← ロール角

  // === 変換行列 ===
  transform:     Matrix4   ← カメラの参照フレーム (デフォルト: IDENTITY = ECEF)
  viewMatrix:    Matrix4   ← ビュー行列 (ワールド→カメラ空間)
  inverseViewMatrix: Matrix4
  inverseTransform:  Matrix4

  // === 視錐台 ===
  frustum: PerspectiveFrustum | OrthographicFrustum

  // === イベント ===
  moveStart: Event    ← カメラ移動開始
  moveEnd:   Event    ← カメラ移動終了
  changed:   Event    ← カメラ変更 (percentageChanged 以上の変化で発火)
}
```

## 座標空間の理解

Camera には **2つの座標空間** があります:

### 1. ローカル座標 (position, direction, up, right)

`transform` で定義される参照フレーム内での値。

- **transform = IDENTITY (デフォルト)**: ローカル = ECEF。position は ECEF 座標。
- **transform = ENU行列**: ローカル = ENU 空間。position は ENU 空間での相対位置。

### 2. ワールド座標 (*WC プロパティ)

常に ECEF 座標系での値。`transform × ローカル座標` で自動計算。

```
positionWC  = actualTransform × position
directionWC = actualTransform × direction  (ベクトルとして)
upWC        = actualTransform × up
rightWC     = actualTransform × right
```

## viewMatrix の計算 (L314-328)

```javascript
function updateViewMatrix(camera) {
  // 1. ローカル position/direction/up/right からビュー行列を構築
  Matrix4.computeView(position, direction, up, right, viewMatrix);

  // 2. transform の逆行列を掛ける
  //    → ワールド座標からカメラ空間への変換行列が完成
  Matrix4.multiply(viewMatrix, actualInvTransform, viewMatrix);

  // 3. 逆行列も計算
  Matrix4.inverseTransformation(viewMatrix, invViewMatrix);
}
```

**結果の viewMatrix**: ワールド座標 (ECEF) → カメラ空間の変換行列。
Scene のレンダリングパイプラインでシェーダーに渡されます。

## updateMembers - 内部状態の同期 (L655-814)

Camera の公開プロパティ (`position`, `direction`, `up`, `right`) が変更されると、
`updateMembers()` で以下を自動同期します:

```
position が変更された場合:
  1. _positionWC を再計算 (transform × position)
  2. _positionCartographic を再計算 (ECEF → 経緯度)

direction/up/right が変更された場合:
  1. 直交正規化チェック (det ≈ 1 でなければ補正)
  2. _directionWC, _upWC, _rightWC を再計算

いずれかが変更された場合:
  → updateViewMatrix() で viewMatrix を再構築
```

**ポイント**: `heading`, `pitch`, `positionWC` 等の getter は内部で
`updateMembers(this)` を呼ぶので、常に最新の値が返ります。

## transform の仕組み (参照フレーム)

### _setTransform (L1177-1193) - フレーム切り替え

```javascript
Camera.prototype._setTransform = function(transform) {
  // 1. 現在のワールド座標を保存
  const position = clone(this.positionWC);
  const up = clone(this.upWC);
  const direction = clone(this.directionWC);

  // 2. 新しい transform を設定
  this._transform = transform;
  updateMembers(this);  // actualInvTransform を更新

  // 3. ワールド座標を新しい transform の逆行列でローカルに変換
  //    → カメラの見た目は変わらず、内部表現だけ変わる
  Matrix4.multiplyByPoint(inverse, position, this.position);
  Matrix4.multiplyByPointAsVector(inverse, direction, this.direction);
  Matrix4.multiplyByPointAsVector(inverse, up, this.up);
  Cartesian3.cross(this.direction, this.up, this.right);

  updateMembers(this);
};
```

**重要**: transform を変更してもカメラの**見た目は変わりません**。
内部表現(ローカル座標)が新しいフレームに変換されるだけです。

### transform の使用例

```javascript
// デフォルト: ECEF フレーム
camera.transform = Matrix4.IDENTITY;
// → position = ECEF 座標 (例: (-3959000, 3352000, 3698000))

// ENU フレームに切り替え
const enuTransform = Transforms.eastNorthUpToFixedFrame(target);
camera._setTransform(enuTransform);
// → position = ローカル ENU 座標 (例: (0, 0, 1000) = target の上空1000m)
```

## Heading / Pitch / Roll の計算

### heading (方位角) の取得 (L992-1014)

```javascript
get heading() {
  // 1. 現在位置での ENU フレームに一時的に切り替え
  const transform = Transforms.eastNorthUpToFixedFrame(this.positionWC);
  this._setTransform(transform);

  // 2. ENU 空間での direction から heading を計算
  //    heading = atan2(direction.y, direction.x) - PI/2
  //    (ENU の x=East, y=North → 北基準に補正)
  const heading = getHeading(this.direction, this.up);

  // 3. 元の transform に戻す
  this._setTransform(oldTransform);
  return heading;
}
```

### pitch (仰角) の計算 (L829-831)

```javascript
function getPitch(direction) {
  // ENU 空間で direction.z = cos(天頂角)
  // pitch = π/2 - acos(direction.z)
  // → direction.z = 0 なら pitch=0 (水平)
  // → direction.z = -1 なら pitch=-π/2 (真下)
  return CesiumMath.PI_OVER_TWO - CesiumMath.acosClamped(direction.z);
}
```

## 主要メソッド

### カメラ配置

#### setView (L1486-1537) - 即座に配置

```javascript
camera.setView({
  destination: Cartesian3.fromDegrees(139.7, 35.68, 1000), // ECEF 位置
  orientation: {
    heading: CesiumMath.toRadians(0),    // 北向き
    pitch: CesiumMath.toRadians(-30),    // 30°下向き
    roll: 0
  }
});
```

内部処理 (3D の場合 - setView3D, L1266-1299):
```
1. destination の ENU フレームを作成
2. カメラを ENU フレームの原点 (position = ZERO) に配置
3. HPR から回転行列を作成
4. 回転行列から direction/up/right を抽出
5. 元の transform に戻す
```

#### lookAt (L2329-2351) - ターゲットを注視

```javascript
camera.lookAt(
  target,   // Cartesian3: 注視点 (ECEF)
  offset    // HeadingPitchRange or Cartesian3: ターゲットからのオフセット
);
```

内部処理:
```
1. target で ENU フレームを作成
2. lookAtTransform(enuTransform, offset) を呼ぶ
3. ENU フレーム内で offset 位置にカメラを配置
4. direction を原点 (= target) に向ける
```

**注意**: `lookAt` 後は transform が ENU に固定されます。
解除するには `camera.lookAtTransform(Matrix4.IDENTITY)` を呼びます。

#### flyTo (L3359-3465) - アニメーション付き移動

```javascript
camera.flyTo({
  destination: Cartesian3.fromDegrees(139.7, 35.68, 10000),
  orientation: { heading: 0, pitch: -Math.PI/4, roll: 0 },
  duration: 3,              // 秒 (省略時は自動計算)
  complete: () => { ... },  // 完了コールバック
  cancel: () => { ... },    // キャンセルコールバック
  maximumHeight: 50000,     // 飛行中の最大高度
  easingFunction: EasingFunction.QUADRATIC_IN_OUT
});
```

内部処理:
```
1. 現在の飛行をキャンセル
2. destination が Rectangle なら位置に変換
3. duration <= 0 なら即座に setView
4. CameraFlightPath.createTween() で Tween アニメーションを生成
5. scene.tweens.add() でアニメーション開始
6. プリロード用カメラを設定 (飛行先のタイルを先読み)
```

#### flyToBoundingSphere (L3594-3695) - バウンディングスフィアに飛行

```javascript
camera.flyToBoundingSphere(boundingSphere, {
  offset: new HeadingPitchRange(0, -Math.PI/4, boundingSphere.radius * 3),
  duration: 2
});
```

### カメラ移動 (低レベル)

#### move (L1775-1790) - 平行移動

```javascript
camera.move(direction, amount);
// → position += direction * amount
// direction/up/right は変化しない

// 便利メソッド:
camera.moveForward(amount);   // move(direction, amount)
camera.moveBackward(amount);  // move(direction, -amount)
camera.moveUp(amount);        // move(up, amount)
camera.moveDown(amount);      // move(up, -amount)
camera.moveLeft(amount);      // move(right, -amount)
camera.moveRight(amount);     // move(right, amount)
```

#### look (L1964-1986) - 首振り (FPS カメラ的)

```javascript
camera.look(axis, angle);
// → direction, up, right を axis 周りに angle 回転
// → position は変化しない (その場で向きだけ変える)

// 便利メソッド:
camera.lookUp(amount);     // look(right, -amount)
camera.lookDown(amount);   // look(right, amount)
camera.lookLeft(amount);   // look(up, -amount)
camera.lookRight(amount);  // look(up, amount)
```

#### rotate (L2026-2047) - 軌道回転 (orbit)

```javascript
camera.rotate(axis, angle);
// → position, direction, up, right を axis 周りに angle 回転
// → transform の原点を中心に軌道回転 (lookAt との組み合わせ)

// 便利メソッド:
camera.rotateUp(amount);
camera.rotateDown(amount);
camera.rotateLeft(amount);
camera.rotateRight(amount);
```

**move と rotate の違い**:
- `move`: カメラを直線移動。方向は変わらない。
- `rotate`: カメラを原点中心に回転。位置も方向も変わる。
- `look`: カメラは動かず向きだけ変える。

```
move:     ──→ ──→     (位置移動、向き不変)
look:     ↻            (位置不変、向き変更)
rotate:   ⟳ 原点       (原点中心に軌道回転)
```

### ピッキング

#### getPickRay (L3029-3055) - 画面座標 → レイ

```javascript
const ray = camera.getPickRay(windowPosition);
// → Ray { origin: Cartesian3, direction: Cartesian3 }
```

透視投影の場合 (getPickRayPerspective, L2941-2978):
```
1. 画面座標を [-1, 1] に正規化
2. frustum の fovy, aspectRatio, near から近平面上の点を計算
3. カメラ位置から近平面上の点への方向 = レイの方向
```

#### pickEllipsoid (L2902-2936) - 画面座標 → 楕円体上の点

```javascript
const position = camera.pickEllipsoid(windowPosition);
// → Cartesian3 (楕円体との交点) or undefined (地球外)
```

シーンモード別に処理:
- 3D: `pickEllipsoid3D` - レイと楕円体の交差計算
- 2D: `pickMap2D` - 投影逆変換
- Columbus View: `pickMapColumbusView` - 平面投影逆変換

## 視錐台 (Frustum)

### PerspectiveFrustum (デフォルト)

```javascript
camera.frustum = new PerspectiveFrustum();
camera.frustum.fov = CesiumMath.toRadians(60);  // 視野角 60°
camera.frustum.aspectRatio = width / height;
camera.frustum.near = 0.1;    // ニアクリップ (自動調整)
camera.frustum.far = 500000;  // ファークリップ (自動調整)
```

### OrthographicFrustum (正射影)

```javascript
camera.switchToOrthographicFrustum();
// → PerspectiveFrustum → OrthographicFrustum に切り替え

camera.switchToPerspectiveFrustum();
// → OrthographicFrustum → PerspectiveFrustum に戻す
```

2D モードでは自動的に `OrthographicOffCenterFrustum` が使われます。

## SceneMode による違い

| | SCENE3D | SCENE2D | COLUMBUS_VIEW |
|---|---|---|---|
| frustum | Perspective/Orthographic | OrthographicOffCenter | Perspective/Orthographic |
| position | ECEF 座標 | 投影座標 (x,y) + 固定 z | 投影座標 |
| transform | IDENTITY or カスタム | TRANSFORM_2D | TRANSFORM_2D or カスタム |
| 回転 | 自由 | なし (上が北固定) | 制限あり |
| ズーム | position 移動 | frustum 幅変更 | position 移動 |

## イベントフロー

```
ユーザー操作 (マウス/タッチ)
    │
    ▼
ScreenSpaceEventHandler
    │
    ▼
ScreenSpaceCameraController
    │  (ドラッグ → rotateDown/Up)
    │  (ホイール → zoomIn/Out)
    │  (右ドラッグ → look)
    │  (中ドラッグ → tilt)
    ▼
Camera メソッド呼び出し
    │  move() / rotate() / look() / zoom3D()
    ▼
position/direction/up/right 変更
    │
    ▼
updateMembers() (getter 呼び出し時)
    │  positionWC, directionWC 等を再計算
    │  viewMatrix を再構築
    ▼
Scene.render() で viewMatrix がシェーダーに渡される
```

## よく使うパターン

### 1. 特定の場所を見下ろす

```javascript
camera.setView({
  destination: Cartesian3.fromDegrees(139.7, 35.68, 5000),
  orientation: {
    heading: 0,                           // 北向き
    pitch: CesiumMath.toRadians(-90),     // 真下を見る
    roll: 0
  }
});
```

### 2. 建物をオービット (周回)

```javascript
const target = Cartesian3.fromDegrees(139.7, 35.68, 0);
camera.lookAt(target, new HeadingPitchRange(
  CesiumMath.toRadians(45),  // 北東から
  CesiumMath.toRadians(-30), // 30°上から
  1000                        // 1000m 離れて
));
// この後 rotateLeft/Right で周回可能
```

### 3. Entity を追跡

```javascript
viewer.trackedEntity = entity;
// → 内部で camera.lookAtTransform(entityTransform) が呼ばれる
// → Entity の動きにカメラが追従
```

### 4. カメラ変更を監視

```javascript
camera.changed.addEventListener(() => {
  console.log('Camera moved:', camera.positionCartographic);
});
camera.percentageChanged = 0.1; // 10% 変化で発火
```

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `Scene/Camera.js` | カメラ本体 (~3700行) |
| `Scene/CameraFlightPath.js` | flyTo のパス計算 |
| `Scene/ScreenSpaceCameraController.js` | マウス/タッチ操作ハンドラ |
| `Scene/CameraEventAggregator.js` | 入力イベント集約 |
| `Core/PerspectiveFrustum.js` | 透視投影 frustum |
| `Core/OrthographicFrustum.js` | 正射影 frustum |
| `Core/OrthographicOffCenterFrustum.js` | 2D 用 frustum |
| `Core/HeadingPitchRange.js` | heading/pitch/range 値 |
| `Core/HeadingPitchRoll.js` | heading/pitch/roll 値 |
