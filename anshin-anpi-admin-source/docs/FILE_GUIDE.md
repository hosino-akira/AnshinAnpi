# 安心安否確認システム ソースコード・ファイル説明書

## 1. この文書の目的

この文書は、`安心安否確認システム_画面デザイン_コメント付きソースコード.zip` を引き継いだプログラマーが、構成を短時間で把握し、安全に2次開発を始めるためのガイドです。

対象はフロントエンドの画面デザイン実装です。Android搭載の13.3インチ・タッチ液晶を想定し、初回登録と2回目以降の安否確認を `SCR-00`〜`SCR-14` で実装しています。

> 重要：カメラ映像の取得は動作しますが、顔特徴の登録・顔照合・メール送信・永続データ保存は画面確認用の疑似処理です。本番化にはバックエンドAPIとセキュリティ設計が必要です。

## 2. 最初に確認する5ファイル

| 優先度 | ファイル | 役割 | 主な変更場面 |
| --- | --- | --- | --- |
| 1 | `app/page.tsx` | 全画面、画面遷移、入力検証、カメラ、タイマー | 機能追加、画面追加、API接続 |
| 2 | `app/globals.css` | 配色、文字、余白、タッチ領域、レスポンシブ | デザイン変更、実機調整 |
| 3 | `README.md` | 起動方法、画面一覧、本番化の注意 | 開発開始前の確認 |
| 4 | `docs/API_INTEGRATION.md` | 顔認証・メール・登録APIへの置換方針 | バックエンド連携 |
| 5 | `package.json` | 利用ライブラリと実行コマンド | 依存追加、ビルド設定 |

## 3. ディレクトリ構成

```text
安心安否確認システム/
├─ app/                 画面本体、スタイル、ページ設定
│  └─ admin/            PCブラウザ向け管理者画面
├─ components/ui/       再利用可能なUI部品
├─ docs/                2次開発向け資料
├─ public/              ブラウザへ公開する静的ファイル
├─ hooks/               React共通フック
├─ lib/                 共通ユーティリティ
├─ db/                  D1データベース接続とスキーマ
├─ drizzle/             DBマイグレーション管理情報
├─ examples/            D1利用例（本番コードではない）
├─ tests/               ビルド・UI部品のテスト
├─ worker/              Cloudflare Workerの入口
├─ build/               ホスティング用Viteプラグイン
├─ scripts/             インストール・ビルド補助
├─ vendor/              外部UIスタイルとライセンス
├─ .openai/             ホスティング設定
└─ 各種設定ファイル      TypeScript、ESLint、Vite等
```

## 4. アプリケーション固有ファイル

### `app/page.tsx`

利用者が操作する全画面を1つのReactクライアントコンポーネントとして実装しています。仕様書の画面IDを `switch` 文で明示しているため、仕様書とコードを照合しやすい構成です。

主なコード領域：

- `ScreenId`：利用可能な画面IDの型。画面追加時に更新します。
- `INITIAL_STEPS` / `REPEAT_STEPS`：上部進捗表示の順序です。
- `INACTIVITY_WARNING_MS` 等：無操作時間、完了画面時間、モック表示名をまとめた設定値です。
- `StatusHeader`：ブランド、通信状態、時刻、現在の画面IDを表示します。
- `StepRail`：初回登録または安否確認の進捗を表示します。
- `ScreenTitle` / `Notice` / `ActionBar`：全画面共通の見出し、通知、操作領域です。
- `CameraPanel`：`getUserMedia()` で前面カメラを取得し、画面を離れるとMediaStreamを停止します。
- `RecipientCard`：送信先の氏名、マスク済みメールアドレス、送信結果を表示します。
- `Home`：入力データ、同意状態、処理状態、タイマー、画面遷移を管理します。
- `runProcessing()`：顔認証やメール送信を模した疑似待機処理です。本番APIへ置き換える中心箇所です。
- `renderScreen()`：`SCR-00`〜`SCR-14` の画面本体です。

現在の実装は画面確認を優先した単一ファイル構成です。2次開発が大きくなる場合は、`screens/`、`features/camera/`、`features/recipients/`、`services/api/`、`types/` へ段階的に分割してください。

### `app/globals.css`

システム全体のデザインを管理します。冒頭の `:root` に配色変数があり、導入施設のブランド色へ変更できます。

主なコード領域：

- デザイントークン：ネイビー、ティール、オレンジ、文字色、背景色、枠線色
- 共通フレーム：固定ヘッダー、進捗、画面ステージ、下部アクションバー
- タッチ操作：主要ボタンを62px以上に設定
- 画面別スタイル：ホーム、カメラ、同意、連絡先、確認、完了
- オーバーレイ：処理中、中止確認、タイムアウト
- メディアクエリ：幅1100px以下、縦向き、低い横画面

