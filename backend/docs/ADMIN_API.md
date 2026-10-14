# 管理画面：単一の管理者とメールアドレス・パスワード認証

管理画面と利用者端末は、既存の Node.js バックエンドと PostgreSQL の 8 つの業務テーブルを共用します。管理設定用の補助テーブルは `app_meta.administrator`（データベース制約により 1 行だけを許可）と `app_meta.admin_settings` の 2 つです。ロール管理、独立したデータベース、Redis は追加しません。

## 初期設定済みのローカルアカウント

- メールアドレス：`admin@anshin-anpi.jp`
- 名前：`安心施設 管理者`
- 初期のランダムなパスワードは Git の対象外の `backend/.admin-setup.json` に保存します。初期設定ツールは認証情報をログに出力しません。
- メールアドレスとパスワードでログインします。パスワード管理ツールに保存した後、初期設定ファイルを削除してください。プロジェクト所有者の最新の指定により、多要素認証は使用しません。管理者パスワードは入力必須ですが、長さ・文字種・組合せの制約は設けません。基本情報とパスワードは別のフォームで保存します。基本情報の保存はパスワード入力不要です。パスワード変更時は現在のパスワード確認と確認欄の一致を検証します。

新しい環境ではデータベースのマイグレーションを適用してから `npm run provision:admin` を実行します。既存のアカウントは上書きしません。パスワードを紛失した場合は、サーバーへのアクセス権があるローカル端末で `npm run provision:admin -- --reset` を実行してください。新しいパスワードを生成し、すべての旧セッションを失効させ、監査記録に残します。インターネット経由のパスワード復旧 API は提供しません。

## 起動と接続

`backend` で `npm start` を実行します。ローカルの管理画面は `anshin-anpi-admin-source` で `npm run dev` を実行してから `/admin` を開きます。フロントエンドの `ANSHIN_BACKEND_URL` の既定値は `http://127.0.0.1:3002` で、実際の API の待受アドレスと一致させる必要があります。既存のルートの `.env` は引き続き使用できます。データベースの更新には `scripts/database.ps1 -Action migrate` を使用します。

ブラウザは同一オリジンの `/api/admin/*` にアクセスし、プロキシがバックエンドの `/v1/admin/*` に転送します。開発用プロキシはローカルアドレスだけを許可します。バックエンドの `CORS_ORIGINS` には実際のフロントエンドの Origin（ポートを含む）を指定してください。ビルド済みの Cloudflare Worker は環境バインディング `ANSHIN_BACKEND_URL` に対応します。本番環境ではアクセス可能な HTTPS のバックエンドアドレスを指定し、サイトの Origin をバックエンドの `CORS_ORIGINS` に追加します。現在の仮公開サイトにはこれらの変更をまだ公開しておらず、本番用バックエンドも設定していません。

セッションは単一のバックエンドプロセス内に暗号化して保存し、再起動後は再ログインが必要です。Cookie は HttpOnly、SameSite=Strict とし、本番モードでは Secure も付けます。Cookie とセッションはログインから 24 時間で失効し、無操作による短時間の失効はありません。操作しても期限は延長しません。画面も応答の `expires_at` に従って期限切れ時にログイン画面へ戻ります。パスワードにはランダムなソルト付き scrypt を使用します。ログインに連続 5 回失敗すると 5 分間ロックします。ロック状態はデータベースに保存するため、再起動しても解除されません。管理要求はローカルの生の要求ログに記録しません。

## API

`POST /login` の要求は `{email,password}`、応答は `{admin,csrf_token,expires_at}` で、Cookie を設定します。`GET /session` ではページの再読み込み後にセッション、CSRF トークン、元のログインからの有効期限を取得できます。以下のパスはすべて `/v1/admin` で始まります。ログイン以外は管理者 Cookie が必須です。ログイン以外の書き込み操作には `X-CSRF-Token` と `Idempotency-Key` も必要です。フロントエンドの同一オリジンのパス `/api/admin` は、バックエンドの `/v1/admin` に一対一で対応します。現在のローカルアドレスはフロントエンドが `http://127.0.0.1:5173`、バックエンドが `http://127.0.0.1:3002` です。

