# 本番API接続ガイド

この資料は、現在の画面確認用疑似処理を本番APIへ置き換える際の実装ポイントです。パス名は例であり、既存基盤に合わせて変更してください。

Node.js実装の実際のパス・リクエスト形式は[利用者API合同](../../backend/docs/USER_API.md)を正としてください。以下の旧対応表は画面整理時の例です。APIは`http://localhost:3001`で動作し、端末認証ヘッダー、短期ユーザートークン、書込時のIdempotency-Keyを使用します。顔確認はAWS Face LivenessセッションIDを送信し、メール送信は202応答後に結果APIをポーリングします。

## 推奨API対応表

| 操作 | 画面 | API例 | 成功時 | 主な失敗分岐 |
| --- | --- | --- | --- | --- |
| 初回の顔撮影 | SCR-02 | `POST /v1/enrollments/draft/face` | SCR-03 | 品質不足、生体判定失敗、カメラ障害 |
| 氏名登録 | SCR-03 | `PATCH /v1/enrollments/{id}/profile` | SCR-04 | 文字数超過、禁止文字 |
| 同意記録 | SCR-04 | `POST /v1/enrollments/{id}/consents` | SCR-05 | 文面版数不一致、保存失敗 |
| 連絡先登録 | SCR-05 | `PUT /v1/enrollments/{id}/recipients` | SCR-06 | 形式不正、重複、上限超過 |
| 登録確定 | SCR-06 | `POST /v1/enrollments/{id}/complete` | SCR-07 | 重複登録、保存失敗 |
| 顔登録の確認 | SCR-07 | `POST /v1/face/verifications` | SCR-08 | 不一致、品質不足、該当なし |
| 確認メール送信 | SCR-08 | `POST /v1/enrollments/{id}/confirmation-mails` | SCR-09 | 宛先別の部分失敗、配信基盤障害 |
| 登録者の特定 | SCR-10 | `POST /v1/face/identifications` | SCR-11 | 該当なし、複数候補、品質不足 |
| 登録済み宛先取得 | SCR-12 | `GET /v1/users/{id}/recipients` | SCR-12表示更新 | 登録なし、権限不正 |
| 安否メール送信 | SCR-13 | `POST /v1/safety-checks` | SCR-14 | 宛先別の部分失敗、重複、タイムアウト |
| 送信結果取得 | SCR-14 | `GET /v1/safety-checks/{id}` | 結果更新 | 状態取得失敗 |

## 置換するコード

`app/page.tsx` の `runProcessing()` は一定時間後に次画面へ進むだけの疑似処理です。実装時は、次のような責務を持つAPIクライアントへ置き換えます。

```ts
// 実装例：実際のAPI仕様に合わせて型とURLを調整してください。
async function sendSafetyCheck(payload: {
  userId: string;
  consentVersion: string;
  idempotencyKey: string;
}) {
  const response = await fetch("/api/v1/safety-checks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": payload.idempotencyKey,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) throw new Error("安否確認メールの送信に失敗しました");
  return response.json();
}
```

## 顔データの扱い

- 顔画像を永続保存するかは、法務・セキュリティ・委託先要件を踏まえて決定します。
- 保存しない設計では、端末上のフレームから特徴量を生成後、画像バッファを直ちに破棄します。
- 特徴量は通信時・保存時とも暗号化し、利用目的外の検索を禁止します。
- 照合閾値を画面側へ持たせず、サーバーまたは認証基盤で管理します。
- 「該当なし」「複数候補」「品質不足」「生体判定失敗」を同一の成功扱いにしません。

## メール送信の扱い

- 1回の操作につき一意な冪等キーを発行し、連打や再試行による二重送信を防ぎます。
- APIは宛先ごとの `accepted` / `failed` / `pending` を返し、SCR-08・SCR-14へ反映します。
- 「送信受付」と「受信箱への到着」は区別して表示します。
- ログへ氏名、メール本文、完全なメールアドレスを出力しません。

## 同意・監査

- 同意日時、同意文面の版数、端末ID、処理IDをサーバー側へ記録します。
- 生の顔画像や完全なメールアドレスを監査ログへ含めません。
- 中止、タイムアウト、照合失敗も個人情報を含まないイベントとして記録します。

## 通信エラーの画面設計

本番実装では、疑似処理オーバーレイを次の状態へ拡張してください。

1. 処理中：ボタンを無効化し、二重実行を防止
2. 成功：API結果を状態へ保存して次画面へ遷移
3. 再試行可能：通信障害として「もう一度試す」を表示
4. 再試行不可：入力内容を保持せず、スタッフ案内またはホームへ戻す
5. 部分失敗：宛先ごとの結果を表示し、未送信先だけ再送できるようにする
