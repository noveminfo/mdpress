# Chapter 11: Stream Processing（ストリーム処理）

## 概要

> 「動作する複雑なシステムは、必ず動作する単純なシステムから発展したものである。」— John Gall, Systemantics (1975)

Chapter 10 ではバッチ処理（有限の入力を処理）を扱った。本章ではその対となるストリーム処理 — **無限（unbounded）** のデータを逐次的・継続的に処理する手法を扱う。バッチの「1日分をまとめて処理」という遅延を、イベント発生直後のリアルタイム処理へと縮める。

---

## 1. イベントストリームの伝送（Transmitting Event Streams）

### イベントとは

| 用語 | 説明 |
|------|------|
| **Event** | 「ある時点で何かが起きた」ことを表す不変の小さなレコード。タイムスタンプ付き |
| **Producer**（publisher/sender） | イベントを生成する側 |
| **Consumer**（subscriber/recipient） | イベントを受け取り処理する側 |
| **Topic / Stream** | 関連イベントをグループ化する単位 |

### メッセージングシステム

producerとconsumerを接続する方式。設計時の2つの重要な問い:

1. **producerがconsumerの処理速度を超えたらどうなるか？**
   - メッセージを**ドロップ** / **キューにバッファ** / **バックプレッシャー**（送信をブロック）
2. **ノードがクラッシュしたらメッセージは失われるか？**
   - ディスク書き込み + レプリケーション → 耐久性（スループットとのトレードオフ）

### 直接メッセージング vs メッセージブローカー

| 方式 | 例 | 特徴 |
|------|-----|------|
| **直接メッセージング** | UDP multicast, ZeroMQ, StatsD, Webhook | 低レイテンシだが、consumer/producerが常時オンライン前提。メッセージ喪失リスク |
| **メッセージブローカー** | RabbitMQ, ActiveMQ, IBM MQ, Azure Service Bus | ブローカーがデータを一元管理。クライアントの接続/切断に強い。非同期配信 |

### メッセージブローカー vs データベース

| 観点 | データベース | メッセージブローカー |
|------|-------------|-------------------|
| データ保持 | 明示的に削除するまで保持 | 配信完了後に削除（通常） |
| ワーキングセット | 任意のサイズ | 小さいキューを前提 |
| 検索 | セカンダリインデックス | トピックパターンマッチング |
| 通知 | ポーリング（基本） | 新データ到着を即通知 |

### 複数Consumer のパターン

```
(a) Load Balancing          (b) Fan-out
    ┌── Consumer 1              ┌── Consumer 1 (全メッセージ)
msg ┤                      msg ─┤
    └── Consumer 2              └── Consumer 2 (全メッセージ)
  各メッセージ→1つのconsumer    各メッセージ→全consumer
```

- 2つのパターンは組み合わせ可能（consumer group）

### 確認応答と再配信

- Consumer はブローカーに **acknowledgment** を返す → ブローカーがキューから削除
- 未確認ならブローカーは別の consumer に再配信
- **Load Balancing + 再配信 → メッセージ順序が崩れる可能性あり**

---

## 2. パーティション化ログ（Partitioned Logs）

### 従来型ブローカーの問題

- メッセージは消費すると消える → バッチ処理のような再実行不可
- 新規 consumer は過去のメッセージを読めない

### ログベースメッセージブローカー

**発想**: データベースのログ + メッセージングの即時通知 = ログベースメッセージブローカー

```
Topic
├── Partition 0: [msg0] [msg1] [msg2] [msg3] → Consumer A
├── Partition 1: [msg0] [msg1] [msg2]        → Consumer B
└── Partition 2: [msg0] [msg1] [msg2] [msg3] [msg4] → Consumer C

各パーティション内はオフセットで完全順序保証
パーティション間は順序保証なし
```

- **Apache Kafka**, Amazon Kinesis Streams, Twitter DistributedLog
- ディスクに書き込みつつ百万メッセージ/秒のスループットを達成

### ログ vs 従来型メッセージングの比較

