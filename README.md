# 安心安否確認システム

登録者の顔認証、連絡先への登録通知・安否確認メール、管理画面を提供するシステムです。管理画面と利用者画面は Node.js API と PostgreSQL を共用します。Android ネイティブアプリのソースは含みません。

## プロジェクト構成

```text
anshin-anpi/
├─ anshin-anpi-admin-source/   Web フロントエンド（React / vinext / Vite）
│  ├─ app/                    利用者画面と管理画面
│  ├─ components/             管理画面と共通 UI 部品
│  ├─ lib/                    API クライアントと画面遷移
│  ├─ build/                  API プロキシとビルド用コード
│  ├─ public/                 静的ファイル
│  ├─ scripts/                ビルド・依存関係のインストール補助
│  └─ worker/                 Cloudflare 用の実行入口
├─ backend/
│  ├─ src/                    API、認証、顔認識、メール送信・退信監視
│  ├─ config/                 同意文面の初期値
│  └─ scripts/                管理者初期設定、退信接続確認
├─ database/migrations/       初期構築・更新に必要な SQL
├─ deploy/vps/                VPS 用 Nginx 設定、環境変数の雛形、更新処理
├─ scripts/                   Windows 用の起動・DB 更新・配布準備
├─ compose.yaml              ローカル DB・API
├─ compose.aws-local.yaml    ローカル AWS 認証を API コンテナーへ接続
├─ compose.production.yaml   VPS の DB・API・管理画面
└─ .env.example              ローカル環境変数の雛形
```

`build/` は実行に必要なソースコードです。`dist/` は生成物です。`node_modules/`、環境変数、データベースのデータはソースコードと別に管理します。構築・運用のため、設定ファイルと `database/migrations/` は保持します。

## ローカル起動

Node.js 22.13.0 以上、npm、Docker Desktop（Linux コンテナー）を使用します。顔認証には AWS Rekognition、メール送信には SMTP の接続設定が必要です。

### 1. 環境変数と依存関係

プロジェクトルートで PowerShell を開きます。初回のみ雛形をコピーし、パスワードと接続先を設定します。既存の `.env` は上書きしないでください。

```powershell
Copy-Item .env.example .env
Copy-Item anshin-anpi-admin-source/.env.example anshin-anpi-admin-source/.env.local
cd backend
npm ci
cd ../anshin-anpi-admin-source
npm ci
cd ..
.\scripts\backend.ps1 -Action setup
```

ルートの `.env` に `POSTGRES_PASSWORD`、`API_PORT=3002`、SMTP、AWS の接続情報を設定します。暗号化・監査用の未設定キーは `setup` が生成します。フロントエンドの `.env.local` は次の接続先に合わせます。

```dotenv
ANSHIN_DEV_FACE_ENABLED=true
ANSHIN_BACKEND_URL=http://127.0.0.1:3002
```

現在のローカル構成は API が `3002`、PostgreSQL が `5433` です。ポートを変更する場合は API とフロントエンドの接続先をそろえます。AWS は認証済みの `AWS_PROFILE` を指定し、`AWS_REGION`、`AWS_REKOGNITION_COLLECTION_ID` などを設定します。

### 2. DB・API と管理画面

```powershell
# プロジェクトルート：PostgreSQL 起動、SQL 適用、API イメージの再構築
.\scripts\backend.ps1 -Action start
.\scripts\backend.ps1 -Action status

# フロントエンド
cd anshin-anpi-admin-source
npm run dev -- --host 127.0.0.1 --port 5173
```

- 管理画面：`http://127.0.0.1:5173/admin`
- 利用者画面：`http://127.0.0.1:5173/`
- API 準備状況：`http://127.0.0.1:3002/health/ready`
- API 定義：`http://127.0.0.1:3002/openapi.json`

`AWS_PROFILE` を使う場合、起動スクリプトが `compose.aws-local.yaml` を併用します。API の再作成にも同じスクリプトを使い、AWS 認証設定のマウントを維持してください。API を直接 Node.js で動かす場合は PostgreSQL と SQL を準備してから `backend` で `npm start` を実行し、同じポートの Docker API は停止します。

### 3. 管理者の初期設定

新しい DB の初期設定後に実行します。既存アカウントは上書きしません。

```powershell
cd backend
npm run provision:admin
```

初期メールアドレスは `admin@anshin-anpi.jp` です。生成されたパスワードはローカルの `backend/.admin-setup.json` に保存されます。保管後にこの初期設定ファイルを削除してください。パスワードを紛失した場合は、サーバーの操作権限がある環境で `npm run provision:admin -- --reset` を実行します。リセット後は旧セッションが失効します。

## サーバー構成

運用先は `https://anshin.info`、配布スクリプトの接続先は `debian@133.167.82.242` です。VPS では Nginx が HTTPS を受け、Docker Compose の各サービスへ転送します。

| 接続先・サービス | 役割 |
|---|---|
| Nginx `80 / 443` | HTTP から HTTPS への転送、TLS 終端、リバースプロキシ |
| `admin`：`127.0.0.1:3000` | 管理画面 |
| `api`：`127.0.0.1:3001` | 管理 API、利用者 API、顔認証、メール処理 |
| `postgres`：Compose 内部 `5432` | 業務データ、管理設定、監査記録 |

Nginx 設定は `deploy/vps/anshin.info.conf` です。`/api/admin/` は API の `/v1/admin/`、`/v1/` と `/health/` は API、その他は管理画面へ転送します。サイトの `/` は `/admin` へ移動します。