実機調整では、文字サイズを先に小さくするのではなく、余白・列幅・折返しを調整し、タッチ領域と可読性を保ってください。

### `app/admin/page.tsx`

PCブラウザ向けの管理者画面を実装します。ログイン画面と、管理状況、登録者管理、メール送信先管理、送信メール編集、個人情報取扱文面、管理者情報の6表示を1つの画面状態で切り替えます。

- `INITIAL_ADMIN` / `handleLogin()`：デモ用管理者とログイン検証です。本番ではサーバー認証へ置き換えます。
- `INITIAL_USERS`：画面確認用の登録者と最大2件の送信先です。本番では登録者APIの応答へ置き換えます。
- `MAIL_ERRORS`：メール送信失敗の宛先・時刻・原因のサンプルです。本番では配信結果APIへ置き換えます。
- `openUserEditor()` / `saveUser()`：登録者と送信先の編集パネルを管理します。
- `confirmDelete()`：登録者または送信先を削除します。送信先が0件になった場合は利用停止へ変更します。
- `INITIAL_MAIL_SUBJECT` / `INITIAL_MAIL_BODY`：家族向けメールの初期タイトルと本文です。差し込み項目は `renderMailSample()` でプレビューできます。
- `saveMailTemplate()`：送信メールのタイトルと本文を検証・保存する処理の置換箇所です。
- `savePrivacy()`：個人情報取扱文面、版番号、適用開始日を保存する処理の置換箇所です。
- `saveAdminAccount()`：管理者名、メールアドレス、パスワードを変更します。
- `userTable()`：管理状況と登録者管理で共用する一覧です。

現在の変更はブラウザメモリ上だけに反映されます。`public/registered-user-faces.png` は5名分の架空人物を横一列に配置したサンプル顔写真です。本番では管理者認証、権限制御、サーバー側入力検証、監査ログ、顔画像ストレージ、登録者・送信先・文面版管理APIを接続してください。

### `app/admin/admin.css`

管理者画面専用のログイン、サイドメニュー、一覧表、送信エラー、顔写真、編集パネル、送信メールエディター、個人情報文面エディター、管理者情報、レスポンシブ表示を定義します。利用者画面と同じブランド配色を使いながら、PC向けの情報密度へ調整しています。

### `app/admin/layout.tsx`

管理者画面用のページタイトルと説明文、PCブラウザで拡大操作を許可するviewportを定義します。

### `app/layout.tsx`

HTML全体のレイアウトです。ページタイトル、説明文、favicon、viewport、言語 `ja` を指定しています。Android端末での拡大縮小や表示幅の方針を変える場合に編集します。

### `app/chatgpt-auth.ts`

ホスティング環境で任意に利用できるサインイン補助です。現在の安心安否確認画面からは使用していません。施設職員用の管理画面を追加し、利用者識別が必要になった場合に検討します。一般利用者の顔認証をこのファイルで代替するものではありません。

### `public/favicon.svg`

ブラウザタブやホーム画面で使用するアイコンです。SVGのため色や図形を直接編集できます。施設ロゴへ変更する場合は、`app/layout.tsx` のアイコン指定も確認してください。

## 5. 画面IDと修正箇所

| 画面ID | 機能 | 主な状態・処理 |
| --- | --- | --- |
| SCR-00 | ホーム | `setScreen("SCR-01")` で開始 |
| SCR-01 | 利用方法選択 | 初回はSCR-02、登録済みはSCR-10へ分岐 |
| SCR-02 | 初回顔撮影 | `CameraPanel`、顔登録APIへの置換候補 |
| SCR-03 | 氏名入力 | `name`、`nameValid`、最大50文字 |
| SCR-04 | 個人情報同意 | `privacyAgreed`、同意文面の法務確認が必要 |
| SCR-05 | 連絡先入力 | `recipients`、1名必須・最大2名、重複検証 |
| SCR-06 | 登録確認 | 入力内容の確認と登録確定処理 |
| SCR-07 | 登録顔照合 | `CameraPanel`、1対1照合APIへの置換候補 |
| SCR-08 | 確認メール結果 | 宛先別受付結果の表示 |
| SCR-09 | 登録完了 | `completeSeconds` 後に自動終了 |
| SCR-10 | 登録者の顔確認 | 1対N識別APIへの置換候補 |
| SCR-11 | 本人確認 | 現在は `MOCK_USER_NAME` を表示 |
| SCR-12 | 送信先確認 | 現在は `MOCK_RECIPIENTS` を表示 |
| SCR-13 | 送信同意 | `sendAgreed`、メール送信APIへの置換候補 |
| SCR-14 | 送信完了 | 宛先別結果と送信日時を表示 |