| API | 用途 |
|---|---|
| POST `/login` | メールアドレスとパスワードによるログイン、セッション作成 |
| GET `/session` | 管理者情報と CSRF トークンの取得 |
| POST `/logout` | セッションの失効と Cookie の消去 |
| PUT `/profile` | 名前とメールアドレスのみ変更。現在のパスワードは不要で、保存後もログインを継続する |
| PUT `/password` | 現在のパスワードを確認し、新しいパスワードへ変更。保存後にすべての旧セッションを失効させる |
| GET `/dashboard` | 実際の登録者数、連絡先数、東京時間の当日統計、メールエラー、直近の操作 |
| GET `/users?limit=200&offset=0` | 登録者と連絡先をページ単位で取得。小さな顔サムネイルを含み、元の写真や顔の特徴量は返さない |
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
| POST `/login` | `email`, `password` | `admin`, `csrf_token`, `expires_at`。`anshin_admin` Cookie を設定 |
| GET `/session` | なし | `admin`, `csrf_token`, `expires_at` |
| POST `/logout` | `{}` | `logged_out: true`。Cookie を消去 |
| PUT `/profile` | `name`, `email` | `admin`, `reauthenticate: false`。パスワードとセッション有効期限は変更しない |
| PUT `/password` | `current_password`, `new_password`。いずれも入力必須、長さ・文字種・組合せの制約なし | `saved: true`, `reauthenticate: true`。すべての旧セッションを失効 |
| GET `/dashboard` | なし | `counts`, `errors`, `activities` |
| GET `/users` | 任意のクエリ：`limit`（1～200、既定値 100）, `offset`（0～100000、既定値 0） | `users`, `total`, `offset`, `limit` |
| POST `/users/search` | `name`, `reason`。氏名全体で検索 | `users`, `total`, `offset`, `limit` |
| PUT `/users/{id}` | `name`, `status`, `recipients`, `expected_revision`, `identity_confirmed: true`, `reason`。任意：`reset_face`（既定値 false） | `user`, `registration_mail_count`（追加・変更した宛先への登録確認メールの送信受付件数） |
| DELETE `/users/{id}` | `expected_revision`, `reason: "deletion"` | `deleted: true` |
| DELETE `/users/{id}/recipients/{recipientId}` | `expected_revision`, `reason: "deletion"` | `user` |
| POST `/users/{id}/face` | `image_base64`, `expected_revision`, `owner_present: true`, `consent_granted: true`, `policy_version` | `user`, `liveness_passed: false` |
| POST `/users/{id}/consent` | `expected_revision`, `owner_present: true`, `consent_granted: true`, `policy_version` | `user` |
| GET `/settings` | なし | `mail`, `policies`, `history` |
| PUT `/mail-template` | `subject`, `body`, `expected_revision` | `saved: true` |
| POST `/policies/registration` | `policy_version`, `body`, `effective_date`（YYYY-MM-DD） | `published: true`, `effective_date` |

登録者の `status` は `active/suspended/pending_registration` を許可します。`recipients` は 1～2 件の `{name,email,id?}` です。既存の連絡先を保持する場合は `id` を付け、新規の連絡先には付けません。氏名は最大 50 文字で、連絡先のメールアドレスは重複できません。`reset_face: true` は利用者を利用停止にし、再開には顔の再登録 API が必要です。

管理者プロフィールは `name/email/last_login_at/last_login_ip` だけを返し、パスワードは返しません。各登録者は `id/name/status/faceStatus/avatar/registeredAt/updatedAt/revision/lastCheckAt/consentVersion/recipients` を返し、元の写真や顔の特徴量は返しません。`avatar` は `data:image/jpeg;base64,...` 形式の 96×96 ピクセルのサムネイル、未保存の場合は `null` です。ホームの最近の登録者と登録者一覧に円形で表示し、クリック・拡大・詳細表示は提供しません。

サムネイルは新規登録の確定時または本人立会いの顔再登録時だけ作成し、`users.encrypted_avatar` に既存の暗号化方式で保存します。既存利用者への補完や安否確認時の撮影による更新は行いません。元画像と画像メタデータは保存しません。サムネイルは登録継続中に保持し、通常の利用停止時は保持します。顔再登録要求時は旧画像を消去し、再登録成功時に新しい画像を保存します。登録削除または登録同意の撤回時には DB トリガーで即時消去します。バックアップ内の暗号化データは既存のバックアップ保管・ローテーションの対象です。画像専用の公開 URL や API は追加せず、認証済みの管理 API の応答にのみ含めます。管理 API の応答は `Cache-Control: no-store` です。

ダッシュボードの `activities` は直近 5 件の `{id,action,occurred_at,user_name,policy_version}` を返します。氏名は現在の登録者情報から取得し、削除済みの場合は `null` です。版番号は文面公開時の監査対象から取得します。画面はイベントコードを日本語の操作説明に変換し、その下に東京時間を基準とした相対時刻を表示します。送信先だけの変更は `admin.recipient.updated`、利用停止は `admin.user.suspended`、利用再開は `admin.user.resumed` として記録し、従来の `admin.user.updated` は登録者情報の更新として表示します。

