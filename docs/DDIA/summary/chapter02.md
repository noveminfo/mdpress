# Chapter 2: Data Models and Query Languages（データモデルとクエリ言語）

## 概要

> 「私の言語の限界は、私の世界の限界を意味する」— ヴィトゲンシュタイン

データモデルはソフトウェア開発において最も重要な部分の一つ。コードの書き方だけでなく、**問題についての考え方そのもの**に影響する。

アプリケーションは**データモデルの層を重ねて**構築される：

1. 実世界 → オブジェクト/データ構造/API（アプリケーション層）
2. データ構造 → JSON/XML/テーブル/グラフ（汎用データモデル）
3. データモデル → バイト列（ストレージエンジン）
4. バイト列 → 電気信号/磁場（ハードウェア）

各層が下位層の複雑さを隠蔽し、異なるチームが協力できるようにしている。

---

## 1. リレーショナルモデル vs ドキュメントモデル

### リレーショナルモデルの歴史

- 1970年、Edgar Coddが提唱
- データを**リレーション（テーブル）**として整理し、各リレーションは**タプル（行）**の順序なし集合
- 1980年代半ばにはRDBMSとSQLが標準に
- 元々はビジネスデータ処理（トランザクション処理、バッチ処理）向けだったが、驚くほど汎用的に活用されている

### NoSQLの誕生

2010年代、リレーショナルモデルへの挑戦として登場。駆動力：

- RDBでは達成しにくい**スケーラビリティ**の需要
- **オープンソース**への選好
- リレーショナルモデルでは不十分な**特殊なクエリ操作**
- リレーショナルスキーマの制約への不満、より**動的で表現力豊かなモデル**への欲求

現実的には**ポリグロットパーシステンス**（複数のデータストアの併用）が主流になる。

### オブジェクト-リレーショナルミスマッチ（インピーダンスミスマッチ）

OOP言語のオブジェクトとRDBのテーブル/行/列との間に不一致がある。ORMフレームワーク（ActiveRecord、Hibernate等）は軽減するが完全には解消できない。

#### 例：LinkedInプロフィール

リレーショナルモデルの場合：
- `users`テーブル（`first_name`, `last_name`等）
- `positions`, `education`, `contact_info`は別テーブル＋外部キー

JSONモデルの場合：
- 一つのドキュメントに全て含まれる
- **ローカリティが良い**（1回のクエリで取得可能）
- 1対多の**ツリー構造が明示的**

```json
{
  "user_id": 251,
  "first_name": "Bill",
  "last_name": "Gates",
  "positions": [
    {"job_title": "Co-chair", "organization": "Bill & Melinda Gates Foundation"},
    {"job_title": "Co-founder, Chairman", "organization": "Microsoft"}
  ],
  "education": [
    {"school_name": "Harvard University", "start": 1973, "end": 1975}
  ]
}
```

### 多対一と多対多のリレーションシップ

IDを使う理由（正規化の本質）：

- 人間にとって意味のある情報は**一箇所だけに保存**
- IDは意味を持たないため**変更の必要がない**
- 重複を排除 → **一貫性を保証**
- 例：`region_id: "us:91"` vs `"Greater Seattle Area"`（文字列を直接保持すると変更時に全コピーの更新が必要）

**問題**: 正規化には多対一関係が必要 → ドキュメントモデルではJOINが弱い。アプリケーションの機能追加でデータは相互接続が増える傾向がある。

### 歴史は繰り返す？ — 階層モデル・ネットワークモデル・リレーショナルモデル

| モデル | 時代 | 特徴 |
|--------|------|------|
| **階層モデル（IMS）** | 1960-70年代 | ツリー構造、JSONに類似。多対多が困難 |
| **ネットワークモデル（CODASYL）** | 1970年代 | レコードが複数の親を持てる。アクセスパスの手動管理が必要で複雑 |
| **リレーショナルモデル** | 1970年代〜 | データをオープンに並べる。クエリオプティマイザが自動で最適なアクセスパスを選択 |

**リレーショナルモデルの勝因**: クエリオプティマイザを一度作れば、全アプリケーションが恩恵を受ける。

**ドキュメントDBの位置づけ**: 階層モデルに回帰（ネスト構造）しつつ、多対一・多対多は外部キー参照でリレーショナルと本質的に同じアプローチ。CODASYLの道は辿っていない。

### リレーショナル vs ドキュメント：今日の比較

#### どちらがシンプルなコードになるか？

| ケース | 適切なモデル |
|--------|-------------|
| ツリー構造のデータ（1対多中心） | **ドキュメントモデル** |
| 多対多関係が頻繁 | **リレーショナルモデル** |
| 高度に相互接続されたデータ | **グラフモデル** |

#### スキーマの柔軟性

| アプローチ | 説明 | 類似概念 |
|-----------|------|---------|
| **Schema-on-read** | スキーマは暗黙的、読み取り時に解釈 | 動的型付け |
| **Schema-on-write** | スキーマは明示的、書き込み時に検証 | 静的型付け |

Schema-on-readが有利な場面：
- コレクション内のアイテムが**異種構造**を持つ
- データ構造が**外部システムに依存**し変化する

