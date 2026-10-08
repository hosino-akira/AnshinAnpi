# 安心安否確認システム ソースコード・ファイル説明書

## 構成と利用方法

このプロジェクトは、Androidロボットから呼び出すNode.jsバックエンド、PCブラウザ向け管理画面、ブラウザでの利用者画面確認・顔認識テストを含みます。Androidネイティブアプリのソースは含みません。

管理画面は実APIとPostgreSQLに接続しています。利用者Web画面と顔認識テスト画面は、開発用の同一オリジンプロキシ経由で実APIを呼び出します。

| 資料 | 内容 |
|---|---|
| [Android連携文書](../../backend/docs/FRONTEND_FACE_HANDOFF.md) | 登録・顔認識・本人確認・通知のAPI順序 |
| [管理画面API](../../backend/docs/ADMIN_API.md) | 管理者の初期設定、ログイン、利用者・文面管理 |
| [データベース説明](../../database/README.md) | 業務テーブル、起動、初期化、保存期間 |
| [開発仕様書](specs/安心安否確認システム_開発仕様書_v1.0_正式版.xlsx) | 原本の業務・データ仕様 |
| [画面遷移仕様書](specs/安心安否確認システム_画面遷移仕様書_v1.0_正式版.xlsx) | 原本の画面遷移仕様 |

## 起動と確認

Node.js 22.13.0以上を使用します。PostgreSQLを起動・初期化した後、backendでnpm startを実行します。新環境の管理者初期設定はnpm run provision:adminを使用します。

anshin-anpi-admin-sourceでnpm run devを実行し、/adminで管理画面、/で利用者画面を開きます。開発用の顔認識確認ページは/dev/faceです。

管理画面の入口 `/admin` は `/admin/dashboard` へ転送します。未ログインの場合は `/admin/login` へ移動し、ログイン後は開こうとしていた画面へ戻ります。画面URLは `lib/admin-navigation.ts` に定義します。これらは表示する画面のアドレスで、管理APIの `/api/admin/...` とは別です。

| 管理画面 | URL |
|---|---|
| ログイン | /admin/login |
| 管理状況 | /admin/dashboard |
| 登録者管理 | /admin/users |
| メール送信先管理 | /admin/recipients |
| 送信メール編集 | /admin/mail-template |
| 個人情報取扱文面 | /admin/privacy |
| 管理者情報 | /admin/profile |

ブラウザの利用者API接続には.env.localでANSHIN_DEV_FACE_ENABLED=trueを指定し、ANSHIN_BACKEND_URLを実際のバックエンドアドレスに合わせます。既定値はhttp://127.0.0.1:3002です。Androidはバックエンドの/v1/...に直接接続します。

npm run lintは静的検査、npm run buildは本番ビルドです。ビルド・インストール補助コマンドにはBash環境が必要です。APIのGET /health/readyは接続確認、GET /openapi.jsonは現在のAPI仕様を返します。

## アプリケーションのファイル

| ファイル | 役割 |
|---|---|
| app/page.tsx | 利用者画面SCR-00～SCR-14、画面遷移、カメラ、入力、タイマー |
| app/globals.css | 全体配色、利用者画面と共通UIのスタイル |
| app/layout.tsx | HTML、言語、タイトル、favicon、viewport |
| app/admin/page.tsx | 管理画面の入口から管理状況への転送 |
| app/admin/[section]/page.tsx | 管理ページのURL検証、未知のURLは404 |
| components/admin/admin-console.tsx | ログインと各管理画面、URLに応じた表示と認証状態の維持 |
| app/admin/admin.css | 管理画面の専用スタイル |
| app/admin/layout.tsx | 管理画面のタイトル、viewportと共通画面のレイアウト |
| app/dev/face/page.tsx | 写真を使う登録・顔認識APIの開発用確認画面 |
| app/dev/face/face.css | 顔認識確認画面のスタイル |
| lib/face-client.ts | ブラウザ利用者APIの入出力と呼び出し |
| lib/face-api.ts | 利用者APIのHTTP処理、操作番号、エラー処理 |
| lib/admin-api.ts | 管理APIのHTTP処理、Cookie、CSRF、エラー処理 |
| lib/admin-navigation.ts | 管理ページのURL、ログイン後の遷移先の検証 |
| lib/utils.ts | UI部品のclass名をまとめる共通処理 |
| hooks/use-mobile.ts | sidebar部品が利用する画面幅判定 |
| build/local-terminal-proxy.mjs | 開発時の/api/terminal/...をローカルバックエンドへ転送 |
| build/admin-proxy.mjs | /api/admin/...の管理API転送 |
| build/admin-proxy.d.mts | 管理API転送モジュールの型定義 |
| public/favicon.svg | ブラウザのアイコン |
| public/registered-user-faces.png | 保持している旧サンプル顔画像 |