## 6. UI部品ファイル

`components/ui/` は shadcn 系の再利用可能なUI部品です。現在の画面で直接使用しているのは `alert-dialog.tsx`、`button.tsx`、`checkbox.tsx`、`input.tsx`、`label.tsx`、`progress.tsx` です。それ以外は2次開発で利用できる予備部品です。

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

## 7. 共通処理・設定ファイル

| ファイル | 説明 | 編集方針 |
| --- | --- | --- |
| `hooks/use-mobile.ts` | 画面幅からモバイル表示を判定するReactフック | 端末判定が必要な新画面で使用 |
| `lib/utils.ts` | CSSクラス名を結合する `cn()` | UI部品から共通利用。通常は変更不要 |
| `components.json` | shadcnのスタイル、CSS、import alias設定 | UI部品追加時に参照 |
| `package.json` | scripts、依存ライブラリ、Node.js要件 | ライブラリ追加・コマンド変更時に編集 |
| `package-lock.json` | 依存バージョンを固定する自動生成ファイル | 手編集しない。npmで更新 |
| `tsconfig.json` | TypeScriptの厳格性、対象ファイル、`@/*` alias | パス構成変更時に編集 |
| `eslint.config.mjs` | ESLintとNext.js向け静的検査 | 品質ルール変更時に編集 |
| `postcss.config.mjs` | Tailwind CSSのPostCSS設定 | CSS基盤変更時のみ編集 |
| `next.config.ts` | Next.js設定 | 画像、リダイレクト等の追加時に編集 |
| `vite.config.ts` | Vinext、Vite、Cloudflare開発環境設定 | 開発サーバー・binding変更時に編集 |
| `drizzle.config.ts` | Drizzleのスキーマ・出力先設定 | DB採用時に編集 |
| `.npmrc` | npmのインストール動作設定 | 原則維持 |
| `.gitignore` | Gitへ含めない生成物や秘密情報 | 新しい生成物追加時に更新 |

## 8. データベース関連

| ファイル | 説明 |
| --- | --- |
| `db/index.ts` | Cloudflare D1 bindingからDrizzleクライアントを生成します。現在D1は未設定です。 |
| `db/schema.ts` | 本番用テーブル定義の追加場所です。現在は空です。 |
| `drizzle/meta/_journal.json` | マイグレーション履歴を管理する自動生成情報です。 |
| `examples/d1/db/schema.ts` | D1テーブル定義のサンプルです。本番スキーマではありません。 |
| `examples/d1/app/api/notes/route.ts` | D1を利用するAPIルートのサンプルです。本番APIではありません。 |

本番では、利用者、顔特徴参照、送信先、同意履歴、安否確認処理、宛先別送信結果などを別テーブルとして設計します。生の顔画像や平文の機密情報を安易に保存しないでください。

## 9. ビルド・実行・ホスティング関連

| ファイル | 説明 | 注意 |
| --- | --- | --- |
| `worker/index.ts` | ビルド後アプリへのリクエストを処理するWorker入口 | 画像最適化とアプリルーターを接続 |
| `build/sites-vite-plugin.ts` | ホスティング用のビルド情報を生成するViteプラグイン | 基盤変更時以外は原則維持 |
| `.openai/hosting.json` | ホスティング先IDとD1/R2 binding名 | 別環境では作り直す |
| `scripts/install-ci.sh` | lockfileどおりに依存を導入 | CIとローカル準備で使用 |
| `scripts/build-verified.sh` | 制限時間付き本番ビルド | `npm run build` から呼ばれる |
| `scripts/sites-env.sh` | ビルド用HOME・一時領域をプロジェクト内へ分離 | 他スクリプトから利用 |
| `vendor/shadcn-tailwind-4.13.0.css` | UI部品の基礎スタイル | 外部由来。直接改変は慎重に行う |
| `vendor/shadcn-tailwind-4.13.0.LICENSE.md` | 外部UIスタイルのライセンス表記 | 削除しない |

## 10. テストファイル

| ファイル | 説明 |
| --- | --- |
| `tests/rendered-html.test.mjs` | ビルドされたHTMLとプレビュー用メタ情報を検証します。 |
| `tests/ui-components.test.mjs` | UI部品の出力条件を検証します。 |

> 検証時点（2026-09-03）：`npm run build` は成功します。スターター付属テストは5件中3件が成功し、`codex-preview` メタ情報と生成CSSユーティリティを確認する2件が現在のVinext出力との差により失敗します。2次開発開始時に、必要なメタ情報・CSSを復元するか、現行の出力仕様に合わせてテストを更新してください。画面遷移、顔認証API、メール送信APIの結合テストは別途追加が必要です。