| 観点 | AMQP/JMS 方式 | ログベース方式 |
|------|--------------|--------------|
| Fan-out | トピックsubscription | 複数consumerが独立にログを読む |
| Load balancing | メッセージ単位でconsumerに振り分け | **パーティション単位**で振り分け |
| 並列度上限 | consumer数に依存 | パーティション数が上限 |
| メッセージ順序 | 再配信で崩れうる | パーティション内で保証 |
| 適用場面 | メッセージ処理が重く並列化したい場合 | 高スループット・順序重要な場合 |

### Consumer オフセット

- consumer は offset（現在位置）を記録するだけ → ブローカーの管理コスト低い
- DB replication の log sequence number と同じ原理
- consumer障害時: 別ノードが最後の記録済みオフセットから再開

### ディスク容量とメッセージ再生

- ログはセグメントに分割、古いセグメントを削除 → **circular buffer**（リングバッファ）
- 6TB HDD + 150MB/s書き込み → 約11時間分バッファ可能
- スループットは履歴量に関わらず一定（常にディスク書き込み）
- **古いメッセージの再生（replay）が可能** → バッチ処理と同様に実験・エラー回復が容易

---

## 3. データベースとストリーム（Databases and Streams）

### システム間の同期

複数システム（OLTP DB, キャッシュ, 検索インデックス, DWH）を同期する必要がある。

**Dual writes の問題**:
- **レース条件**: 2つのクライアントが同時に書き込む → DB と検索インデックスの値が食い違う
- **部分的失敗**: 一方の書き込みのみ成功 → 不整合

**解決策**: 1つのリーダー（DB）をイベントストリームのソースとし、他のシステムをフォロワーにする

### Change Data Capture（CDC）

| 項目 | 説明 |
|------|------|
| **定義** | DBへの全書き込み変更を観察し、他システムにレプリケート可能な形で抽出する |
| **仕組み** | DBをリーダー化、他システム（検索インデックス等）をフォロワー化 |
| **実装** | トリガー（脆弱）またはレプリケーションログ解析（堅牢だがスキーマ変更対応が課題） |
| **ツール** | Debezium (MySQL binlog), Bottled Water (PostgreSQL WAL), Maxwell, GoldenGate (Oracle) |
| **特性** | 通常は非同期 → レプリケーションラグの問題が適用される |

**初期スナップショット**: 全履歴ログがない場合、まず一貫性あるスナップショットを取り、既知のオフセットから変更適用を開始

**ログコンパクション**: 同一キーの古い値を破棄し最新値のみ保持 → スナップショットなしで新システムを構築可能

**API サポート**: RethinkDB, Firebase, CouchDB, VoltDB, Kafka Connect がchange streamをファーストクラスのインターフェースとして提供

### Event Sourcing

| 比較項目 | CDC | Event Sourcing |
|---------|-----|---------------|
| 抽象レベル | DBの低レベル変更（binlog等） | アプリケーションレベルの意図 |
| DBの使い方 | 通常のミュータブル操作 | Append-only（更新・削除を禁止/非推奨） |
| アプリの認識 | CDCの存在を知る必要なし | イベントログ上にロジックを明示的に構築 |
| ログコンパクション | 可能（最新値で十分） | 不可（全履歴が必要） |

**コマンド vs イベント**:
- **Command**: ユーザーからのリクエスト（まだ失敗しうる、バリデーション前）
- **Event**: バリデーション成功後に確定した不変の事実

### State, Streams, and Immutability

```
state（現在の状態）= ∫ events dt  （イベントストリームの積分）
change stream      = d(state)/dt  （状態の微分）

→ ミュータブルな状態とイミュータブルなイベントログは同じコインの裏表
```

> 「トランザクションログはDBへの全変更を記録する。DBの内容はログの最新レコード値のキャッシュに過ぎない。真実はログである。」— Pat Helland

**不変イベントの利点**:
- 監査証跡（会計の元帳と同じ原理）
- バグからの回復が容易（破壊的上書きがないため）
- 分析に有用（カートへの追加→削除の履歴を保持）

**CQRS（Command Query Responsibility Segregation）**:
- 書き込み形式（イベントログ）と読み取り形式（アプリケーション状態）を分離
- 同一イベントログから複数の読み取り最適化ビューを導出
- 正規化/非正規化の議論が不要に