## 利用者画面とタイマー

app/page.tsxのrenderScreen()が各画面を表示します。SCR-00はホーム、SCR-01は利用方法選択、SCR-02～SCR-09は登録、SCR-10～SCR-14は安否確認です。ScreenId、INITIAL_STEPS、REPEAT_STEPSが画面と進捗を定義します。

Web画面は無操作60秒で警告し、その後30秒で情報を消去してホームへ戻ります。完了画面は10秒で終了します。ホーム・完了画面・API処理中は通常の無操作監視の対象外です。

バックエンドの登録途中の情報と顔認識セッションは別に管理され、無操作5分・総有効期間15分です。Androidの画面タイマーと警告ダイアログはAndroidアプリ側で実装します。

本人確認の「ちがいます」はconfirmed=falseで連絡先確認APIを呼び、成功後に画面の個人情報を消去します。通知受付成功はバックエンドへの依頼受付を意味し、利用者端末は配信結果をポーリングしません。

## UI部品

components/ui/の61ファイルはすべて保持しています。現在のページから使う部品はalert-dialog、button、checkbox、input、label、progress、select、sheet、table、textareaです。それ以外は予備部品で、sidebarはhooks/use-mobile.tsに依存します。

| ファイル | 提供するUI |
| --- | --- |
| `accordion.tsx` | 開閉式の説明領域 |
| `alert-dialog.tsx` | 重要な確認ダイアログ。中止・タイムアウトで使用 |
| `alert.tsx` | ページ内の通知・警告 |
| `aspect-ratio.tsx` | 画像・動画の縦横比固定 |
| `attachment.tsx` | 添付ファイル表示 |
| `avatar.tsx` | 利用者アイコン・画像 |
| `badge.tsx` | 状態や区分の短いラベル |
| `breadcrumb.tsx` | 階層ナビゲーション |
| `bubble.tsx` | 会話・案内用の吹き出し |
| `button-group.tsx` | 複数ボタンのグループ |
| `button.tsx` | 共通ボタン。各画面で使用 |
| `calendar.tsx` | 日付選択カレンダー |
| `card.tsx` | 情報をまとめるカード |
| `carousel.tsx` | 横送りコンテンツ |
| `chart.tsx` | グラフ表示の共通ラッパー |
| `checkbox.tsx` | 同意チェック。SCR-04・SCR-13で使用 |
| `collapsible.tsx` | 開閉可能なコンテンツ |
| `combobox.tsx` | 入力検索付き選択欄 |
| `command.tsx` | コマンド検索・候補一覧 |
| `context-menu.tsx` | 右クリック／長押しメニュー |
| `dialog.tsx` | 一般的なモーダルダイアログ |
| `direction.tsx` | 文字方向の制御 |
| `drawer.tsx` | 画面端から開くパネル |
| `dropdown-menu.tsx` | ドロップダウンメニュー |
| `empty.tsx` | データがない状態の表示 |
| `field.tsx` | フォーム項目の構造化 |
| `form.tsx` | React Hook Form連携部品 |
| `hover-card.tsx` | ポインター時の補足カード |
| `input-group.tsx` | アイコン等を含む入力欄 |
| `input-otp.tsx` | ワンタイムコード入力 |
| `input.tsx` | テキスト入力。氏名・メールで使用 |
| `item.tsx` | リスト項目の共通表示 |
| `kbd.tsx` | キーボードキー表記 |
| `label.tsx` | 入力欄ラベル。各フォームで使用 |
| `marker.tsx` | 位置や注目点のマーカー |
| `menubar.tsx` | デスクトップ型メニューバー |
| `message-scroller.tsx` | メッセージ一覧のスクロール制御 |
| `message.tsx` | メッセージ表示 |
| `native-select.tsx` | OS標準の選択欄 |
| `navigation-menu.tsx` | 階層ナビゲーションメニュー |
| `pagination.tsx` | ページ送り |
| `popover.tsx` | 要素付近に表示する小パネル |
| `progress.tsx` | 進捗バー。手続き進捗等で使用 |
| `radio-group.tsx` | 単一選択のラジオボタン群 |
| `resizable.tsx` | サイズ変更可能な領域 |
| `scroll-area.tsx` | スクロール領域 |
| `select.tsx` | カスタム選択欄 |
| `separator.tsx` | 区切り線 |
| `sheet.tsx` | 画面端から開く補助画面 |
| `sidebar.tsx` | サイドナビゲーション |
| `skeleton.tsx` | 読み込み中のプレースホルダー |
| `slider.tsx` | 数値を選択するスライダー |
| `sonner.tsx` | トースト通知の表示器 |
| `spinner.tsx` | 読み込み中アイコン |
| `switch.tsx` | ON／OFF切替 |
| `table.tsx` | 表形式データ |
| `tabs.tsx` | タブ切替 |
| `textarea.tsx` | 複数行入力 |
| `toggle-group.tsx` | 複数の切替ボタン |
| `toggle.tsx` | 単体の切替ボタン |
| `tooltip.tsx` | 短い補足説明 |

