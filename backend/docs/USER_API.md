# 用户端接口合同

基础路径为 `http://localhost:3001`，JSON/UTF-8。日期为 UTC ISO 8601，界面按 `GET /v1/terminal` 返回的设施时区显示。所有返回均设置 `Cache-Control: no-store`，服务端日志不记录姓名、邮箱、图片、用户令牌、终端凭据或原始异常详情。

## 请求头

```http
X-Terminal-Id: <终端 UUID>
X-Terminal-Token: <终端随机凭据>
Authorization: Bearer <短期 user_token>
Idempotency-Key: <本次操作 UUID>
Content-Type: application/json
```

前两项在所有业务接口中必需；Authorization 在已识别用户的操作中必需。所有写操作必须带幂等键。重试同一操作时保留同一键和相同参数；不同参数或不同用户令牌使用同一键返回 `409 IDEMPOTENCY_CONFLICT`。成功重放带 `Idempotency-Replayed: true`。幂等成功应答加密保留 15 分钟；键过期后开始新的用户操作，不自动重复旧发送。

## 接口与画面对应

| 方法与路径 | 用途/画面 | 请求内容 | 用户令牌 |
| --- | --- | --- | --- |
| `GET /v1/terminal` | SCR-00/01：终端、时区、服务能力 | 无 | 无 |
| `GET /v1/consent-policies?type=registration` | SCR-04：当前登记同意文面 | 查询参数 `registration` 或 `safety` | 无 |
| `POST /v1/enrollments` | SCR-02：开始临时登记 | `{}` | 无 |
| `GET /v1/enrollments/{id}` | 登记进度 | 无 | 无 |
| `PATCH /v1/enrollments/{id}/profile` | SCR-03：暂存姓名 | `display_name` | 无 |
| `POST /v1/faces/liveness-sessions` | SCR-02/07/10：创建生体会话 | `purpose`，登记拍摄时加 `enrollment_id` | `purpose=registration` 时需要 |
| `POST /v1/enrollments/{id}/face` | SCR-02：核验初次脸部拍摄 | `liveness_session_id` | 无 |
| `POST /v1/enrollments/{id}/consent` | SCR-04：记录同意或拒绝 | `policy_version`、`result` | 无 |
| `PUT /v1/enrollments/{id}/recipients` | SCR-05/06：暂存联系人 | `recipients: [{name,email}]` | 无 |
| `POST /v1/enrollments/{id}/complete` | SCR-06：原子保存正式登记 | `{}` | 无 |
| `DELETE /v1/enrollments/{id}` | 取消未完成登记 | `{}` | 无 |
| `POST /v1/faces/verify-registration` | SCR-07：登记后再拍摄核验 | `liveness_session_id` | 登记令牌 |
| `POST /v1/faces/identify` | SCR-10：识别有效登记人 | `liveness_session_id` | 无 |
| `POST /v1/users/me/confirmation` | SCR-07/11：确认本人姓名 | `confirmed: true/false` | 必需 |
| `GET /v1/users/me/recipients` | SCR-12：联系人姓名及掩码邮箱 | 无 | 必需且已确认本人 |
| `POST /v1/enrollments/{id}/confirmation-mails` | SCR-08：登记确认邮件 | `{}` | 已核验并确认的登记令牌 |
| `POST /v1/safety-checks` | SCR-13：都度同意并发信 | `policy_version`、`consent: true` | 安否令牌且已确认本人 |
| `GET /v1/safety-checks/{id}` | SCR-08/14：轮询发送结果 | 无 | 同一用户及终端 |
| `POST /v1/safety-checks/{id}/retry` | 只重试允许的失败宛先 | `{}` | 必需 |
| `DELETE /v1/sessions/current` | 完成、取消、返回首页时销毁用户令牌 | `{}` | 必需 |
| `POST /v1/mail/webhooks` | SES 发送/配信/退信/投诉通知 | AWS SNS 签名通知 | 使用 SNS 签名验证 |

健康检查为 `/health/live`、`/health/ready`，OpenAPI 为 `/openapi.json`。当前合同统一使用 `faces` 路径；旧前端集成指南中的例示路径须按此表替换。

## 初次登记顺序

1. 获取登记同意文面，`POST /v1/enrollments` 返回 `temp_id`、`expires_at`。
2. 创建 `purpose=enrollment` 的生体会话并提供 `enrollment_id=temp_id`。前端使用 AWS Face Liveness 专用组件和受限临时 AWS 凭据完成视频挑战；随后提交 session ID 到 `/enrollments/{id}/face`。后端从 AWS 获取生体得分与参考图，不接受客户端提交 `liveness_passed`、匹配分数或模板。
3. 通过 profile 暂存姓名，姓名规范化后为 1～50 字符，禁止空白、控制字符及 HTML 标记。
4. 提交登记同意，`result=granted` 或 `denied`。拒绝会即时移除临时数据，不创建用户或云端 Collection 特征。
5. 提交 1～2 名联系人，邮箱格式和去重由服务器验证。确认登记后调用 complete，返回 `user_id`、`status=pending_registration`、`user_token`、`expires_at`。该时点才向 Collection 索引脸部特征并在事务中保存密文；Redis 中原始参考图随后清除。
6. 携带登记令牌创建 `purpose=registration` 生体会话，然后调用 verify-registration。匹配成功返回姓名和新的用户令牌；旧令牌失效。
7. 用新令牌确认本人姓名，再调用 confirmation-mails。至少一个宛先达到 `accepted` 后，后台将用户设为 `active`。全部失败不会完成登记。
8. 完成后删除当前会话，界面清除个人信息并停止摄像头。已持久化但未完成邮件确认的登记取消，应由工作人员处理，不能通过临时登记 DELETE 擅自删除正式记录。

