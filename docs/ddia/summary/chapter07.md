# Chapter 7: Transactions（トランザクション）

## 概要

> 「複雑なことに直面する必要のない概念フレームワークを持つべきだ。」— エリック・ブリューワー

トランザクションは、アプリケーションが複数の読み書きを1つの論理的な操作にまとめるための仕組み。成功（commit）か失敗（abort/rollback）のどちらかで、部分的な失敗はない。

---

## 1. ACID の意味

| 属性 | 意味 | 詳細 |
|------|------|------|
| **Atomicity** | 原子性 | 障害時にトランザクション全体を中断・ロールバック。「all or nothing」 |
| **Consistency** | 一貫性 | アプリケーションの不変条件（invariants）が常に満たされる。**これはアプリケーションの責任** |
| **Isolation** | 分離性 | 同時実行トランザクションが互いに干渉しない。理論的にはserializability |
| **Durability** | 永続性 | コミットされたデータは失われない（ディスク書き込み、レプリケーション等） |

**注意**: ACIDの各用語の実際の意味はデータベースによって大きく異なる。「ACIDコンプライアント」は曖昧なマーケティング用語になりがち。

**対照**: BASE（Basically Available, Soft state, Eventual consistency）— ACIDの対義語として使われるが、こちらもかなり曖昧。

---

## 2. 単一オブジェクト vs 複数オブジェクト操作

| 種別 | 説明 | 保証 |
|------|------|------|
| **単一オブジェクト** | 1つのレコードへの原子的書き込み | ほぼ全DBが提供（compare-and-set等） |
| **複数オブジェクト** | 複数レコード・テーブルにまたがる操作 | トランザクションが必要 |

### 複数オブジェクトトランザクションが必要なケース

- 外部キー参照の整合性
- ドキュメントDBの非正規化データ更新
- セカンダリインデックスの更新

### エラー処理とリトライ

トランザクション中断時のリトライ注意点:
- ネットワーク障害でコミットが成功していたが確認が失われた場合 → 二重実行
- 過負荷によるエラー → リトライが負荷を悪化
- 一時的エラーのみリトライ可能（制約違反は不可）
- 副作用（メール送信等）はロールバックされない
- クライアント自体の障害 → リトライ不可

---

## 3. 弱い分離レベル（Weak Isolation Levels）

### Read Committed（読み取りコミット）

| 保証 | 内容 | 実装方法 |
|------|------|----------|
| **No dirty reads** | コミットされたデータのみ読める | 書き込みロックの保持中は古い値を返す |
| **No dirty writes** | コミットされたデータのみ上書き可能 | 行レベルロックで書き込みを直列化 |

**デフォルト設定**: Oracle 11g, PostgreSQL, SQL Server 2012, MemSQL等

### Snapshot Isolation（スナップショット分離）/ Repeatable Read

```
問題: Read Committedでも発生する異常
├── Nonrepeatable Read（読み取りスキュー）
│   ├── 例: Aliceが2つの口座残高を異なる時点で読む
│   ├── 通常は許容可能
│   └── 問題になるケース:
│       ├── バックアップ（長時間実行）
│       └── 分析クエリ（OLAP）
└── 解決: Snapshot Isolation
    ├── 各トランザクションがDBの一貫したスナップショットから読む
    └── 書き込みが他のトランザクションに影響しない
```

**MVCC（Multi-Version Concurrency Control）**:
- 各行に `created_by` と `deleted_by` のトランザクションIDを保持
- 可視性ルール: 自トランザクション開始前にコミット済みで、削除されていないバージョンを表示

**命名の混乱**: SQL標準の `REPEATABLE READ` の定義が曖昧 → Oracle: Serializable, PostgreSQL/MySQL: Repeatable Read と呼ぶが実質同じ

### インデックスとスナップショット分離

- **方法1**: インデックスが全バージョンを指し、フィルタリング
- **方法2**: CouchDB/Datomic式 — append-onlyのB-tree（copy-on-write）

---

## 4. 更新ロスト（Lost Updates）の防止

read-modify-writeサイクルで発生。2つのトランザクションが同じ値を読み、修正して書き戻す。

| 対策 | 説明 | 例 |
|------|------|----|
| **Atomic operations** | DB提供のアトミック操作 | `UPDATE counters SET value = value + 1` |
| **Explicit locking** | `SELECT FOR UPDATE` | アプリケーションが明示的にロック |
| **Automatic detection** | DBが自動検出しアボート | PostgreSQL, Oracle, SQL Server（SI下） |
| **Compare-and-set** | 条件付き更新 | `UPDATE ... WHERE content = '旧値'` |
| **Conflict resolution** | レプリケーション環境 | commutative operations（兄弟値のマージ） |

**注意**: レプリケーション環境ではロックやcompare-and-setは機能しない → last write wins (LWW)がデフォルトだがデータロスの危険

---

## 5. Write Skew と Phantom

### Write Skew（書き込みスキュー）

