# 15. SampledProperty と補間アルゴリズム

## 概要

SampledProperty は**時系列サンプルデータから任意の時刻の値を補間で求める** Property です。
衛星軌道、車両の移動、センサー値の変化など、時間とともに変わるデータを扱う際の中核です。

## SampledProperty のデータ構造

**ファイル**: `packages/engine/Source/DataSources/SampledProperty.js`

```javascript
function SampledProperty(type, derivativeTypes) {
  this._type = type;                    // 値の型 (Cartesian3, Number 等)
  this._innerType = innerType;          // パック可能な内部型
  this._times = [];                     // JulianDate[] - ソート済み時刻配列
  this._values = [];                    // number[] - パック済み値の平坦配列
  this._packedLength = packedLength;    // 1サンプルのパック長

  // 補間設定
  this._interpolationDegree = 1;                    // 補間次数
  this._interpolationAlgorithm = LinearApproximation; // 補間アルゴリズム
  this._numberOfPoints = 0;             // 補間に使うサンプル数

  // 補間テーブル（getValue 時に構築）
  this._xTable = [];                    // 時間差の配列
  this._yTable = [];                    // 値の配列
  this._interpolationResult = [];       // 結果バッファ

  // 外挿設定
  this._forwardExtrapolationType = ExtrapolationType.NONE;
  this._forwardExtrapolationDuration = 0;
  this._backwardExtrapolationType = ExtrapolationType.NONE;
  this._backwardExtrapolationDuration = 0;

  // 導関数（速度等）
  this._derivativeTypes = derivativeTypes;
  this._inputOrder = derivativeTypes ? derivativeTypes.length : 0;
}
```

### Packable パターン

CesiumJS の型は `pack()` / `unpack()` メソッドで配列に変換可能:

```javascript
// Cartesian3 の場合: packedLength = 3
Cartesian3.pack(new Cartesian3(1, 2, 3), array, offset);
// → array = [..., 1, 2, 3, ...]

// _values 配列の構造（Cartesian3 × 3サンプルの場合）:
// [x0, y0, z0, x1, y1, z1, x2, y2, z2]
//  ← sample0 → ← sample1 → ← sample2 →
```

## サンプルの追加

### addSample - 1つずつ追加

```javascript
const property = new SampledProperty(Cartesian3);

property.addSample(time0, position0);
property.addSample(time1, position1);
property.addSample(time2, position2);
```

内部では `mergeNewSamples()` が**二分探索で挿入位置を見つけ、ソート順を維持**:

```javascript
function mergeNewSamples(epoch, times, values, newData, packedLength) {
  while (newDataIndex < newData.length) {
    currentTime = newData[newDataIndex];
    timesInsertionPoint = binarySearch(times, currentTime, JulianDate.compare);

    if (timesInsertionPoint < 0) {
      // 新規時刻 → 挿入位置を計算してソート順を維持しながら挿入
      timesInsertionPoint = ~timesInsertionPoint;
      // times 配列と values 配列の両方に挿入
    } else {
      // 既存時刻 → 値を上書き
      values[timesInsertionPoint * packedLength + i] = newData[...];
    }
  }
}
```

### addSamples - 一括追加

```javascript
property.addSamples(
  [time0, time1, time2],           // JulianDate[]
  [position0, position1, position2] // Cartesian3[]
);
```

### addSamplesPackedArray - パック済みデータの追加

```javascript
// [time, x, y, z, time, x, y, z, ...]
property.addSamplesPackedArray([
  JulianDate.fromIso8601("2024-01-01T00:00:00Z"), 1, 2, 3,
  JulianDate.fromIso8601("2024-01-01T01:00:00Z"), 4, 5, 6,
]);
```

CZML パーサーが使用する最も効率的な方法。

## getValue - 補間の全アルゴリズム

`getValue(time)` は以下のステップで値を求めます:

```
getValue(time)
  │
  ├─① binarySearch で time の位置を探索
  │    ├── 完全一致 → そのサンプル値を返す（補間不要）
  │    └── 不一致 → index = ~insertionPoint（補間位置）
  │
  ├─② 範囲外チェック（外挿処理）
  │    ├── time < 最初のサンプル → backward 外挿
  │    │    ├── NONE → undefined
  │    │    ├── HOLD → 最初のサンプル値
  │    │    └── EXTRAPOLATE → 補間アルゴリズムで外挿
  │    └── time > 最後のサンプル → forward 外挿
  │         ├── NONE → undefined
  │         ├── HOLD → 最後のサンプル値
  │         └── EXTRAPOLATE → 補間アルゴリズムで外挿
  │
  ├─③ 補間ウィンドウの決定
  │    numberOfPoints = algorithm.getRequiredDataPoints(degree)
  │    index を中心に numberOfPoints 個のサンプルを選択
  │    ┌───────────────────────────────────┐
  │    │  ●───●───●───●───●───●───●───●   │ サンプル列
  │    │          ↑firstIndex   ↑lastIndex │
  │    │              ↑ time (補間対象)      │
  │    └───────────────────────────────────┘
  │
  ├─④ xTable / yTable の構築
  │    xTable[i] = secondsDifference(times[firstIndex+i], times[lastIndex])
  │    yTable = 値を平坦配列にコピー（or convertPackedArrayForInterpolation）
  │
  ├─⑤ 補間実行
  │    x = secondsDifference(time, times[lastIndex])
  │    result = algorithm.interpolateOrderZero(x, xTable, yTable, stride, result)
  │
  └─⑥ アンパック
       innerType.unpack(result, 0, output)
       or innerType.unpackInterpolationResult(result, ...)
```

### 補間ウィンドウの選択

```javascript
// degree=5 → numberOfPoints=6 → 6個のサンプルで補間
let computedFirstIndex = index - ((degree / 2) | 0) - 1;

// 端に寄りすぎた場合のクランプ
if (computedFirstIndex < firstIndex) computedFirstIndex = firstIndex;
let computedLastIndex = computedFirstIndex + degree;
if (computedLastIndex > lastIndex) {
  computedLastIndex = lastIndex;
  computedFirstIndex = computedLastIndex - degree;
}
```

## 補間アルゴリズム

### 1. LinearApproximation（デフォルト）

**ファイル**: `packages/engine/Source/Core/LinearApproximation.js`

最もシンプル。2点間の**線形補間**:

```javascript
LinearApproximation.getRequiredDataPoints = function(degree) {
  return 2;  // 常に2点
};

LinearApproximation.interpolateOrderZero = function(x, xTable, yTable, yStride, result) {
  const x0 = xTable[0], x1 = xTable[1];

  for (let i = 0; i < yStride; i++) {
    const y0 = yTable[i];
    const y1 = yTable[i + yStride];
    // 線形補間: y = y0 + (y1 - y0) * t
    result[i] = ((y1 - y0) * x + x1 * y0 - x0 * y1) / (x1 - x0);
  }
  return result;
};
```

**特性**:
- 計算コスト: O(yStride)
- 精度: 低（折れ線）
- 用途: リアルタイムデータ、サンプル間隔が小さい場合

### 2. LagrangePolynomialApproximation

**ファイル**: `packages/engine/Source/Core/LagrangePolynomialApproximation.js`

n次の**ラグランジュ多項式補間**:

```javascript
LagrangePolynomialApproximation.getRequiredDataPoints = function(degree) {
  return Math.max(degree + 1, 2);  // degree=5 → 6点必要
};

LagrangePolynomialApproximation.interpolateOrderZero = function(x, xTable, yTable, yStride, result) {
  const length = xTable.length;  // = numberOfPoints

  for (let i = 0; i < length; i++) {
    // ラグランジュ基底多項式 L_i(x) の計算
    let coefficient = 1;
    for (let j = 0; j < length; j++) {
      if (j !== i) {
        coefficient *= (x - xTable[j]) / (xTable[i] - xTable[j]);
      }
    }
    // 各成分に重み付き加算
    for (let j = 0; j < yStride; j++) {
      result[j] += coefficient * yTable[i * yStride + j];
    }
  }
  return result;
};
```

**数学的背景**:

```
P(x) = Σ y_i × L_i(x)

L_i(x) = Π (x - x_j) / (x_i - x_j)   (j ≠ i)
```

degree=5 の場合、6個のサンプル点を通る5次多項式で補間。

**特性**:
- 計算コスト: O(n² × yStride)
- 精度: 高（滑らかな曲線）
- 用途: 衛星軌道、滑らかな軌跡
- 注意: degree が高すぎると Runge 現象（端での振動）が発生