管理者がログを閲覧できるのはホームの直近 5 件だけです。ログの検索・絞り込み・全件閲覧・詳細閲覧・エクスポート・変更・削除を行う画面や専用 API は提供しません。システム側の監査記録・保存期間・機微情報の遮蔽・改ざん検知は継続し、保存期間満了時の自動削除または匿名化は管理者の操作とは分離します。

失敗時の応答は `{error:{code,message,request_id}}` です。検証エラーでは `details` を追加する場合があります。主なステータスは、400：入力が無効、401：パスワード不一致またはセッション失効、403：送信元または CSRF の検証失敗、404：記録なし、409：版の競合、429：一時的な制限、503：サービス利用不可です。ログイン画面では、API の未実装、接続不可、アカウント未設定を接続失敗として表示します。パスワード不一致はメールアドレスまたはパスワードの誤りとして表示し、制限やタイムアウトにも明確な案内を表示します。エラー領域はほかのエラーと同じ赤色のスタイルで表示し、自動でフォーカスします。ログイン処理中は送信ボタンを無効にします。

ログインで `Route POST:/v1/admin/login not found` が返る場合、フロントエンドはバックエンドに接続できていますが、バックエンドは管理者 API を読み込んでいない旧プロセスです。コード更新後にバックエンドを再起動してください。`/openapi.json` で `/v1/admin/login` の POST API の存在を確認できます。

## データの連携

- 管理者が連絡先のメールアドレスを追加・変更すると、新しい宛先だけに登録確認メールを自動送信します。登録確認メールと同じ件名・本文を使用し、日時には今回の追加・変更日時を使用します。氏名だけの変更、宛先の並べ替え、変更のない保存、削除では送信しません。
- 保存と送信要求は同一のデータベーストランザクションで確定し、SMTP 未設定時は追加・変更を保存せずエラーを返します。送信は既存のワーカーが非同期に実行し、送信受付件数は宛先への到着を保証しません。`contact_change` は初回登録の完了や利用再開には使用しません。利用停止中の連絡先追加・変更でもこの通知は送り、安否確認の送信は再開しません。
- 連絡先の変更時には旧宛先の送信待ちメールを取り消し、過去のメールアドレスのスナップショットを消去して、古い情報による送信を防ぎます。通知対象は追加・変更した新しい宛先のみです。メール文面は登録通知と安否確認通知の 2 種類です。
- 利用停止、削除、顔の再登録要求は、認証資格を直ちに失効させ、送信待ちメールを取り消します。利用停止後の再開には本人立会いで顔の再登録が必要です。失効済みのクラウド上の特徴量は復元しません。
- 顔の再登録では既存の写真による認証方式を使用し、画像品質と重複登録を確認します。生体検知に成功したとは扱いません。写真は要求の処理中のメモリ内だけで扱い、元の画像は保存しません。管理画面には共通の人物アイコンを使用します。
- 削除時は業務上の氏名、メールアドレス、配信スナップショットを直ちに消去します。AWS の特徴量は既存の削除ワーカーが削除します。30 日間が経過し、外部の特徴量の削除が成功した後に利用者の行を物理削除します。メールワーカーを有効にしておく必要があります。外部データの削除に失敗した場合は、再試行用の参照情報を保持します。
- 同意文面の公開には新しい版番号を使用し、過去の日付は許可しません。この管理画面で編集するのは利用者向けの個人情報取扱文面だけです。文面の種別、タイトル、再同意の強制の選択肢は設けません。新しい文面は既存の利用者に再同意を強制しません。設定 API で過去の版を保持し、利用者端末には適用日まで旧版を返します。
- 同時更新にはデータベースの行ロックと完全なタイムスタンプの `revision` を使用します。古い画面からの保存は `409 ADMIN_REVISION_CHANGED` を返します。管理操作の成功応答は暗号化して 15 分間キャッシュします。再起動後も版の確認とメールの一意制約により、変更通知の重複を防ぎます。

## 連携の確認

フロントエンドは `npm run lint` と `npm run build` でコードとビルドを確認できます。ローカルの `/admin` でログイン、情報の取得、設定の保存、ログアウトを確認します。バックエンドの `GET /health/ready` でデータベース接続、`GET /openapi.json` で現在の API 定義を確認します。利用者 API とロボットの連携については [Android 連携文書](FRONTEND_FACE_HANDOFF.md) を参照してください。

個人情報取扱文面は、プロジェクト所有者が提供した 6 段落の文章を `privacy-v1` として保存し、2026-10-06 から適用します。旧版と既存の同意記録は保持します。タイトルは本文の先頭行から取得します。保存 API は本文、版番号、適用日だけを受け付けます。安否確認メールの送信同意文面は、この管理画面では編集しません。
