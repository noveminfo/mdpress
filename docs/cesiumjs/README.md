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
| [13_pass_drawcommand_deep_dive.md](./13_pass_drawcommand_deep_dive.md) | Pass / DrawCommand 深掘り - 描画コマンドパイプライン |
| [14_entity_datasource.md](./14_entity_datasource.md) | Entity / DataSource - 高レベル描画 API |
| [15_sampled_property_interpolation.md](./15_sampled_property_interpolation.md) | SampledProperty - 補間アルゴリズム詳細 |
| [16_geometry_updater.md](./16_geometry_updater.md) | GeometryUpdater - Entity → GeometryInstance 変換とバッチング |
| [17_cesium3dtileset.md](./17_cesium3dtileset.md) | Cesium3DTileset - 3D Tiles 内部構造・トラバーサル・キャッシュ |
| [18_model_gltf_loader.md](./18_model_gltf_loader.md) | Model / glTF ローダー - 3D モデル描画パイプライン |
| [19_shader_system.md](./19_shader_system.md) | Shader システム - ShaderBuilder / GLSL コンパイルパイプライン |
| [20_picking.md](./20_picking.md) | Picking - オブジェクト選択・レイキャスト・深度ピッキング |

## 対象バージョン

- CesiumJS: **1.138.0**
- @cesium/engine: **22.3.0**
- @cesium/widgets: **14.3.0**
- 分析日: 2026-02-07