Redis 数据最长 15 分钟、90 秒无操作失效；终端需在页面取消、退出或超时时调用取消接口。临时信息不会进入业务数据库或原始图片日志。生体会话约 3 分钟内完成且只能消费一次，绑定用途、终端及登记/用户会话。

## 安否操作顺序

创建 `purpose=safety` 生体会话，完成挑战后调用 identify。只有 `result=matched` 才返回 `display_name`、`user_token` 与期限；`no_match`、`ambiguous` 不含姓名或令牌。3 次连续识别或生体失败后冷却 5 分钟。

确认姓名后，读取掩码联系人；获取 `type=safety` 最新文面，调用 safety-checks：

```json
{ "policy_version": "dev-v1", "consent": true }
```

响应 HTTP 202：

```json
{
  "check_id": "<UUID>",
  "status": "queued",
  "recipient_results": [
    { "delivery_id": "<UUID>", "recipient_id": "<UUID>", "status": "queued" }
  ]
}
```

轮询 `/v1/safety-checks/{check_id}`，返回每个收件人的状态、受付/配信时间、尝试次数和固定错误码，不返回完整邮箱。本人确认、脸部验证、本次同意、终端和每个收件人均由后端关联检查；客户端不能把 user_id 换成另一人。

用户令牌有效期最多 3 分钟、90 秒无操作失效。一次成功识别证据只能授权一个发送事件；其他发送须重新识别。同一键重试返回原事件，不重复发信。

## 状态与重试

| 宛先状态 | 前端含义 |
| --- | --- |
| `queued` | 等待处理，不能显示成功 |
| `sending` | 外部请求进行中，不能显示成功 |
| `accepted` | 邮件服务商已接受，符合规格书的“送信受付済み” |
| `delivered` | 服务商报告送达，不代表已阅读 |
| `bounced` | 无法配信，联系人待修正 |
| `failed` | 明确失败，根据错误码决定是否可重试 |
| `unknown` | 请求超时或中断，可能已经发送；等待签名回调或工作人员核对 |
| `cancelled` | 授权状态/有效期限已变化，未继续发送 |

事件状态为 queued/processing/accepted/partially_accepted/failed/unknown/cancelled。部分成功只展示已接受与失败的具体收件人。每封邮件只含一个 To 地址，最多尝试 3 次。只对明确限流等暂时失败指数退避；`unknown` 从不自动重发。回调可把 unknown 恢复为 accepted/delivered/bounced；乱序 accepted 不会覆盖 delivered/bounced。服务崩溃遗留的 sending 超过 45 秒后设为 unknown。

工作进程在真正发送前再次锁定并检查用户、终端、联系人、同意和期限，禁止恢复后补发已经过期的操作。retry 只允许当前有效期限内、尝试次数不足 3、`failed + MAIL-002` 的宛先；受付成功、永久失败及结果未知均不允许重发。

## 错误

统一响应：

```json
{ "error": { "code": "USER_SESSION_EXPIRED", "message": "もう一度、顔を確認してください。", "request_id": "<UUID>" } }
```

| HTTP | 常见错误码 | 处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`、`IDEMPOTENCY_KEY_REQUIRED` | 修正输入/请求头 |
| 401 | `TERMINAL_AUTH_FAILED`、`USER_SESSION_EXPIRED`、`FACE_VERIFICATION_EXPIRED` | 检查终端或重新识别 |
| 403 | `IDENTITY_CONFIRMATION_REQUIRED` | 先确认本人姓名 |
| 404 | `NOT_FOUND` | 结果不属于当前用户/终端或不存在 |
| 409 | `STATE_CONFLICT`、`POLICY_VERSION_CHANGED`、`IDEMPOTENCY_CONFLICT`、`SESSION_ALREADY_USED` | 按状态重新操作，避免自动重复发送 |
| 410 | `TIME-001`、`LIVENESS_SESSION_EXPIRED` | 清空界面并重新开始 |
| 422 | `FACE-001/002/004`、`FACE_QUALITY_FAILED` | 按画面指示重新拍摄 |
| 429 | `FACE-004`、`RATE_LIMITED` | 冷却等待或联系工作人员 |
| 503 | `SERVICE_NOT_CONFIGURED`、`POLICY_NOT_AVAILABLE`、`FACE_SERVICE_UNAVAILABLE` | 显示服务未就绪，不能显示成功 |

需要 staff 处理的结果不应在界面暴露具体内部异常、服务商凭据或生体得分。