未使用部品を削除する場合は、先に `rg "@/components/ui/部品名"` で参照がないことを確認してください。`components/ui/` は外部由来の共通部品なので、プロジェクト固有の仕様変更は原則として `app/` または新設する `features/` 側で行います。

## ビルドと設定のファイル

| ファイル | 役割 |
|---|---|
| package.json / package-lock.json | 実行コマンドと依存関係の固定 |
| vite.config.ts | Vite、vinext、Cloudflare、ローカルAPIプロキシの設定 |
| next.config.ts | Next互換のアプリ設定 |
| tsconfig.json | TypeScriptの型検査とパス設定 |
| vite-env.d.ts / worker-env.d.ts | ViteとCloudflareの型定義 |
| eslint.config.mjs | 静的検査の設定 |
| postcss.config.mjs | CSS処理の設定 |
| worker/index.ts | Cloudflare Worker、画像処理、管理API転送の入口 |
| build/sites-vite-plugin.ts | ビルド結果へのホスティング情報の同梱 |
| scripts/install-ci.sh | 依存関係のインストール補助 |
| scripts/build-verified.sh | 制限時間付きの本番ビルド |
| scripts/sites-env.sh | ビルド用のローカル環境とキャッシュ設定 |
| .openai/hosting.json | ホスティング先とバインディング設定 |
| vendor/shadcn-tailwind-4.13.0.css | 共通UIの外部スタイル |
| vendor/shadcn-tailwind-4.13.0.LICENSE.md | 外部スタイルのライセンス |

## APIログ

バックエンドを開発モードで動かし、プロジェクトルートの.envにAPI_DEBUG_LOG_ENABLED=trueを指定します。設定変更時はバックエンドを再起動します。利用者側の/v1/...リクエストとレスポンスをbackend/logs/api-requests.jsonlに記録し、写真と認証情報は遮蔽します。管理リクエスト、メールコールバック、本番モードはこのログの対象外です。

プロジェクトルートでscripts/watch-api-log.ps1を実行すると、新しいリクエストをリアルタイム表示します。画面の操作後にmethod、path、request_body、status、response_bodyを確認します。

キャッシュやdistは再生成される作業データです。node_modulesは保持し、ビルド結果を配布するときはnpm run buildで生成します。
