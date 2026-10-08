# 管理画面：単一の管理者とメールアドレス・パスワード認証

管理画面と利用者端末は、既存の Node.js バックエンドと PostgreSQL の 8 つの業務テーブルを共用します。管理設定用の補助テーブルは `app_meta.administrator`（データベース制約により 1 行だけを許可）と `app_meta.admin_settings` の 2 つです。ロール管理、独立したデータベース、Redis は追加しません。

## 初期設定済みのローカルアカウント

- メールアドレス：`admin@anshin-anpi.jp`
- 名前：`安心施設 管理者`
- 初期のランダムなパスワードは Git の対象外の `backend/.admin-setup.json` に保存します。初期設定ツールは認証情報をログに出力しません。
- メールアドレスとパスワードでログインします。パスワード管理ツールに保存した後、初期設定ファイルを削除してください。プロジェクト所有者の最新の指定により、多要素認証は使用しません。元の XLSX 仕様書は変更しません。

新しい環境ではデータベースのマイグレーションを適用してから `npm run provision:admin` を実行します。既存のアカウントは上書きしません。パスワードを紛失した場合は、サーバーへのアクセス権があるローカル端末で `npm run provision:admin -- --reset` を実行してください。新しいパスワードを生成し、すべての旧セッションを失効させ、監査記録に残します。インターネット経由のパスワード復旧 API は提供しません。

## 起動と接続

`backend` で `npm start` を実行します。ローカルの管理画面は `anshin-anpi-admin-source` で `npm run dev` を実行してから `/admin` を開きます。フロントエンドの `ANSHIN_BACKEND_URL` の既定値は `http://127.0.0.1:3002` で、実際の API の待受アドレスと一致させる必要があります。既存のルートの `.env` は引き続き使用できます。データベースの更新には `scripts/database.ps1 -Action migrate` を使用します。

ブラウザは同一オリジンの `/api/admin/*` にアクセスし、プロキシがバックエンドの `/v1/admin/*` に転送します。開発用プロキシはローカルアドレスだけを許可します。バックエンドの `CORS_ORIGINS` には実際のフロントエンドの Origin（ポートを含む）を指定してください。ビルド済みの Cloudflare Worker は環境バインディング `ANSHIN_BACKEND_URL` に対応します。本番環境ではアクセス可能な HTTPS のバックエンドアドレスを指定し、サイトの Origin をバックエンドの `CORS_ORIGINS` に追加します。現在の仮公開サイトにはこれらの変更をまだ公開しておらず、本番用バックエンドも設定していません。

セッションは単一のバックエンドプロセス内に暗号化して保存し、再起動後は再ログインが必要です。Cookie は HttpOnly、SameSite=Strict とし、本番モードでは Secure も付けます。無操作 15 分で失効し、全体の有効期限は最長 8 時間です。パスワードにはランダムなソルト付き scrypt を使用します。ログインに連続 5 回失敗すると 5 分間ロックします。ロック状態はデータベースに保存するため、再起動しても解除されません。管理要求はローカルの生の要求ログに記録しません。

## API

`POST /login` の要求は `{email,password}`、応答は `{admin,csrf_token}` で、Cookie を設定します。`GET /session` ではページの再読み込み後にセッションと CSRF トークンを取得できます。以下のパスはすべて `/v1/admin` で始まります。ログイン以外は管理者 Cookie が必須です。ログイン以外の書き込み操作には `X-CSRF-Token` と `Idempotency-Key` も必要です。フロントエンドの同一オリジンのパス `/api/admin` は、バックエンドの `/v1/admin` に一対一で対応します。現在のローカルアドレスはフロントエンドが `http://127.0.0.1:5173`、バックエンドが `http://127.0.0.1:3002` です。