```
パターン:
1. SELECT: 条件を満たす行を検索
2. アプリケーションコードで判断
3. INSERT/UPDATE/DELETE: 判断に基づく書き込み

問題: ステップ1の前提がステップ3の時点で無効になっている可能性

例:
├── 医師の当直（最低1人必要だが2人同時に休みを申請）
├── ミーティングルームの二重予約
├── ユーザー名の一意性
├── 二重支出の防止
└── マルチプレイヤーゲームのコリジョン
```

### Phantom（ファントム）

- あるトランザクションの書き込みが、別のトランザクションの検索結果を変える現象
- Write skewの根本原因

### 対策: Materializing Conflicts（衝突の実体化）

- ファントムを防ぐために、ロック対象となる具体的な行を事前作成
- 例: ミーティングルーム予約テーブルに全時間スロットの行を作成
- **最終手段** — Serializableを使うべき

---

## 6. Serializability（直列化可能性）

最も強い分離レベル。3つの実装方法:

### 6.1 実際の直列実行（Actual Serial Execution）

```
条件:
├── トランザクションが短い
├── データセットがメモリに収まる
└── 書き込みスループットが1CPUコアで処理可能

実現方法:
├── ストアドプロシージャ: トランザクション全体をDB内で実行
│   ├── 歴史的に評判が悪い（言語、デバッグ困難等）
│   └── 現代的なアプローチ: VoltDB (Java/Groovy), Datomic (Java/Clojure), Redis (Lua)
└── パーティショニング: 各パーティションで独立した直列実行
    └── 制約: クロスパーティションTxはパーティション数に線形なレイテンシ
```

**使用例**: VoltDB, Datomic, Redis, H-Store

### 6.2 Two-Phase Locking（2PL）

```
ルール（Read Committedとの違い）:
├── Read Committed: Writer → Reader をブロックしない
└── 2PL: Writer ↔ Reader 互いにブロック

ロックの種類:
├── Shared lock（共有ロック）: 複数の読み取りが同時可能
├── Exclusive lock（排他ロック）: 書き込み時、他の読み書き全てをブロック
├── Predicate lock（述語ロック）: 条件に一致する全行（未存在含む）をロック
└── Index-range lock（インデックス範囲ロック）: 述語ロックの実用的な近似
    └── 範囲を広げてロック → 精度は低いがオーバーヘッド小
```

| 特性 | 詳細 |
|------|------|
| パフォーマンス | Snapshot Isolationより大幅に悪い |
| デッドロック | 自動検出して1つをアボート |
| 使用例 | MySQL (InnoDB) Serializable, SQL Server |

### 6.3 Serializable Snapshot Isolation（SSI）

```
特性:
├── 楽観的（Optimistic）並行制御
│   ├── トランザクションをブロックせず進行
│   └── コミット時に競合を検出 → 競合あればアボート
├── Snapshot Isolationの上に構築
└── 検出する2つのケース:
    ├── ① Stale MVCC read: 読んだデータがコミット時に変更されている
    └── ② 読み取り後の書き込み: 読んだ範囲に他トランザクションが書き込み
```

| 比較 | 2PL | SSI |
|------|-----|-----|
| 方式 | 悲観的（ロック） | 楽観的（検出） |
| 読み取りブロック | あり | なし |
| パフォーマンス | 競合多時は安定だが遅い | 競合少ない時に有利 |
| 使用例 | MySQL InnoDB | PostgreSQL 9.1+, FoundationDB |

---

## まとめ

```
トランザクションの課題と解決策
├── ACID
│   ├── Atomicity → abort/rollback
│   ├── Consistency → アプリケーションの責任
│   ├── Isolation → 分離レベルで制御
│   └── Durability → ディスク/レプリケーション
│
├── 競合条件（Race Conditions）
│   ├── Dirty reads → Read Committed で防止
│   ├── Dirty writes → ほぼ全DBで防止
│   ├── Read skew → Snapshot Isolation（MVCC）
│   ├── Lost updates → Atomic ops / Explicit lock / Auto detect
│   ├── Write skew → Serializable のみ
│   └── Phantom reads → Index-range locks / Serializable
│
└── Serializable の実装
    ├── 実際の直列実行 → 短いTx + メモリ内データ
    ├── 2PL → ロックベース、パフォーマンス犠牲
    └── SSI → 楽観的、最も有望
```

### 核心的な洞察

- トランザクションはアプリケーションの**エラー処理を大幅に簡素化**する抽象化
- 「ACIDコンプライアント」は曖昧 — 実際の分離レベルを確認すべき
- ほとんどのDBはデフォルトで**弱い分離レベル**を使用（Serializableではない）
- Write skewは**Serializableでのみ**防止可能 — 弱い分離レベルでは見落としがち
- SSI（Serializable Snapshot Isolation）が**最も有望**な新しいアプローチ
- 分散データベースでのトランザクションはさらに複雑 → Chapter 8, 9 で詳述