**不変性の限界**:
- 更新/削除頻度が高い → 履歴が肥大化、コンパクションの性能が重要
- プライバシー規制（GDPR等）→ 実際にデータを消す必要あり（excision/shunning）
- 真のデータ削除は困難（コピーがストレージ、バックアップ等に散在）

---

## 4. ストリームの処理（Processing Streams）

ストリームを受け取った後の3つの選択肢:

1. **ストレージに書き込む**（DB、キャッシュ、検索インデックス）→ CDCの消費者と同様
2. **ユーザーへプッシュ**（メールアラート、ダッシュボード、プッシュ通知）
3. **別のストリームを生成**（パイプライン処理） ← 本章の主題

### ストリーム処理の用途

| 用途 | 説明 |
|------|------|
| **Complex Event Processing (CEP)** | イベントパターンを検索（SQLライクなクエリ言語）。クエリが長期保持、データが流れる |
| **Stream Analytics** | 集約・統計指標（レート、移動平均、パーセンタイル）。確率的アルゴリズム（Bloom filter, HyperLogLog） |
| **Materialized View維持** | DBの変更ストリームからキャッシュ/検索インデックス/DWHを常時更新。無限ウィンドウが必要 |
| **ストリーム検索** | クエリを事前登録、ドキュメントをクエリに照合（例: Elasticsearch Percolator） |
| **Message passing / RPC** | Actor model との境界領域。ストリーム処理 ≠ Actor（耐久性、マルチサブスクライバ、非循環パイプライン） |

### 時間の推論（Reasoning About Time）

**Event time vs Processing time**:
- **Event time**: イベントが実際に発生した時刻（イベント内のタイムスタンプ）
- **Processing time**: ストリームプロセッサがイベントを処理した時刻
- 混同すると誤ったデータになる（例: 再起動後のバックログ処理でスパイクが見える）

**遅延イベント（straggler）の扱い**:
1. 無視する（少量なら許容）
2. 補正値を発行する（ウィンドウを更新）

**デバイスクロックの問題**（モバイルアプリ等）: 3つのタイムスタンプを記録:
- イベント発生時刻（デバイスクロック）
- サーバー送信時刻（デバイスクロック）
- サーバー受信時刻（サーバークロック）
- → 2番目と3番目の差分でデバイスクロックのオフセットを推定

### ウィンドウの種類

| 種類 | 特徴 | 例 |
|------|------|-----|
| **Tumbling window** | 固定長、重複なし | 1分ごとに区切る |
| **Hopping window** | 固定長、重複あり | 5分ウィンドウ、1分ホップ |
| **Sliding window** | 任意の2イベントが一定時間内 | 5分以内のイベントをグループ化 |
| **Session window** | 可変長、ユーザー非活動で区切る | 30分操作なしでセッション終了 |

### ストリーム結合（Stream Joins）

| 結合タイプ | 入力 | 状態管理 | 例 |
|-----------|------|---------|-----|
| **Stream-stream join** | 2つのイベントストリーム | 時間ウィンドウ内のイベントを保持 | 検索イベント ⟷ クリックイベント |
| **Stream-table join** | イベントストリーム + DB changelog | DBのローカルコピーを保持 | ユーザーアクティビティにプロフィール情報を付加 |
| **Table-table join** | 2つのDB changelog | 両テーブルの最新状態を保持 | Twitter タイムライン（tweets ⟕ follows） |

**時間依存性**: ストリーム間のイベント順序が不定 → 結合が非決定的になりうる
- **Slowly Changing Dimension (SCD)**: 結合レコードの各バージョンにIDを付与 → 決定的だがログコンパクション不可

### 耐障害性（Fault Tolerance）

バッチ処理: タスク失敗 → 再起動（入力は不変、出力は完了時に可視化）。
ストリーム処理: ストリームは無限 → 最初からの再起動は非現実的。

| 手法 | 仕組み | 使用例 |
|------|--------|-------|
| **Microbatching** | ストリームを小ブロック（~1秒）に分割し各ブロックをバッチ処理 | Spark Streaming |
| **Checkpointing** | 定期的に状態のスナップショットを永続ストレージに保存。障害時はチェックポイントから再開 | Apache Flink |
| **Atomic commit** | 全出力と副作用をアトミックに適用（フレームワーク内部で完結） | Google Cloud Dataflow, VoltDB |
| **Idempotence** | 同じ操作を複数回実行しても結果が同じ。メッセージオフセットをDBに記録し重複適用を検出 | Kafka + 外部DB |