### 3. HermitePolynomialApproximation

**ファイル**: `packages/engine/Source/Core/HermitePolynomialApproximation.js`

**導関数（速度）を考慮した Hermite 補間**:

```javascript
// interpolateOrderZero: 導関数なしの Hermite 補間
// → ニュートンの差分商を使った divided differences 法

// interpolate: 導関数ありの Hermite 補間
// → 位置 + 速度のデータから、より滑らかな曲線を生成
// → outputOrder で位置だけでなく速度も出力可能
```

**特性**:
- 計算コスト: O(n² × yStride) + 差分商テーブルの構築
- 精度: 最高（位置と速度の両方を使用）
- 用途: 高精度軌道予測、速度情報がある場合
- `SampledProperty(Cartesian3, [Cartesian3])` で速度付きデータを扱う

## Quaternion の特殊補間

Quaternion（回転）は線形補間すると回転の大きさが変わるため、特殊な処理が必要:

### convertPackedArrayForInterpolation

補間前に Quaternion を**回転軸×角度 (axis-angle)** に変換:

```javascript
Quaternion.convertPackedArrayForInterpolation = function(packedArray, startingIndex, lastIndex, result) {
  // 基準 Quaternion (最後のサンプル) の共役を計算
  const q0Conjugate = Quaternion.conjugate(lastQuaternion);

  for (each sample) {
    // 差分回転: q_diff = q_i × q0*
    const q_diff = Quaternion.multiply(q_i, q0Conjugate);

    // 回転軸と角度に分解
    const axis = Quaternion.computeAxis(q_diff);
    const angle = Quaternion.computeAngle(q_diff);

    // axis × angle を補間データとして格納（3成分）
    result = [axis.x * angle, axis.y * angle, axis.z * angle];
  }
};
```

### unpackInterpolationResult

補間後に axis-angle から Quaternion に復元:

```javascript
Quaternion.unpackInterpolationResult = function(array, sourceArray, firstIndex, lastIndex, result) {
  // 補間された axis-angle ベクトルから角度を取得
  const rotation = Cartesian3.fromArray(array);
  const magnitude = Cartesian3.magnitude(rotation);

  // 基準 Quaternion を取得
  const q0 = Quaternion.unpack(sourceArray, lastIndex * 4);

  // axis-angle → Quaternion に変換
  const q_diff = Quaternion.fromAxisAngle(rotation, magnitude);

  // 差分回転を基準に適用: result = q_diff × q0
  return Quaternion.multiply(q_diff, q0, result);
};
```

**なぜこの方法か**:
- Quaternion を直接線形補間すると正規化が崩れる
- axis-angle 空間なら線形補間しても回転の性質が保たれる
- SLERP と同等の結果を、汎用補間アルゴリズムで実現

## ExtrapolationType - 範囲外の処理

```javascript
ExtrapolationType = {
  NONE: 0,        // 範囲外は undefined を返す
  HOLD: 1,        // 最初/最後のサンプル値を保持
  EXTRAPOLATE: 2, // 補間アルゴリズムで外挿
};
```

### getValue での外挿処理

```javascript
// time < 最初のサンプル
if (index === 0) {
  if (backwardExtrapolationType === NONE) return undefined;
  if (backwardExtrapolationType === HOLD) return unpack(values, 0);
  // EXTRAPOLATE → 通常の補間処理に進む
}

// time > 最後のサンプル
if (index >= timesLength) {
  if (forwardExtrapolationType === NONE) return undefined;
  if (forwardExtrapolationType === HOLD) return unpack(values, last);
  // EXTRAPOLATE → 通常の補間処理に進む
}
```

### duration 制限

外挿には時間制限を設定可能:

```javascript
property.forwardExtrapolationType = ExtrapolationType.HOLD;
property.forwardExtrapolationDuration = 3600; // 最大1時間の外挿

// 最後のサンプルから3601秒後 → undefined
// 最後のサンプルから3599秒後 → 最後のサンプル値
```

## SampledPositionProperty

**ファイル**: `packages/engine/Source/DataSources/SampledPositionProperty.js`

SampledProperty の Position 特化版。内部的に `SampledProperty(Cartesian3)` を持つラッパー:

```javascript
function SampledPositionProperty(referenceFrame, numberOfDerivatives) {
  // 導関数（速度）の型も Cartesian3
  let derivativeTypes;
  if (numberOfDerivatives > 0) {
    derivativeTypes = new Array(numberOfDerivatives);
    for (let i = 0; i < numberOfDerivatives; i++) {
      derivativeTypes[i] = Cartesian3;
    }
  }

  this._property = new SampledProperty(Cartesian3, derivativeTypes);
  this._referenceFrame = referenceFrame ?? ReferenceFrame.FIXED;
}
```

追加機能:
- **referenceFrame**: FIXED (ECEF) or INERTIAL (慣性系) の座標系指定
- **getValueInReferenceFrame()**: 指定した参照フレームでの値を返す
- **numberOfDerivatives**: 速度、加速度等の導関数付きデータ

### 速度付きサンプルの例

```javascript
// 位置 + 速度でより滑らかな軌道補間
const position = new SampledPositionProperty(ReferenceFrame.FIXED, 1);

position.addSample(time0, cartesian0, [velocity0]);
position.addSample(time1, cartesian1, [velocity1]);

position.setInterpolationOptions({
  interpolationAlgorithm: HermitePolynomialApproximation,
  interpolationDegree: 3,
});
```

## 補間アルゴリズムの比較

```
Linear (degree=1)
  ●━━━━━━●━━━━━━●    折れ線、2点のみ使用
         ↑ 補間点

Lagrange (degree=5)
  ●     ●     ●━━━●     ●     ●    滑らかな曲線、6点使用
              ↑ 補間点

Hermite (degree=3, 速度付き)
  ●→    ●→    ●→   ●→   非常に滑らか、位置+速度で4点使用
              ↑ 補間点
```

| アルゴリズム | degree | サンプル数 | 精度 | コスト | 用途 |
|---|---|---|---|---|---|
| **Linear** | 1 | 2 | 低 | O(s) | リアルタイム、短間隔 |
| **Lagrange** | n | n+1 | 高 | O(n²s) | 衛星軌道、滑らかな曲線 |
| **Hermite** | n | (n+1)/(k+1) | 最高 | O(n²s) | 高精度軌道、速度あり |

*s = yStride（値の成分数）、k = inputOrder（導関数の次数）*

## 実用パターン

### 衛星軌道の補間

```javascript
const position = new SampledPositionProperty();

// 軌道データを追加（60秒間隔のサンプル）
for (const sample of orbitData) {
  position.addSample(sample.time, sample.position);
}

// Lagrange 5次で滑らかに補間
position.setInterpolationOptions({
  interpolationAlgorithm: LagrangePolynomialApproximation,
  interpolationDegree: 5,
});

// 外挿設定: サンプル範囲外は最後の値を保持
position.forwardExtrapolationType = ExtrapolationType.HOLD;

entity.position = position;
```

### リアルタイムデータの受信

```javascript
const position = new SampledPositionProperty();
position.forwardExtrapolationType = ExtrapolationType.EXTRAPOLATE;

// データ受信時にサンプルを追加
websocket.onmessage = function(data) {
  position.addSample(
    JulianDate.fromIso8601(data.timestamp),
    Cartesian3.fromDegrees(data.lng, data.lat, data.alt)
  );
};

// 次のサンプルが届くまで直線外挿で位置を推定
entity.position = position;
```

### 時間変化する色

```javascript
const color = new SampledProperty(Color);
color.addSample(time0, Color.RED);
color.addSample(time1, Color.BLUE);
color.addSample(time2, Color.GREEN);
// → 赤→青→緑にグラデーション変化

entity.point = new PointGraphics({
  pixelSize: 10,
  color: color,
});
```

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `DataSources/SampledProperty.js` | 汎用サンプルプロパティ |
| `DataSources/SampledPositionProperty.js` | 位置特化版 |
| `Core/LinearApproximation.js` | 線形補間 |
| `Core/LagrangePolynomialApproximation.js` | Lagrange 多項式補間 |
| `Core/HermitePolynomialApproximation.js` | Hermite 多項式補間 |
| `Core/ExtrapolationType.js` | 外挿タイプ列挙 |
| `Core/Quaternion.js` | Quaternion の補間変換 |
| `Core/binarySearch.js` | 二分探索 |
| `Core/JulianDate.js` | 天文日時 |