スキーマ変更の例：

```javascript
// ドキュメントDB: アプリケーションコードで対応
if (user && user.name && !user.first_name) {
  user.first_name = user.name.split(" ")[0];
}
```

```sql
-- リレーショナルDB: マイグレーション
ALTER TABLE users ADD COLUMN first_name text;
UPDATE users SET first_name = split_part(name, ' ', 1);
```

#### クエリのデータローカリティ

- ドキュメントは**連続した文字列**として保存 → 全体読み取りが高速
- ただし、一部だけ必要な場合でも全ドキュメントをロードする必要がある
- 更新時もドキュメント全体を書き直し
- **ドキュメントは小さく保つ**のが推奨

ローカリティはドキュメントモデル固有ではない：
- Google Spanner — リレーショナルでインターリーブ行
- Oracle — multi-table index cluster tables
- Cassandra/HBase — カラムファミリー

#### 収束するリレーショナルとドキュメント

- リレーショナルDB → JSON/XMLサポートを追加（PostgreSQL, MySQL, DB2等）
- ドキュメントDB → JOIN的機能を追加（RethinkDB, MongoDB）
- **ハイブリッドが未来の方向性**

---

## 2. データのクエリ言語

### 宣言型 vs 命令型

| 特性 | 命令型（Imperative） | 宣言型（Declarative） |
|------|---------------------|---------------------|
| 記述内容 | **方法**（how） | **パターン/条件**（what） |
| 例 | IMS, CODASYL, JavaScript DOM | SQL, CSS, XPath |
| 最適化 | プログラマが手動で | DB/ブラウザが自動で |
| 並列化 | 困難 | 容易 |

```javascript
// 命令型
function getSharks() {
  var sharks = [];
  for (var i = 0; i < animals.length; i++) {
    if (animals[i].family === "Sharks") {
      sharks.push(animals[i]);
    }
  }
  return sharks;
}
```

```sql
-- 宣言型
SELECT * FROM animals WHERE family = 'Sharks';
```

宣言型の利点：
1. **簡潔で理解しやすい**
2. **実装の詳細を隠す** → DBが内部改善しても既存クエリに影響なし
3. **並列実行に適している**

### Web上の宣言型クエリ（CSS vs JavaScript DOM操作）

CSS（宣言型）:
```css
li.selected > p { background-color: blue; }
```

同等のJavaScript DOM操作（命令型）は長く、壊れやすく、状態変更に追従しない。ブラウザでのCSS利用が優れているのと同様に、DBでもSQLのような宣言型言語が優れている。

### MapReduce

- 宣言型でも命令型でもない**中間的**なプログラミングモデル
- `map`関数と`reduce`関数のペアで構成
- **純粋関数**でなければならない（副作用なし、追加クエリなし）

```javascript
// MongoDB MapReduce
db.observations.mapReduce(
  function map() {
    var year = this.observationTimestamp.getFullYear();
    var month = this.observationTimestamp.getMonth() + 1;
    emit(year + "-" + month, this.numAnimals);
  },
  function reduce(key, values) {
    return Array.sum(values);
  },
  { query: { family: "Sharks" }, out: "monthlySharkReport" }
);
```

問題点：2つの関数を慎重に調整する必要がある → MongoDBは宣言型の**aggregation pipeline**を追加：

```javascript
db.observations.aggregate([
  { $match: { family: "Sharks" } },
  { $group: {
    _id: { year: { $year: "$observationTimestamp" },
           month: { $month: "$observationTimestamp" } },
    totalAnimals: { $sum: "$numAnimals" }
  }}
]);
```

> NoSQLシステムは**SQLを再発明**してしまう傾向がある。

---

## 3. グラフ型データモデル

多対多関係が非常に多い場合、グラフとしてモデル化するのが自然。

グラフ = **頂点（vertices）** + **辺（edges）**

適用例：
- **ソーシャルグラフ** — 人と人の関係
- **Webグラフ** — ページ間のリンク
- **道路/鉄道ネットワーク** — 交差点間の路線

グラフの強力な点：**異種のオブジェクトを一つのデータストアで統一的に表現できる**（Facebookの例：人、場所、イベント、チェックイン、コメントが全て一つのグラフ）

### プロパティグラフモデル

各**頂点**：
- 一意ID、入辺の集合、出辺の集合、プロパティ（key-value）

各**辺**：
- 一意ID、始点頂点、終点頂点、ラベル（関係の種類）、プロパティ（key-value）

```sql
-- リレーショナルスキーマで表現
CREATE TABLE vertices (
  vertex_id integer PRIMARY KEY,
  properties json
);
CREATE TABLE edges (
  edge_id    integer PRIMARY KEY,
  tail_vertex integer REFERENCES vertices (vertex_id),
  head_vertex integer REFERENCES vertices (vertex_id),
  label       text,
  properties  json
);
```

重要な特性：
1. **任意の頂点間に辺を作れる**（スキーマによる制約なし）
2. 任意の頂点から入辺・出辺を**効率的に辿れる**
3. 異なるラベルで**異なる種類の関係を1つのグラフに格納**

### Cypherクエリ言語（Neo4j）