| API | 用途 |
|---|---|
| POST `/login` | メールアドレスとパスワードによるログイン、セッション作成 |
| GET `/session` | 管理者情報と CSRF トークンの取得 |
| POST `/logout` | セッションの失効と Cookie の消去 |
| PUT `/profile` | 名前、メールアドレス、パスワードの変更。現在のパスワードを再確認し、保存後にすべてのセッションを失効させる |
| GET `/dashboard` | 実際の登録者数、連絡先数、東京時間の当日統計、メールエラー、直近の操作 |
| GET `/users?limit=200&offset=0` | 登録者と連絡先をページ単位で取得。写真や顔の特徴量は返さない |
| POST `/users/search` | 氏名の完全一致検索。用途 reason の記録が必須 |
| PUT `/users/{id}` | 氏名と連絡先の変更、利用停止。本人確認とデータの版の確認を行う |
| DELETE `/users/{id}` | 単一の管理者による削除申請を記録し、利用停止、氏名・メールアドレス・配信スナップショットの消去を行う。監査証跡は保持する |
| DELETE `/users/{id}/recipients/{recipientId}` | 連絡先の削除。最後の有効な連絡先を削除すると利用者を自動で利用停止にする |
| POST `/users/{id}/face` | 利用停止中の利用者を本人立会いと同意の下で再登録し、利用を再開する |
| POST `/users/{id}/consent` | 本人立会いで最新の登録文面を確認し、新しい同意履歴を記録する |
| GET `/settings` | 現在のメールテンプレート、利用者向け個人情報取扱文面、過去の版 |
| PUT `/mail-template` | 安否確認メールの件名と本文を保存する。既存の送信ワーカーが随時読み取る |
| POST `/policies/registration` | 新しい版と適用日を保存し、旧版は上書きしない。東京の日付に基づき自動で適用する |

フィールドと検証規則は、現在のコードから仕様を生成するオンラインの `GET /openapi.json` を正とします。用途は `support/correction/suspension/deletion/audit` だけを許可し、氏名や自由記述の備考は監査記録に含めません。管理者の操作と、認証済みでも拒否された操作は既存の HMAC 監査チェーンに記録します。管理画面には操作記録のサイドバーや検索 API は設けません。

### 要求パラメーターと応答

要求本文は JSON です。下表で任意と明記した項目以外は必須です。パスの `id` と `recipientId` は UUID です。`expected_revision` には対象の記録を取得した際の `revision` をそのまま指定してください。

| メソッドとパス | パラメーター | 主な応答 |
|---|---|---|
| POST `/login` | `email`, `password` | `admin`, `csrf_token`。`anshin_admin` Cookie を設定 |
| GET `/session` | なし | `admin`, `csrf_token` |
| POST `/logout` | `{}` | `logged_out: true`。Cookie を消去 |
| PUT `/profile` | `name`, `email`, `current_password`。任意：`new_password`（12～128 文字） | `admin`, `reauthenticate: true`。すべての旧セッションを失効 |
| GET `/dashboard` | なし | `counts`, `errors`, `activities` |
| GET `/users` | 任意のクエリ：`limit`（1～200、既定値 100）, `offset`（0～100000、既定値 0） | `users`, `total`, `offset`, `limit` |
| POST `/users/search` | `name`, `reason`。氏名全体で検索 | `users`, `total`, `offset`, `limit` |
| PUT `/users/{id}` | `name`, `status`, `recipients`, `expected_revision`, `identity_confirmed: true`, `reason`。任意：`reset_face`（既定値 false） | `user` |
| DELETE `/users/{id}` | `expected_revision`, `reason: "deletion"` | `deleted: true` |
| DELETE `/users/{id}/recipients/{recipientId}` | `expected_revision`, `reason: "deletion"` | `user` |
| POST `/users/{id}/face` | `image_base64`, `expected_revision`, `owner_present: true`, `consent_granted: true`, `policy_version` | `user`, `liveness_passed: false` |
| POST `/users/{id}/consent` | `expected_revision`, `owner_present: true`, `consent_granted: true`, `policy_version` | `user` |
| GET `/settings` | なし | `mail`, `policies`, `history` |
| PUT `/mail-template` | `subject`, `body`, `expected_revision` | `saved: true` |
| POST `/policies/registration` | `policy_version`, `body`, `effective_date`（YYYY-MM-DD） | `published: true`, `effective_date` |

登録者の `status` は `active/suspended/pending_registration` を許可します。`recipients` は 1～2 件の `{name,email,id?}` です。既存の連絡先を保持する場合は `id` を付け、新規の連絡先には付けません。氏名は最大 50 文字で、連絡先のメールアドレスは重複できません。`reset_face: true` は利用者を利用停止にし、再開には顔の再登録 API が必要です。