運用時の環境変数は `/home/debian/.config/anshin-anpi/runtime.env`、リリースの配置先は `/home/debian/anshin-anpi/releases/` です。秘密情報はリポジトリや配布イメージに含めず、環境変数ファイルの権限を `600` にします。本番のデータ暗号化は AWS KMS を使用します。`TEMPORARY_ENCRYPTION_KEY` と `AUDIT_HMAC_KEY` も継続して保持します。

配布パッケージはプロジェクトルートで作成します。

```powershell
.\scripts\package-vps.ps1 -Tag 20261015-update
```

`deploy/releases/` に API・管理画面の Docker イメージ、SQL、設定の雛形、圧縮パッケージと SHA-256 検証ファイルを生成します。既存サーバーへ反映する前に DB をバックアップし、未適用の SQL を順番に適用します。アプリの更新処理は `deploy/vps/update-app.sh` にあります。メールエラーの確認済み機能には `011_mail_error_acknowledgement.sql` が必要です。ローカルの配布パッケージを削除しても、稼働中の VPS や Docker のデータボリュームは削除されません。

## メールサーバーと退信監視

送信元は `anshin@anshin.info`、接続先はさくらのメールサーバーです。パスワードは私有環境変数または AWS Secrets Manager で管理します。

| 項目 | 設定 |
|---|---|
| SMTP ホスト | `miteken.sakura.ne.jp` |
| SMTP ポート・暗号化 | `587`、STARTTLS 必須、`SMTP_SECURE=false` |
| SMTP 認証 | `SMTP_USER` / `SMTP_PASSWORD` |
| 送信元 | `SMTP_FROM_EMAIL=anshin@anshin.info` |
| 退信取得 | IMAP over TLS、ポート `993`、既定のフォルダー `INBOX` |
| 監視間隔 | 既定 `60` 秒 |

```dotenv
MAIL_WORKER_ENABLED=true
MAIL_BOUNCE_ENABLED=true
MAIL_BOUNCE_IMAP_HOST=miteken.sakura.ne.jp
MAIL_BOUNCE_IMAP_PORT=993
MAIL_BOUNCE_IMAP_MAILBOX=INBOX
MAIL_BOUNCE_POLL_SECONDS=60
MAIL_BOUNCE_LOOKBACK_DAYS=7
```

IMAP のホスト・ユーザーが未設定の場合は SMTP 設定を再利用します。`MAIL_BOUNCE_IMAP_PASSWORD` を省略すると `SMTP_PASSWORD` を使用します。送信元への退信が実際に届くメールボックスを指定してください。監視は読み取り専用で、メールの既読状態の変更・移動・削除は行いません。

退信の種類は実際のメールヘッダーで判定します。メールサーバーの構造情報が普通のテキストとして返る場合も、正しい退信を処理します。判定方式の更新後は設定した期間（既定 7 日間）を再走査し、既に記録した退信は重複計上しません。

`backend` で `npm run check:mail-bounces` を実行すると IMAP の接続と読み取り専用アクセスを確認できます。`npm run poll:mail-bounces` は一度だけ走査し、対応する配信結果を更新します。どちらもメールを送信しません。通常は API 起動時に監視を開始します。設定変更後は API を再起動し、Docker 環境ではイメージを再構築します。

SMTP の受付は最終配信完了を意味しません。後から届く恒久エラーの退信を、元の Message-ID または配信 ID と宛先に照合して `bounced` として記録します。退信到着までの時間は受信側に依存し、退信がないことだけで配信成功・メールボックスの実在・既読は判定できません。

管理ホームの「メール送信エラー」は未確認の `failed / unknown / bounced` を新しい順に最大 5 件表示します。未解決件数は未確認の全件です。「確認済みにする」で一覧から除外し、配信履歴と診断情報を保持します。同じ退信の再受信では再表示せず、別の送信で発生した新しいエラーは表示します。この操作だけでは宛先修正や再送を行いません。

## データ管理と保守

業務テーブルは `users`、`face_templates`、`recipients`、`consents`、`safety_checks`、`mail_deliveries`、`audit_logs`、`terminals` です。管理者・管理設定・SQL の適用履歴は `app_meta` に保存します。個人情報と顔認証の参照情報は暗号化し、管理画面用の小さな顔サムネイルを除き、元の撮影画像は DB に保存しません。

```powershell
# プロジェクトルート
.\scripts\database.ps1 -Action migrate
.\scripts\database.ps1 -Action status
```

SQL はファイル名の順番で実行し、適用済みの版はスキップします。PostgreSQL の名前付きボリュームにデータを保持します。通常の停止には `docker compose stop` を使用します。DB を保持する場合は `docker compose down -v` を実行しないでください。既存の暗号化キーを作り直すと保存済みデータを読めなくなるため、環境変数と DB のバックアップを別途保管します。

API は単一プロセスで動作し、未完了の登録情報・顔認証セッション・管理者セッションは再起動時に失効します。メールの配信記録と確認済み状態は DB に保持します。メールワーカーは顔認証の外部参照削除や保存期間満了後の削除も行うため、通常は有効にします。

開発時の API ログは `API_DEBUG_LOG_ENABLED=true` で有効化し、`scripts/watch-api-log.ps1` で確認します。写真・認証情報は遮蔽し、管理リクエストと本番環境はこの詳細ログの対象外です。通常の運用確認には `/health/live`、`/health/ready` とコンテナーのログを使用します。API の項目と認証要件は `/openapi.json` を参照してください。

Windows での VPS 向けビルドは `anshin-anpi-admin-source` で `npm run build:vps` を実行します。`npm run build` と `npm run lint` の補助スクリプトには Bash 環境が必要です。第三者ライブラリの依存ファイルとライセンスは保持します。