```cypher
-- データ挿入
CREATE
  (NAmerica:Location {name:'North America', type:'continent'}),
  (USA:Location      {name:'United States', type:'country'}),
  (Idaho:Location    {name:'Idaho',         type:'state'}),
  (Lucy:Person       {name:'Lucy'}),
  (Idaho) -[:WITHIN]->  (USA) -[:WITHIN]-> (NAmerica),
  (Lucy)  -[:BORN_IN]-> (Idaho)

-- クエリ: 米国生まれでヨーロッパ在住の人
MATCH
  (person) -[:BORN_IN]->  () -[:WITHIN*0..]-> (us:Location {name:'United States'}),
  (person) -[:LIVES_IN]-> () -[:WITHIN*0..]-> (eu:Location {name:'Europe'})
RETURN person.name
```

`-[:WITHIN*0..]->` = WITHIN辺を0回以上辿る（正規表現の`*`に相当）。宣言型なので実行戦略はクエリオプティマイザが自動決定。

### SQLでのグラフクエリ

同じクエリをSQLで書くと**再帰共通テーブル式（WITH RECURSIVE）**が必要で、Cypherの4行が**29行**になる。

> 同じクエリが一方の言語では4行、他方では29行 → **異なるデータモデルは異なるユースケースに最適化されている**

### トリプルストアとSPARQL

トリプルストア：全情報を **(subject, predicate, object)** の3つ組で保存。

```turtle
@prefix : <urn:example:>.
_:lucy   a :Person;   :name "Lucy";          :bornIn _:idaho.
_:idaho  a :Location; :name "Idaho";         :type "state";   :within _:usa.
_:usa    a :Location; :name "United States";  :type "country"; :within _:namerica.
```

**SPARQL**クエリ（Cypherよりさらに簡潔）：
```sparql
PREFIX : <urn:example:>
SELECT ?personName WHERE {
  ?person :name ?personName.
  ?person :bornIn / :within* / :name "United States".
  ?person :livesIn / :within* / :name "Europe".
}
```

#### セマンティックWeb

- RDF（Resource Description Framework）はWebサイト間で機械可読データを共有する仕組みとして設計
- 2000年代初頭に過度な期待 → 実用化は限定的
- ただしトリプルストアはアプリケーション内部のデータモデルとして有用

### グラフDBとCODASYLネットワークモデルの違い

| CODASYL | グラフDB |
|---------|---------|
| スキーマがネスト関係を規定 | **任意の頂点間に辺を作成可能** |
| アクセスパスの手動走査のみ | IDで直接参照 or インデックス |
| レコードの子は順序付き | 頂点・辺に順序なし |
| クエリは命令型のみ | **宣言型言語**（Cypher, SPARQL） |

### Datalog

- 1980年代から研究されている基礎的な言語
- Datomic、Cascalog（Hadoop上）で使用
- データモデル：`predicate(subject, object)` 形式

```prolog
% ルール定義
within_recursive(Location, Name) :- name(Location, Name).
within_recursive(Location, Name) :- within(Location, Via),
                                    within_recursive(Via, Name).
migrated(Name, BornIn, LivingIn) :- name(Person, Name),
                                    born_in(Person, BornLoc),
                                    within_recursive(BornLoc, BornIn),
                                    lives_in(Person, LivingLoc),
                                    within_recursive(LivingLoc, LivingIn).

?- migrated(Who, 'United States', 'Europe').
% Who = 'Lucy'.
```

ルールを組み合わせて複雑なクエリを段階的に構築 → 単発クエリには不便だが、**複雑なデータには強力**。

---

## まとめ

データモデルの歴史的な流れ：

```
階層モデル（ツリー）
  ↓ 多対多関係の問題
リレーショナルモデル（テーブル + JOIN）
  ↓ 一部のユースケースに不適合
NoSQL の分岐
  ├─ ドキュメントDB（自己完結型データ、関係が少ない）
  └─ グラフDB（あらゆるものが相互接続）
```

| モデル | 得意なケース | スキーマ |
|--------|-------------|---------|
| **ドキュメント** | 自己完結型データ、1対多関係 | Schema-on-read（暗黙的） |
| **リレーショナル** | 多対一・多対多関係、正規化データ | Schema-on-write（明示的） |
| **グラフ** | 高度に相互接続されたデータ | 柔軟（制約なし） |

各モデルには固有のクエリ言語がある：

| クエリ言語 | 対象モデル | 特徴 |
|-----------|-----------|------|
| **SQL** | リレーショナル | 宣言型、最も広く使用 |
| **MapReduce** | ドキュメント（MongoDB等） | 半宣言・半命令型 |
| **Aggregation Pipeline** | ドキュメント（MongoDB） | JSON構文の宣言型 |
| **Cypher** | プロパティグラフ（Neo4j） | パターンマッチング |
| **SPARQL** | トリプルストア（RDF） | 簡潔なグラフクエリ |
| **Datalog** | 論理ベース（Datomic） | ルールの段階的構築 |

> **重要な教訓**: 一つの万能データモデルは存在しない。アプリケーションの要件に適したモデルを選択することが重要。