画面遷移やAPI連携を本格実装する場合は、VitestまたはPlaywright等を追加し、少なくとも次を自動化してください。

1. 初回登録の正常系
2. 2回目以降の正常系
3. 氏名・メール形式・宛先重複の異常系
4. カメラ拒否・顔不一致・該当者なし
5. メールの部分失敗・再試行・二重送信防止
6. 無操作タイムアウトと個人情報消去

## 11. 2次開発の推奨分割

機能追加が始まる前に、次の構成へ少しずつ分割すると保守しやすくなります。一度に全面改修せず、テストを追加しながら画面単位で移動してください。

```text
app/
  page.tsx                    ルート画面のみ
features/
  enrollment/                初回登録画面・状態
  safety-check/              2回目以降画面・状態
  camera/                    カメラ取得・撮影・解放
  timeout/                   無操作監視
components/
  kiosk/                     本システム固有の共通UI
  ui/                        汎用UI部品
services/
  api-client.ts              HTTP共通処理
  face-api.ts                顔登録・照合
  mail-api.ts                メール送信
types/
  api.ts                     API入出力型
  domain.ts                  利用者・送信先等の型
```

## 12. 本番APIへ接続する順序

1. API入出力型と共通エラー型を定義します。
2. `runProcessing()` を直接書き換える前に、`services/` 配下へAPIクライアントを作ります。
3. SCR-02・SCR-07・SCR-10へ顔認証結果の分岐を追加します。
4. SCR-05の登録先をサーバー側でも再検証します。
5. SCR-13の送信に冪等キーを付与します。
6. SCR-08・SCR-14へ宛先別の成功・失敗・処理中を反映します。
7. 通信失敗、該当者なし、複数候補、部分失敗の画面を追加します。
8. 監査ログと同意文面版数を保存します。

詳細は `docs/API_INTEGRATION.md` を参照してください。

## 13. 変更別チェックポイント

### 文言だけを変更する場合

- `app/page.tsx` の対象 `SCR-xx` を変更
- 同意文面は法務確認と版数更新を実施
- 13.3インチ実機で改行とボタン高さを確認

### 色・サイズを変更する場合

- `app/globals.css` のCSS変数を優先して変更
- 色だけで状態を伝えていないか確認
- コントラスト、62px以上のタッチ領域、フォーカス表示を確認

### 画面を追加する場合

- `ScreenId` へIDを追加
- `INITIAL_STEPS` または `REPEAT_STEPS` を更新
- `renderScreen()` へcaseを追加
- 戻る・中止・タイムアウト後の遷移を定義
- 正常系と異常系のテストを追加

### 個人情報を扱う場合

- URL、console、解析タグへ氏名・メール・顔データを出さない
- 完了、中止、タイムアウト時の破棄を確認
- 通信時・保存時の暗号化、権限、保存期間を定義
- 顔画像を保存する場合は目的、同意、削除方法を明示

## 14. 開発・検証コマンド

```bash
npm run install:ci  # 依存関係を導入
npm run dev         # 開発サーバーを起動
npm run lint        # TypeScript/Reactを静的検査
npm run build       # 本番ビルド
npm test            # ビルドと既存テスト
```

## 15. リリース前チェックリスト

- [ ] 初回登録と2回目以降の全画面が仕様書どおり遷移する
- [ ] 戻る・中止・不同意・タイムアウトの分岐が動作する
- [ ] カメラ画面を離れるとMediaStreamが停止する
- [ ] 顔認証の品質不足、不一致、該当なし、複数候補を処理できる
- [ ] メール送信の二重実行を防止している
- [ ] 宛先別の成功・失敗・処理中を正しく表示する
- [ ] 個人情報をURL、ログ、ブラウザ保存領域へ残していない
- [ ] Android実機で横向き、ソフトキーボード表示、タッチ操作を確認した
- [ ] `npm run lint`、`npm run build`、自動テストが成功する
- [ ] 同意文面、プライバシーポリシー、保存期間を関係者が承認した

## 16. ファイルを編集しない判断

次のファイルは生成物または外部由来のため、明確な目的がなければ直接編集しません。

- `package-lock.json`：npmが更新します。
- `drizzle/meta/_journal.json`：Drizzle Kitが更新します。
- `vendor/*`：外部スタイルとライセンスです。
- `components/ui/*`：共通UI部品です。アプリ固有変更はラッパー部品を新設します。
- `.openai/hosting.json`：別環境への展開時だけ基盤手順に従って変更します。

この方針により、デザイン変更、API接続、DB追加、管理画面追加を互いに干渉させず進めやすくなります。
