# Android 利用者端末の API 連携（簡略版）

版：0.4.0。本番バックエンドの Origin：`https://anshin.info`。API の接続先：`https://anshin.info/v1`。管理画面：`https://anshin.info/admin`。

以下の表は `/v1` を含むパスを記載しています。例えば端末情報の取得先は `https://anshin.info/v1/terminal` です。API の接続先に `/v1` を設定したクライアントでは、パスに `/v1` を重ねないでください。

## 要求の規約

すべてのクライアントを同一のロボットとして扱います。端末 ID、端末の認証情報、Authorization は送信せず、user_token も返しません。
登録と顔認証で返された user_id を後続の処理で直接使用します。顔認証、本人確認、同意の各手順は以下の順序で実行します。バックエンドでは認証の有効期限と重複送信の防止を確認します。

POST / DELETE には Content-Type: application/json と Idempotency-Key: <今回の操作の UUID> を使用します。
同じ要求を通信エラーで再試行する場合は、同じ ID と同じ本文を再使用してください。新しい操作には新しい ID を使用します。
写真は JPEG/PNG の Base64 データのみとし、data URL の接頭辞を付けません。デコード後の上限は 512 KiB です。

## 登録の順序

登録が完了した `active` の利用者だけを登録済みと扱います。登録①で既存の `active` の利用者と高い類似度で一致した場合は HTTP 409、`error.code=FACE_ALREADY_REGISTERED` を返し、`temp_id` は返しません。登録③では登録①で確認済みの写真をそのまま保存し、重複検索を繰り返しません。初回撮影から保存までの間に別の操作で同じ顔の登録が完了しても、登録③では再検出しません。`pending_registration`、写真撮影だけの記録、途中で中止した記録は再登録を妨げず、安否確認の顔認証にも使用しません。2 回目の登録確認では今回の `user_id` だけを照合するため、ほかの未完了の記録の影響は受けません。登録確認が成功し、すべての通知がメールサーバーに受理されてから状態が `active` になります。フロントエンドで `FACE_ALREADY_REGISTERED` を受け取った場合は「登録済みです。「登録済み」の手順を選択してください」と案内します。この応答に既存の利用者の氏名や ID は含めません。

| 手順 | 要求 | 応答と画面の処理 |
| --- | --- | --- |
| ① 初回撮影 | POST /v1/registrations/capture；image_base64 | face_valid、temp_id、expires_at；確認後に情報の入力へ進む |
| ② 同意文面の取得 | GET /v1/consent-policies?type=registration | title、body、policy_version |
| ③ 登録の確定 | POST /v1/registrations；temp_id、display_name、recipients、consent_result、policy_version | success、user_id、user_status=pending_registration；user_id を保存する |
| ④ 再撮影による確認と通知の自動送信 | POST /v1/registrations/verify；user_id、image_base64 | matched、similarity_score、metrics、verification_status；照合と送信要求の受付が成功した場合は check_id、send_requested=true も返す |

recipients は 1～2 件の連絡先です：[{"name":"家族","email":"family@example.com"}]。
consent_result は granted / denied です。同意を拒否した場合は利用者を作成しません。
2 回目の写真は今回の user_id に対応する顔だけと比較します。matched=false の場合は撮り直し、メールを送信しません。
照合に成功して send_requested=true が返されたら、利用者画面に通知の送信要求の受付成功を表示し、操作を終了します。**従来の登録⑤のメール結果のポーリング手順は削除します。**
バックグラウンドでメールの処理結果に応じて登録状態を更新します。利用者画面では実際の結果を待機・表示しません。

## 安否確認の順序

| 手順 | 要求 | 応答と画面の処理 |
| --- | --- | --- |
| ① 顔認証 | POST /v1/faces/identify；image_base64 | matched；成功時は display_name、user_id、metrics；不一致の場合は氏名や利用者 ID を返さない |
| ② 本人確認と連絡先の取得 | POST /v1/users/{user_id}/recipients；confirmed=true | 連絡先の name、masked_email と consent_body、policy_version |
| ③ 同意と送信 | POST /v1/safety-notifications；user_id、consent=true、policy_version | 202：success=true、send_requested=true、check_id、user_id；送信成功を表示して終了する |

