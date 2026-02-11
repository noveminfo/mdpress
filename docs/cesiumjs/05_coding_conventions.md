# 05. コーディング規約・デザインパターン

## 命名規則

### ファイル・ディレクトリ
- ディレクトリ: `PascalCase` (例: `Source/Scene`)
- ファイル: JavaScript 識別子と同名 + `.js` (例: `Cartesian3.js`)

### JavaScript 識別子
| 種類 | 規則 | 例 |
|---|---|---|
| コンストラクタ | PascalCase | `Cartesian3`, `BoundingSphere` |
| 関数 | camelCase | `binarySearch()`, `defined()` |
| 変数/プロパティ | camelCase | `modelMatrix`, `tileWidth` |
| プライベート | `_` プレフィックス | `this._canvas`, `this._scene` |
| 定数 | UPPER_SNAKE_CASE | `Cartesian3.UNIT_X`, `Color.RED` |

### 特殊プレフィックス/サフィックス
| パターン | 意味 | 例 |
|---|---|---|
| `from*` | 静的ファクトリメソッド | `Cartesian3.fromRadians()` |
| `to*` | 型変換 | `toString()`, `toCartesian()` |
| `result` パラメータ | 出力先オブジェクト | `Cartesian3.add(a, b, result)` |
| `options` パラメータ | オプション引数 | `new Viewer(container, options)` |
| `scratch*` | ファイルスコープ一時変数 | `const scratchCartesian = new Cartesian3()` |

## コアパターン

### 1. defined() による null チェック

```javascript
// ✅ CesiumJS スタイル
if (defined(value)) { ... }

// ❌ 使わない
if (value !== undefined && value !== null) { ... }
```

### 2. result パラメータ (GC 圧力回避)

```javascript
// ✅ result パラメータで既存オブジェクトを再利用
const result = new Cartesian3();
Cartesian3.add(v0, v1, result);

// ❌ 毎回新しいオブジェクト生成 (GC 負荷)
const result = Cartesian3.add(v0, v1);
```

### 3. scratch 変数 (一時オブジェクト再利用)

```javascript
// ファイルスコープで宣言
const scratchCartesian = new Cartesian3();

function computeSomething(input) {
  // 一時計算に scratch を使い、new を避ける
  Cartesian3.normalize(input, scratchCartesian);
  // ...
}
```

**注意**: scratch 変数は再入不可。同じ scratch を使う関数をネストして呼ぶとバグになる。

### 4. Check クラス + pragmas.debug (開発時エラーチェック)

```javascript
//>>includeStart('debug', pragmas.debug);
Check.typeOf.object("cartesian", cartesian);
Check.typeOf.number.greaterThan("radius", radius, 0.0);
//>>includeEnd('debug');
```

`//>>includeStart` / `//>>includeEnd` はビルド時に除去されるため、
リリースビルドではパフォーマンスに影響しません。

### 5. Object.freeze() で enum/定数を定義

```javascript
const SceneMode = {
  MORPHING: 0,
  COLUMBUS_VIEW: 1,
  SCENE2D: 2,
  SCENE3D: 3,
};
export default Object.freeze(SceneMode);
```

### 6. options パターン (自己文書化)

```javascript
const viewer = new Cesium.Viewer("container", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  sceneMode: Cesium.SceneMode.SCENE3D,
  shadows: true,
  shouldAnimate: true,
});
```

### 7. from コンストラクタ (ファクトリメソッド)

```javascript
// 通常のコンストラクタ (ECEF 座標)
const position = new Cartesian3(x, y, z);

// from ファクトリ (経緯度から変換)
const position = Cartesian3.fromDegrees(lng, lat, height);
const position = Cartesian3.fromRadians(lng, lat, height);
```

### 8. destroyObject パターン (リソース解放)

```javascript
MyClass.prototype.destroy = function () {
  this._texture = this._texture && this._texture.destroy();
  return destroyObject(this);
};

// 使用側
if (!myObj.isDestroyed()) {
  myObj.destroy();
}
```

## フォーマット規則

| 項目 | 規則 |
|---|---|
| フォーマッタ | Prettier (デフォルト設定) |
| 文字列 | シングルクォート `'` |
| セミコロン | 必須 |
| 改行コード | LF |
| インデント | 2スペース (GLSL は 4スペース) |
| 等値比較 | `===` / `!==` を使用 |
| 浮動小数点 | `.0` 付き (`const f = 1.0;` not `1`) |
| nullish | `height = height ?? 0.0;` |

## GLSL 規約

| 項目 | 規則 | 例 |
|---|---|---|
| ファイル拡張子 | `.glsl` | `GlobeFS.glsl` |
| 頂点シェーダー | `*VS.glsl` | `GlobeVS.glsl` |
| フラグメントシェーダー | `*FS.glsl` | `GlobeFS.glsl` |
| 組み込み関数 | `czm_` プレフィックス | `czm_translateRelativeToEye` |
| Varying | `v_` プレフィックス | `v_textureCoordinates` |
| Uniform | `u_` プレフィックス | `u_dayTextures` |
| Eye座標 | `EC` サフィックス | `positionEC` |
| テクスチャ座標 | `s`, `t` (not `u`, `v`) | |

## TypeScript 対応状況

- **段階的導入**: `@ts-check` を各ファイル先頭に追加してオプトイン
- `tsconfig.json`: `checkJs: false` (デフォルトは型チェックなし)
- `noImplicitAny: true`: オプトインしたファイルでは暗黙 any 禁止
- JSDoc で型アノテーション (TypeScript 型定義は `tsd-jsdoc` で生成)