**Exactly-once semantics**（正確には effectively-once）:
- フレームワーク内部では microbatch/checkpoint で実現
- 外部システムへの出力 → アトミックコミットまたは冪等性が必要

**障害後の状態再構築**:
- リモートDBに状態を保持（遅い）
- ローカル状態 + 定期レプリケーション（Flink → HDFS スナップショット、Samza/Kafka Streams → Kafka トピックへ状態変更送信）
- 入力ストリームから再構築（短いウィンドウの場合）

---

## 全体構造ツリー

```
Chapter 11: Stream Processing
├── イベントストリームの伝送
│   ├── イベント: 不変レコード（timestamp付き）
│   ├── メッセージングシステム
│   │   ├── 2つの問い: 過負荷時の挙動 / 耐久性
│   │   ├── 直接メッセージング: UDP, ZeroMQ, Webhook
│   │   ├── メッセージブローカー: RabbitMQ, ActiveMQ, IBM MQ
│   │   │   ├── vs データベース（保持/検索/通知の違い）
│   │   │   ├── Load Balancing vs Fan-out
│   │   │   └── Ack と再配信（順序問題）
│   │   └── パーティション化ログ
│   │       ├── ログベースブローカー: Kafka, Kinesis
│   │       ├── Consumer オフセット（= DB replication の LSN）
│   │       ├── ディスク: circular buffer（11h分@6TB）
│   │       └── メッセージ再生（replay）が可能
│   └── メッセージブローカー vs DB → ハイブリッド = ログベースブローカー
│
├── データベースとストリーム
│   ├── システム間同期
│   │   ├── ETL / バッチ → 遅い
│   │   └── Dual writes → レース条件・部分的失敗
│   ├── Change Data Capture (CDC)
│   │   ├── DBをリーダー、他をフォロワーに
│   │   ├── 実装: binlog解析, WAL, oplog
│   │   ├── 初期スナップショット + ログコンパクション
│   │   └── API: RethinkDB, Firebase, Kafka Connect
│   ├── Event Sourcing
│   │   ├── アプリレベルのイミュータブルイベント
│   │   ├── Command vs Event
│   │   └── ログコンパクション不可（全履歴必要）
│   └── State, Streams, Immutability
│       ├── state = ∫events, stream = d(state)/dt
│       ├── 「真実はログ。DBはキャッシュ」
│       ├── CQRS: 書き込み形式 ≠ 読み取り形式
│       └── 不変性の限界: 肥大化, GDPR
│
├── ストリームの処理
│   ├── 用途
│   │   ├── CEP: イベントパターン検索
│   │   ├── Stream Analytics: 集約・統計
│   │   ├── Materialized View 維持
│   │   ├── ストリーム検索（Percolator）
│   │   └── Message passing / Actor model
│   ├── 時間の推論
│   │   ├── Event time vs Processing time
│   │   ├── Straggler の扱い（無視 or 補正）
│   │   ├── デバイスクロック補正（3つのタイムスタンプ）
│   │   └── ウィンドウ: Tumbling / Hopping / Sliding / Session
│   ├── ストリーム結合
│   │   ├── Stream-stream join（時間ウィンドウ）
│   │   ├── Stream-table join（CDCで更新）
│   │   ├── Table-table join（Materialized View維持）
│   │   └── 時間依存性 → SCD
│   └── 耐障害性
│       ├── Microbatching（Spark Streaming）
│       ├── Checkpointing（Flink）
│       ├── Atomic commit（Dataflow, VoltDB）
│       ├── Idempotence（オフセット記録）
│       └── 状態再構築: ローカルレプリカ or 入力再生
│
└── まとめ
    ├── AMQP/JMS方式 vs ログベース方式
    ├── CDC / Event Sourcing → システム統合の基盤
    ├── 3種の結合 + 時間の扱い
    └── Exactly-once = microbatch + checkpoint + idempotence
```
