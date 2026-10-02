# AnshinAnpi — 安心安否確認システム

顔確認と、事前登録した連絡先への安否確認メール送信を行うための画面デザイン・ソースコードです。

## プロジェクト構成

| ディレクトリ | 内容 |
| --- | --- |
| [anshin-anpi-admin-source](anshin-anpi-admin-source/README.md) | 利用者画面とPC向け管理者画面（`/admin`）を含む実装 |
| [backend](backend/README.md) | Node.js/Fastifyによる利用者向けAPI、PostgreSQL接続、AWS連携 |

フロントエンドは`anshin-anpi-admin-source/`、Node.jsバックエンドは`backend/`で開発します。起動方法、画面一覧、API接続方法は、それぞれのREADMEと`docs/`を参照してください。

## 管理者画面を含むアプリの起動

Node.js 22.13.0以上が必要です。

```bash
cd anshin-anpi-admin-source
npm ci
npm run dev
```

開発サーバーが表示するURLで利用者画面を開き、`/admin`で管理者画面を確認できます。

画面内の処理は現在も表示確認用です。Node.jsの利用者向けAPIを`backend/`に実装しており、画面との接続およびAWSの顔認識・配信サービスの設定は[バックエンド資料](backend/README.md)を参照してください。

依存パッケージ、ビルド出力、ローカルキャッシュ、環境変数ファイルはGitの管理対象から除外しています。

## ローカル PostgreSQL

Docker Desktop と Docker Compose を使い、プロジェクトルートの `compose.yaml` から PostgreSQL を起動できます。初回のみ `.env.example` を `.env` にコピーし、`POSTGRES_PASSWORD` を開発用のパスワードへ変更してください。`.env` は Git 管理対象外です。

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d postgres
docker compose ps
docker compose exec postgres psql -U anshin -d anshin -c "SELECT current_database();"
```

ホストPCで動くNode.jsバックエンドの接続先は `postgresql://localhost:5433/anshin`、ユーザー名は `anshin`、パスワードは `.env` の `POSTGRES_PASSWORD` です。ポートやDB名を変更した場合は `.env` の値に合わせてください。バックエンドを同じ Compose ネットワークで動かす場合は `postgres:5432` を使います。

`docker compose down` でコンテナを停止しても、PostgreSQLデータは名前付きボリュームに残ります。画面側の`db/`はCloudflare D1用テンプレートです。Node.jsバックエンドはルートのPostgreSQLスキーマを利用し、同意前の一時登録データはバックエンドプロセス内の一時メモリに暗号化して保持します。

### 業務テーブルの作成

開発仕様書第10章を基にした PostgreSQL スキーマは [`database/README.md`](database/README.md) に記載しています。開発仕様書第10.1節に合わせた8業務テーブルを作成します。移行管理だけはapp_metaスキーマに置き、Redisは使用しません。

```powershell
.\scripts\database.ps1 -Action migrate
.\scripts\database.ps1 -Action status
# 空の開発DBで制約・削除処理を検証（テストデータはロールバック）
.\scripts\database.ps1 -Action test
```

新規データボリュームでは初回起動時に自動作成されます。既存ボリュームには上記の移行コマンドを使用してください。同じ移行を再実行しても適用済み版はスキップします。個人情報はアプリケーションで暗号化して格納する設計であり、画面・APIへの接続や保存期限による定期削除は別途実装が必要です。

## Node.js 利用者向け API の起動

```powershell
.\scripts\backend.ps1 -Action start
```

APIは`http://localhost:3001`、稼働確認は`/health/ready`、OpenAPIは`/openapi.json`です。[ユーザーAPI仕様](backend/docs/USER_API.md)に登録・同意・顔確認・宛先確認・送信・結果照会の順序とリクエスト形式を記載しています。AWS未設定時、顔確認とメール送信はサービス未準備として応答します。AWS設定項目は[AWS設定資料](backend/docs/AWS_SETUP.md)を参照してください。
