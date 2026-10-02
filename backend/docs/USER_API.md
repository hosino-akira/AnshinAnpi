# 用户端接口合同（最终流程）

版本 0.2.0，2026-10-02。主机开发地址 `http://localhost:3002`，局域网地址 `http://192.168.0.51:3002`；Docker 端口由 compose 与 .env 决定。JSON/UTF-8，时间为 UTC ISO 8601，终端时区由 GET /v1/terminal 返回。所有接口返回 Cache-Control: no-store。

完整请求、响应、前端代码及局域网代理配置见 [最终版前端交接文档](FRONTEND_FACE_HANDOFF.md)。机器合同见 [OpenAPI JSON](openapi.json)，在线地址 /openapi.json。字段以代码生成的合同为准。

## 主流程

| 步骤 | 方法与路径 | 正文 | 返回 |
| --- | --- | --- | --- |
| 注册① | POST /v1/registrations/capture | image_base64 | 201 temp_id、face_valid、质量指标 |
| 注册② | GET /v1/consent-policies?type=registration | 无 | 当前 title、body、policy_version |
| 注册③ | POST /v1/registrations | temp_id、display_name、recipients、policy_version、consent_result | 201 正式 user_id、pending_registration、user_token |
| 注册④ | POST /v1/registrations/verify | user_id、image_base64 | 200 比对结果；通过自动创建登记邮件批次，返回 check_id、新 user_token |
| 注册⑤ | GET /v1/mail-results/{check_id} | 无 | 逐项邮件状态、registration_completed、user_status |
| 安否① | POST /v1/faces/identify | image_base64 | 200 matched/result/metrics；匹配时返回姓名、user_id、user_token |
| 安否② | POST /v1/users/{user_id}/recipients | confirmed: true/false | 确认本人后返回联系人姓名、masked_email、发送同意正文和版本 |
| 安否③ | POST /v1/safety-notifications | user_id、consent: true/false、policy_version | 202 check_id、逐项 queued；拒绝为 200 cancelled，不发信 |
| 安否结果 | GET /v1/mail-results/{check_id} | 无 | mail_status、recipient_results |

注册①临时 ID 不是用户记录；注册③一次保存姓名、1–2 个不重复邮箱联系人、同意结果与人脸特征引用。首次图片无需先建立用户或记录完整登记同意，但前端应在上传前取得本次照片处理授权。完整登记同意在注册③记录。

正常登记状态 pending_registration → active。第二次验证成功后发送的是“連絡先登録のお知らせ”，不额外发送安否通知。全部登记邮件受理成功时才 active；部分失败保持 pending_registration。安否识别只允许 active 用户。注册④没有匹配返回 matched=false，不创建邮件请求，也不撤销原令牌；使用新照片和新请求编号重拍。图片模式不做活体检测。

文书位于 backend/config/consent-policies.json，当前为开发用 dev-v1。发布新正文同时更新版本并重启后端；提交旧版本返回 409 POLICY_VERSION_CHANGED。consents 表只记录决定及版本，不存文书正文。

## 鉴权与防重复

公开：GET /health/live、/health/ready、/openapi.json、/v1/consent-policies。其余业务接口使用 X-Terminal-Id 与 X-Terminal-Token；注册④/⑤、安否②/③/结果需要 Authorization: Bearer <user_token>。终端凭据由 BFF 添加，不传入浏览器代码。

所有 POST、PATCH、PUT、DELETE 请求必须带 Idempotency-Key；SNS Webhook 例外。对同一操作重试保留相同编号、正文和原令牌；同一编号不同内容返回 409 IDEMPOTENCY_CONFLICT。成功重放带 Idempotency-Replayed: true，内存成功响应保留 15 分钟。注册④令牌轮换后，下一步用新令牌；原步骤重试用原令牌。

临时草稿最长 15 分钟、闲置 90 秒过期；GET /v1/registrations/{temp_id} 可查询并续闲置期，不能延长最长截止时间。用户会话最长 3 分钟，闲置 90 秒失效。临时存储为单进程内存，无 Redis。重启丢失草稿和会话，但 safety_checks 的防重复编号持久化，不会重复创建邮件批次。已提交的注册④重放可恢复结果查询令牌和原 check_id；recovered=true，similarity_score=null。其他旧会话失效需重新识别。

## 辅助接口

| 方法与路径 | 用途 | 令牌 |
| --- | --- | --- |
| GET /v1/terminal | 终端时区、服务配置能力 | 终端凭据 |
| GET /v1/registrations/{temp_id} | 草稿进度和有效期 | 终端凭据 |
| DELETE /v1/registrations/{temp_id} | 丢弃临时图片和草稿，正文 {} | 终端凭据 |
| POST /v1/mail-results/{check_id}/retry | 重试允许重试的失败联系人，正文 {} | 同用户/终端且已验证确认 |
| DELETE /v1/sessions/current | 结束当前会话，正文 {} | 当前用户令牌 |
| POST /v1/mail/webhooks | SES 通知处理 | SNS 签名与允许的 Topic，非前端接口 |

mail_status：queued/processing/accepted/partially_accepted/failed/unknown/cancelled。联系人状态：queued/sending/accepted/delivered/bounced/failed/unknown/cancelled。accepted 是发送服务已受理，不保证收件箱到达或阅读。unknown 可能已经发送，禁止自动重发。仅未过期且尝试不足 3 次的 failed + MAIL-002 宛先可手动重试；已受理的宛先不再发送。过期的等待记录在发送前取消。

registration_completed 只对 type=registration 计算。type=safety 中该字段为 false，并不表示用户登记失效。退信发生在受理之后不自动撤销 active；界面仍展示 bounced，按业务处理联系人。

## 图片、分数与错误

image_base64 是 JPEG/PNG 纯 Base64，不含 data URL 前缀，解码后最多 512 KiB；不得提交客户端计算的分数、模板或活体标志。返回 metrics.face_confidence、brightness、sharpness；识别时返回 similarity_score 和 match_threshold，范围 0–100，无可用相似度为 null。liveness_passed=false 表示图片模式没有活体证明。

400 输入格式或缺少防重复编号；401 终端/用户会话；403 用户 ID 不符/未确认本人；404 无权限访问或没有记录；409 版本/状态/幂等冲突；410 草稿过期；422 无人脸/多人脸/质量问题；429 冷却或限流；503 AWS/邮件服务配置、资源、身份或权限异常。详细错误码与示例见交接文档。

## 旧接口兼容

旧 POST /v1/enrollments 及其 profile/consent/recipients/face/complete、POST /v1/faces/verify-registration、/v1/users/me/*、/v1/enrollments/{id}/confirmation-mails、/v1/safety-checks* 暂时保留，在 OpenAPI 中 deprecated。旧接口仍按原有拆分流程和手动邮件步骤工作；不能把旧 verify-registration 当成新的自动通知接口。新首页和本地测试页使用上面的最终流程。

可选 Face Liveness 旧入口 POST /v1/faces/liveness-sessions 保留，但最终图片合同无需 Cognito 或视频挑战。避免在同一个操作中混用两种照片处理方式。

数据库仍为 [8 张业务表](../../database/README.md)，无需新增表。发送记录存 safety_checks（check_type=registration/safety），逐联系人结果存 mail_deliveries。数据库只保存加密人脸特征引用，原图不入 PostgreSQL/S3；日志不含照片、姓名、完整邮箱、用户或终端令牌。