confirmed=false は本人ではないことを示し、連絡先を返さず、メールも送信しません。
consent=false は送信に同意しないことを示します。send_requested=false、check_id=null を返し、メールの送信要求を作成しません。

送信例：

```http
POST /v1/safety-notifications HTTP/1.1
Host: anshin.info
Content-Type: application/json
Idempotency-Key: 11111111-1111-4111-8111-111111111111

{"user_id":"22222222-2222-4222-8222-222222222222","consent":true,"policy_version":"dev-v1"}
```

```json
{"success":true,"send_requested":true,"check_id":"33333333-3333-4333-8333-333333333333","user_id":"22222222-2222-4222-8222-222222222222"}
```

## 利用者画面のメール表示

バックエンドが送信要求を受け付けたら、利用者画面では一律に「送信成功」と表示します。待機中、送信失敗、一部失敗、配信済み、返送などの状態を問い合わせ・表示せず、メールの再試行ボタンも設けません。
ここでの成功は **バックエンドが送信要求を受け付けたこと** を意味し、宛先がメールを受信したことを保証するものではありません。非同期の送信失敗によって利用者画面の完了表示は変わりません。
要求が受け付けられなかった場合や通信が中断した場合は、送信記録を作成しません。利用者画面では操作を終了でき、メールの具体的な失敗理由は表示しません。調査には開発ログを使用します。
サービス事業者による受付、配信、返送の実際の結果は引き続きバックエンドに保存し、管理画面とは今後別途連携します。
/v1/mail-results と retry はバックエンドの診断用に残しており、Android 利用者端末からは呼び出しません。

## 操作の終了

バックエンドの登録途中の情報と顔認証セッションは、関連する API 呼び出しが連続 5 分間ない場合に失効し、全体の有効期限も最長 15 分です。関連する有効な要求は無操作時間を更新しますが、全体の有効期限は延長しません。画面へのタッチ、端末内の入力、同意文面の取得だけではバックエンドのタイマーを更新しません。`/v1/terminal` と初回撮影の応答に含まれる `idle_timeout_seconds` は 300 です。登録途中の情報の期限切れは `TIME-001`、顔認証セッションの期限切れは `FACE_VERIFICATION_REQUIRED` を返します。App は今回の操作情報を消去し、やり直しを案内してください。画面のダイアログ、カウントダウン、ホームへの復帰は Android App で実装します。

仮登録の取消：DELETE /v1/registrations/{temp_id}。
登録後の操作の終了：DELETE /v1/sessions/current、本文 {"user_id":"..."}。
終了時には画面の写真、氏名、連絡先、user_id を消去します。認証の有効期限が切れている場合は、画面の情報を消去するだけで構いません。
ローカルのブラウザによる動作確認では /api/terminal/... を使用できます。Android は本番バックエンドの `https://anshin.info/v1/...` を直接呼び出します。Android のネイティブ HTTP 通信にブラウザの CORS 設定は不要です。ブラウザや WebView の JavaScript から別の Origin で呼び出す場合は、実際の画面の Origin を伝え、バックエンドの CORS 設定を確認してください。

## 呼び出し例

```ts
const api = createFaceClient('https://anshin.info/v1');
const draft = await api.captureRegistration(photo);
const policy = await api.registrationPolicy();
const registered = await api.register({temp_id:draft.temp_id,display_name:name,recipients,
  consent_result:'granted',policy_version:policy.policy_version});
if (registered.user_id) {
  const verified = await api.verifyAndNotify(secondPhoto, registered.user_id);
  if (verified.matched && verified.send_requested) showSendSuccess();
}
const person = await api.identify(photo);
if (person.matched && person.user_id) {
  const contacts = await api.confirmRecipients(person.user_id, true);
  const sent = await api.notifySafety(person.user_id, true, contacts.policy_version!);
  if (sent.send_requested) showSendSuccess();
}
```
