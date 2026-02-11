# CesiumJS コードベース分析ドキュメント

CesiumJS v1.138.0 の内部構造を開発者向けに解説するドキュメント集です。

## ドキュメント一覧

| ファイル | 内容 |
|---|---|
| [01_project_overview.md](./01_project_overview.md) | プロジェクト全体構成・モノレポ構造・ファイル数 |
| [02_architecture.md](./02_architecture.md) | エンジンアーキテクチャ・モジュール構成・依存関係 |
| [03_rendering_pipeline.md](./03_rendering_pipeline.md) | Scene.render() レンダリングパイプライン詳細 |
| [04_entry_points.md](./04_entry_points.md) | Viewer / CesiumWidget のエントリーポイント解説 |
| [05_coding_conventions.md](./05_coding_conventions.md) | コーディング規約・デザインパターン |
| [06_build_and_test.md](./06_build_and_test.md) | ビルドシステム・テスト・CI/CD |
| [07_learning_roadmap.md](./07_learning_roadmap.md) | コードベース学習ロードマップ |
| [08_primitive_system.md](./08_primitive_system.md) | Primitive システム - DrawCommand 生成の仕組み |
| [09_coordinate_system.md](./09_coordinate_system.md) | 座標系と座標変換 |
| [10_camera.md](./10_camera.md) | Camera - カメラ制御システム |
| [11_globe_tile_system.md](./11_globe_tile_system.md) | Globe - Quadtree タイルシステム |
| [12_framestate.md](./12_framestate.md) | FrameState - フレーム情報の受け渡し構造体 |

## 対象バージョン

- CesiumJS: **1.138.0**
- @cesium/engine: **22.3.0**
- @cesium/widgets: **14.3.0**
- 分析日: 2026-02-07