管理者プロフィールは `name/email/last_login_at/last_login_ip` だけを返し、パスワードは返しません。各登録者は `id/name/status/faceStatus/registeredAt/updatedAt/revision/lastCheckAt/consentVersion/recipients` を返し、元の写真や顔の特徴量は返しません。

失敗時の応答は `{error:{code,message,request_id}}` です。検証エラーでは `details` を追加する場合があります。主なステータスは、400：入力が無効、401：パスワード不一致またはセッション失効、403：送信元または CSRF の検証失敗、404：記録なし、409：版の競合、429：一時的な制限、503：サービス利用不可です。ログイン画面では、API の未実装、接続不可、アカウント未設定を接続失敗として表示します。パスワード不一致はメールアドレスまたはパスワードの誤りとして表示し、制限やタイムアウトにも明確な案内を表示します。エラー領域はほかのエラーと同じ赤色のスタイルで表示し、自動でフォーカスします。ログイン処理中は送信ボタンを無効にします。

ログインで `Route POST:/v1/admin/login not found` が返る場合、フロントエンドはバックエンドに接続できていますが、バックエンドは管理者 API を読み込んでいない旧プロセスです。コード更新後にバックエンドを再起動してください。`/openapi.json` で `/v1/admin/login` の POST API の存在を確認できます。

## データの連携

- 連絡先の追加・変更・削除は、メールを送信せずに同一のデータベーストランザクションで保存します。連絡先の変更に SMTP の設定は不要です。
- 連絡先の変更時には旧宛先の送信待ちメールを取り消し、過去のメールアドレスのスナップショットを消去して、古い情報による送信を防ぎます。変更通知メールは送信しません。メールは登録通知と安否確認通知の 2 種類だけです。旧実装で作成されたその他の種類の送信待ちメールは、配信ワーカーが取り消します。
- 利用停止、削除、顔の再登録要求は、認証資格を直ちに失効させ、送信待ちメールを取り消します。利用停止後の再開には本人立会いで顔の再登録が必要です。失効済みのクラウド上の特徴量は復元しません。
- 顔の再登録では既存の写真による認証方式を使用し、画像品質と重複登録を確認します。生体検知に成功したとは扱いません。写真は要求の処理中のメモリ内だけで扱い、元の画像は保存しません。管理画面には共通の人物アイコンを使用します。
- 削除時は業務上の氏名、メールアドレス、配信スナップショットを直ちに消去します。AWS の特徴量は既存の削除ワーカーが削除します。30 日間が経過し、外部の特徴量の削除が成功した後に利用者の行を物理削除します。メールワーカーを有効にしておく必要があります。外部データの削除に失敗した場合は、再試行用の参照情報を保持します。
- 同意文面の公開には新しい版番号を使用し、過去の日付は許可しません。この管理画面で編集するのは利用者向けの個人情報取扱文面だけです。文面の種別、タイトル、再同意の強制の選択肢は設けません。新しい文面は既存の利用者に再同意を強制しません。設定 API で過去の版を保持し、利用者端末には適用日まで旧版を返します。
- 同時更新にはデータベースの行ロックと完全なタイムスタンプの `revision` を使用します。古い画面からの保存は `409 ADMIN_REVISION_CHANGED` を返します。管理操作の成功応答は暗号化して 15 分間キャッシュします。再起動後も版の確認とメールの一意制約により、変更通知の重複を防ぎます。

## 連携の確認

フロントエンドは `npm run lint` と `npm run build` でコードとビルドを確認できます。ローカルの `/admin` でログイン、情報の取得、設定の保存、ログアウトを確認します。バックエンドの `GET /health/ready` でデータベース接続、`GET /openapi.json` で現在の API 定義を確認します。利用者 API とロボットの連携については [Android 連携文書](FRONTEND_FACE_HANDOFF.md) を参照してください。

個人情報取扱文面は、プロジェクト所有者が提供した 6 段落の文章を `privacy-v1` として保存し、2026-10-06 から適用します。旧版と既存の同意記録は保持します。タイトルは本文の先頭行から取得します。保存 API は本文、版番号、適用日だけを受け付けます。安否確認メールの送信同意文面は、この管理画面では編集しません。
