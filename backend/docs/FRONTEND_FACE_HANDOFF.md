# Android 用户端接口对接（简化版）

版本：0.4.0。后端地址：`http://192.168.0.51:3002`，IP 变化时同步更新。

## 请求约定

所有客户端按同一个机器人处理，不传终端 ID、终端凭据或 Authorization，不返回 user_token。
注册和识别返回 user_id，后续直接使用该 ID。人脸识别、本人确认、同意步骤仍按下面顺序执行，后端保留验证有效期与防重复发送检查。

POST / DELETE 使用 Content-Type: application/json 和 Idempotency-Key: <本次操作的 UUID>。
同一次请求的网络重试必须复用同一个编号和相同正文；新的操作使用新编号。
照片使用 JPEG/PNG 纯 Base64，不带 data URL 前缀，解码后最多 512 KiB。

## 注册顺序

仅注册成功的 `active` 用户视为已登记。注册①发现与现有 `active` 用户高度匹配时返回 HTTP 409、`error.code=FACE_ALREADY_REGISTERED`，不返回 `temp_id`。注册③会再次检查已完成登记，不因姓名不同而允许重复登记。`pending_registration`、仅拍照或中途放弃的记录不阻止重新登记，也不会被安否识别匹配；二次登记验证仅匹配本次登记的 `user_id`，不会受其他未完成记录干扰。登记验证通过且通知全部被邮件服务器受理后，状态才变为 `active`。前端遇到 `FACE_ALREADY_REGISTERED` 时提示“已登记，请选择登记済み流程”。该响应不透露已有用户的姓名和 ID。

| 步骤 | 请求 | 响应及页面处理 |
| --- | --- | --- |
| ① 第一次采集 | POST /v1/registrations/capture；image_base64 | face_valid、temp_id、expires_at；通过后继续填写资料 |
| ② 获取同意文案 | GET /v1/consent-policies?type=registration | title、body、policy_version |
| ③ 确定登记 | POST /v1/registrations；temp_id、display_name、recipients、consent_result、policy_version | success、user_id、user_status=pending_registration；保存 user_id |
| ④ 第二次验证并自动发通知 | POST /v1/registrations/verify；user_id、image_base64 | matched、similarity_score、metrics、verification_status；匹配并提交成功时还有 check_id、send_requested=true |

recipients 为 1～2 个联系人：[{"name":"家族","email":"family@example.com"}]。
consent_result 为 granted / denied；拒绝同意不会创建用户。
第二次照片只与本次 user_id 对应的人脸比较。matched=false 时重拍，不发邮件。
匹配并返回 send_requested=true 后，用户端显示通知提交成功并结束操作，**删除原注册⑤的邮件轮询步骤**。
后台按邮件处理结果更新登记状态，用户端不等待或展示实际结果。

## 安否顺序

| 步骤 | 请求 | 响应及页面处理 |
| --- | --- | --- |
| ① 识别人脸 | POST /v1/faces/identify；image_base64 | matched；成功时 display_name、user_id、metrics；未匹配不返回姓名或用户 ID |
| ② 确认本人并获取联系人 | POST /v1/users/{user_id}/recipients；confirmed=true | 联系人 name、masked_email，同时 consent_body、policy_version |
| ③ 同意并发送 | POST /v1/safety-notifications；user_id、consent=true、policy_version | 202：success=true、send_requested=true、check_id、user_id；显示发送成功并结束 |

confirmed=false 表示不是本人，不返回联系人、不发送邮件。
consent=false 表示不同意发送，返回 send_requested=false、check_id=null，不创建邮件请求。

发送示例：

```http
POST /v1/safety-notifications HTTP/1.1
Host: 192.168.0.51:3002
Content-Type: application/json
Idempotency-Key: 11111111-1111-4111-8111-111111111111

{"user_id":"22222222-2222-4222-8222-222222222222","consent":true,"policy_version":"dev-v1"}
```

```json
{"success":true,"send_requested":true,"check_id":"33333333-3333-4333-8333-333333333333","user_id":"22222222-2222-4222-8222-222222222222"}
```

## 用户端邮件展示

后端接受发送请求后，用户端统一显示“发送成功”，不查询或展示排队、发送失败、部分失败、送达、退信等状态，也不提供邮件重试按钮。
这里的成功表示**发送请求已提交给后端**，不是客户已收到邮件的保证。异步发送失败不改变用户端完成页。
接口未接受请求或网络中断时，不伪造发送记录；用户端可以结束操作，不展示具体邮件失败原因，开发日志用于排查。
实际邮件是否被服务商接受、投递或退信，继续保存在后端，之后单独与管理端联动。
/v1/mail-results 与 retry 暂留作后端诊断，Android 用户端不调用。

## 结束操作

草稿取消：DELETE /v1/registrations/{temp_id}。
登记后的操作结束：DELETE /v1/sessions/current，正文 {"user_id":"..."}。
结束时清空界面中的照片、姓名、联系人和 user_id。若验证已过期，直接清空即可。
本机网页自测可走 /api/terminal/...；Android 直接调用后端 /v1/...。

## 调用示例

```ts
const api = createFaceClient();
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
