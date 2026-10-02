# 前端联调交接：最终版登记与安否接口

更新日期：2026-10-02。本文对应主目录 `C:\Users\27357\anshin-anpi` 的 main 分支实现；后续开发直接在该目录进行。

## 地址与联调前提

| 用途 | 地址 |
| --- | --- |
| 同事使用的后端基础地址 | `http://192.168.0.51:3002` |
| 本机后端 | `http://127.0.0.1:3002` |
| 就绪检查（公开） | `http://192.168.0.51:3002/health/ready` |
| OpenAPI（公开，可导入 API 工具） | `http://192.168.0.51:3002/openapi.json` |
| 当前登记同意文面（公开） | `http://192.168.0.51:3002/v1/consent-policies?type=registration` |
| 本机摄像头首页 | `http://localhost:5173/` |
| 本机照片上传测试页 | `http://localhost:5173/dev/face` |

192.168.0.51 是开发机局域网地址，地址变更时需更新同事的代理配置。本机前端 5173 仅供本机使用；同事运行自己的前端，通过服务端代理访问以上 3002 后端。

**当前环境限制：** 新接口已用真实 PostgreSQL、注入的测试人脸/邮件服务验证；测试不发送真实邮件。此前检查的是旧地区 `us-east-1`，当时 `anshin-anpi-faces-dev` Collection 不存在、SES 未配置、邮件工作进程关闭。现已改用东京 `ap-northeast-1`，需要以主目录当前配置重新验证对应资源，不能沿用旧地区的检查结果。因此文面接口可直接联调，真实登记、识别、邮件全流程还需恢复 Collection、配置 SES 发件身份和权限，并启用邮件工作进程后重启后端。`/health/ready` 只检查数据库，`capabilities.face/mail` 只表示配置齐全，不保证外部资源可用。不要把健康检查 200 理解为邮件发送成功。

## 流程与状态

临时采集返回 `temp_id`，它用于关联第一张照片，不是正式用户 ID，不创建 users 记录。照片通过检查后只保存在后端加密内存，最长 15 分钟，90 秒无接口操作会失效；返回的 `expires_at` 是最长有效期，不覆盖闲置限制。填写资料期间可每 30 秒调用 `GET /v1/registrations/{temp_id}` 保持草稿，停止操作就停止轮询。后端重启会丢失草稿。

确定登记时一次提交全部资料，返回正式 `user_id` 和 `pending_registration`。第二次照片验证通过，自动创建一批**连络先登记通知**，不需要前端再调用发信接口。查询结果中 `registration_completed=true`、`user_status=active` 才表示登记完成；部分收件人失败则保持 `pending_registration`。日常人脸识别只匹配 active 用户。

业务登记状态只有 `pending_registration → active` 两阶段；临时照片是草稿，邮件另有处理状态。`suspended/deleted` 是后台管理状态，不是正常登记步骤。

第一次邮件主题为 `【安心安否確認】連絡先登録のお知らせ`，告知联系人登记事实、登记人和时间。后续安否邮件主题为 `【安心安否確認】{姓名}さんからのお知らせ`，告知本人本次安否操作。初回不额外发送一封安否邮件。每位联系人单独收信。

## 接口总表

以下路径都接在后端基础地址后。用户令牌来自对应操作返回的 `user_token`，放在 Authorization 请求头中。

| 步骤 | 方法与路径 | JSON 请求 | 成功响应重点 | 用户令牌 |
| --- | --- | --- | --- | --- |
| 注册① 第一次照片 | `POST /v1/registrations/capture` | `image_base64` | 201：`temp_id, face_valid, metrics, expires_at` | 无 |
| 注册② 同意文面 | `GET /v1/consent-policies?type=registration` | 无 | 200：`title, body, policy_version` | 无，公开 |
| 注册③ 确定登记 | `POST /v1/registrations` | `temp_id, display_name, recipients, policy_version, consent_result` | 201：`success, user_id, user_status, user_token, expires_at` | 无 |
| 注册④ 再次验证并自动通知 | `POST /v1/registrations/verify` | `image_base64, user_id` | 200：`matched, metrics, user_status`；匹配时增加 `check_id, mail_status, recipient_results` 和新令牌 | 注册③令牌 |
| 注册⑤ 查邮件结果 | `GET /v1/mail-results/{check_id}` | 无 | 200：各联系人状态、`registration_completed, user_status, mail_status` | 注册④新令牌 |
| 安否① 识别人脸 | `POST /v1/faces/identify` | `image_base64` | 200：`matched, result, metrics`；匹配时增加 `display_name, user_id, user_token, expires_at` | 无 |
| 安否② 本人点“是”并取联系人 | `POST /v1/users/{user_id}/recipients` | `confirmed: true` | 200：`recipients, consent_body, policy_version` | 安否①令牌 |
| 安否③ 同意发送 | `POST /v1/safety-notifications` | `user_id, consent, policy_version` | 202：`check_id, mail_status, recipient_results` | 安否①令牌 |
| 安否结果查询 | `GET /v1/mail-results/{check_id}` | 无 | 200：逐收件人结果 | 安否①令牌 |

辅助接口：`GET/DELETE /v1/registrations/{temp_id}` 查询/取消草稿；`DELETE /v1/sessions/current` 结束会话；`POST /v1/mail-results/{check_id}/retry` 请求重试允许重试的失败收件人（请求体 `{}`）。查询邮件结果始终只读，不触发发送。

## 连接与请求头

除健康检查、OpenAPI、同意文面外，业务接口需要终端认证。浏览器请求自己的同源代理 `/api/terminal/...`，代理转发到后端 `/v1/...` 并添加终端凭据。用户令牌仍由前端放在页面内存，代理透传。

```http
Content-Type: application/json
X-Terminal-Id: <后台配置的终端 UUID>
X-Terminal-Token: <服务端保存的终端凭据>
Idempotency-Key: <本次写操作 UUID>
Authorization: Bearer <本次验证返回的 user_token>
```

- `X-Terminal-*` 留在前端 Node/BFF 服务端；不要放进 React、VITE 变量或浏览器存储。AWS 凭据仅用于后端。
- Authorization 仅在上表标注用户令牌的步骤必需；正式 user_id 不能替代令牌。
- POST、PUT、PATCH、DELETE 都需要 Idempotency-Key，GET 不需要。JSON 字段严格检查，不接收多余字段。
- 一次操作生成一个键；超时/断线重试必须保留**相同键、相同正文、相同原令牌**。新照片使用新键。相同键内容不同返回 409 IDEMPOTENCY_CONFLICT。
- 注册④成功后换用新的 user_token 查询结果；重试注册④原请求仍使用原令牌。避免把新的令牌代入旧请求，否则幂等摘要不同。
- 用户令牌最多有效 3 分钟，闲置 90 秒失效。轮询建议每 2–3 秒，离开页面立即停止并清理个人数据。
- 当前无 Redis，为单后端进程。邮件批次和防重复编号存在 PostgreSQL，重启不重复发信。已提交的注册④可用完整原请求重放恢复查询令牌：`recovered=true`，相似度 `null`（没有持久保存评分），仍是原 `check_id`。其他失效用户会话需要重新识别，草稿不能恢复。

同事的 Vite 前端可以使用内置 proxy（这是同事机器服务端配置；不要复制本项目仅允许回环地址的本地代理用于远程后端）：

```ts
// vite.config.ts。终端凭据从服务端环境读取，不使用 VITE_ 前缀。
import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api/terminal': {
        target: 'http://192.168.0.51:3002',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/terminal/, '/v1'),
        headers: {
          'X-Terminal-Id': process.env.ANSHIN_TERMINAL_ID!,
          'X-Terminal-Token': process.env.ANSHIN_TERMINAL_TOKEN!,
        },
      },
    },
  },
});
```

通过开发机管理员配置一个有效终端及凭据，在同事启动 Vite 的终端中设置这些服务端环境变量即可；凭据通过受控方式交接，不提交 Git。此代理只在本机开发使用，生产需要对应的后端代理。不要跨域访问开发机 5173 的 `/api/terminal`，本项目本地代理会拒绝该访问。

同事先打开公开 health/文面地址：打不开则检查同一局域网、Windows 入站 TCP 3002、后端 `API_HOST=0.0.0.0`；返回 TERMINAL_AUTH_REQUIRED 表示网络已通，需要配置代理凭据。使用同源代理时无需给同事浏览器 Origin 增加后端 CORS 白名单；若浏览器直接调用私有 API，则须匹配 `CORS_ORIGINS` 并提供终端凭据，建议使用前述代理。

## 照片与评分

```json
{ "image_base64": "<JPEG 或 PNG 的纯 Base64>" }
```

不含 `data:image/jpeg;base64,` 前缀；解码后最多 512 KiB。摄像头可以用 canvas.toDataURL('image/jpeg', 0.85).split(',')[1] 获取字节。本项目前端先缩小到最长边 1024，再压缩。图片中只允许一张人脸，检测置信度、亮度、清晰度、姿态由 AWS 检查。

`metrics.similarity_score` 为 0–100 的人脸相似度；没有候选则 null，不能显示成 0 分。第一次采集没有相似度；`face_confidence` 是检测到脸的置信度。`brightness/sharpness` 是照片质量。`match_threshold` 是后端当前匹配门槛（默认 99 分），不由前端指定。图片模式 `liveness_passed=false`，没有活体分数，不要求靠近屏幕做活体挑战，也不需要 Cognito 身份池。

## 注册请求与响应示例

### ① 首次采集

POST /v1/registrations/capture（照片授权应在拍照/上传前完成）：

```json
{ "image_base64": "<第一张照片>" }
```

201：

```json
{
  "face_valid": true,
  "temp_id": "11111111-1111-4111-8111-111111111111",
  "expires_at": "2026-10-02T08:15:00.000Z",
  "idle_timeout_seconds": 90,
  "metrics": { "face_confidence": 100, "brightness": 80, "sharpness": 97, "liveness_passed": false }
}
```

检查失败返回 400/422，不会返回可用于正式登记的 temp_id，也不会创建正式用户。

### ② 获取同意文面

GET /v1/consent-policies?type=registration，200：

```json
{
  "type": "registration",
  "policy_version": "dev-v1",
  "title": "開発確認用同意文面",
  "body": "<当前版本完整正文>",
  "requires_reconsent": false
}
```

正文和版本保存在 `backend/config/consent-policies.json`，不再有 consent_policies 数据表。展示完整正文，登记提交刚展示的版本，不硬编码。正文变更时同步变更版本并重启后端；旧版本提交返回 409 POLICY_VERSION_CHANGED。

### ③ 一次提交登记资料

POST /v1/registrations：

```json
{
  "temp_id": "11111111-1111-4111-8111-111111111111",
  "display_name": "登记人姓名",
  "recipients": [{ "name": "联系人姓名", "email": "contact@example.com" }],
  "policy_version": "dev-v1",
  "consent_result": "granted"
}
```

姓名 1–50 字符；联系人必填 1 人，最多 2 人；联系人邮箱不能重复。姓名和邮箱会规范化。201：

```json
{
  "success": true,
  "user_id": "22222222-2222-4222-8222-222222222222",
  "status": "pending_registration",
  "user_status": "pending_registration",
  "registration_completed": false,
  "user_token": "<登记会话令牌>",
  "expires_at": "2026-10-02T08:03:00.000Z"
}
```

不再分别提交姓名、同意、联系人。拒绝可用 consent_result=denied（仍需完整合法正文），返回 200 success=false、user_id=null、status=cancelled，并清除临时照片。仅取消页面时用 DELETE /v1/registrations/{temp_id}，不需填写资料。

### ④ 第二次照片验证并自动登记通知

POST /v1/registrations/verify，带注册③令牌及本步骤防重复请求编号：

```json
{ "image_base64": "<第二张照片>", "user_id": "22222222-2222-4222-8222-222222222222" }
```

匹配成功 200（示意评分）：

```json
{
  "matched": true,
  "result": "matched",
  "verification_status": "verified",
  "user_id": "22222222-2222-4222-8222-222222222222",
  "user_status": "pending_registration",
  "display_name": "登记人姓名",
  "similarity_score": 99.9,
  "metrics": { "similarity_score": 99.9, "match_threshold": 99, "liveness_passed": false },
  "check_id": "33333333-3333-4333-8333-333333333333",
  "mail_status": "queued",
  "recipient_results": [{ "delivery_id": "44444444-4444-4444-8444-444444444444", "recipient_id": "55555555-5555-4555-8555-555555555555", "status": "queued" }],
  "registration_completed": false,
  "user_token": "<新的查询令牌>",
  "expires_at": "2026-10-02T08:04:00.000Z"
}
```

不匹配也为 200：matched=false、result=no_match、verification_status=not_matched、metrics、user_status 和 attempts_remaining，没有 check_id/新令牌，不发邮件；保留原登记令牌以重新拍照。user_id 与令牌不一致返回 403。邮件服务没配置时匹配流程返回 503，事务回滚，不撤销原令牌，不创建假发送记录。

### ⑤ 查询登记通知

GET /v1/mail-results/{check_id}，带注册④的新令牌。全部受理成功后 200：

```json
{
  "check_id": "33333333-3333-4333-8333-333333333333",
  "type": "registration",
  "status": "accepted",
  "mail_status": "accepted",
  "user_id": "22222222-2222-4222-8222-222222222222",
  "user_status": "active",
  "registration_completed": true,
  "created_at": "2026-10-02T08:01:00.000Z",
  "completed_at": "2026-10-02T08:01:01.000Z",
  "recipient_results": [{ "delivery_id": "44444444-4444-4444-8444-444444444444", "recipient_id": "55555555-5555-4555-8555-555555555555", "status": "accepted", "attempt_count": 1, "error_code": null }]
}
```

实际结果还包含 accepted_at、delivered_at、bounced_at，可为 null。仅查询，不需防重复编号，不能重新请求注册④来查状态。

## 安否请求与响应示例

### ① 识别

POST /v1/faces/identify，正文只有 image_base64。匹配成功返回 matched=true、result=matched、verification_status=verified、display_name、user_id、user_status=active、user_token、expires_at、metrics 和 similarity_score。

没有匹配或候选太接近返回 200 matched=false，result=no_match/ambiguous；不返回姓名、用户 ID 或令牌。不把 HTTP 200 自动当成识别成功。

### ② 本人确认后获取发送对象

POST /v1/users/{识别返回的user_id}/recipients，Authorization 使用安否①令牌：

```json
{ "confirmed": true }
```

200：

```json
{
  "success": true,
  "confirmed": true,
  "user_id": "22222222-2222-4222-8222-222222222222",
  "recipients": [{ "recipient_id": "55555555-5555-4555-8555-555555555555", "name": "联系人姓名", "masked_email": "co•••@example.com", "status": "active" }],
  "consent_body": "<本次发送的同意正文>",
  "policy_version": "dev-v1"
}
```

注意是 **POST**，同时记录本人确认并取发送对象，不是未经确认的 GET。用户点“不是本人”发送 confirmed=false：success=false、recipients=[]、session_ended=true，撤销会话，不发送邮件。

### ③ 同意并发送安否通知

POST /v1/safety-notifications，带安否①令牌和本步骤 Idempotency-Key：

```json
{ "user_id": "22222222-2222-4222-8222-222222222222", "consent": true, "policy_version": "dev-v1" }
```

202：check_id、user_id、status=queued、mail_status=queued、recipient_results。随后 GET /v1/mail-results/{check_id}，type=safety；此时 registration_completed=false 表示这条记录不是登记通知，**不表示用户的登记失效**，用户状态仍为 active。

拒绝发送 consent=false 返回 200 check_id=null、mail_status=cancelled、recipient_results=[]、session_ended=true，不创建发送记录。未先确认本人发送则 403 IDENTITY_CONFIRMATION_REQUIRED。

## 可复用前端调用代码

复制 `anshin-anpi-admin-source/lib/face-api.ts` 与 `lib/face-client.ts`，仅依赖浏览器 API。baseUrl 指向自己的同源代理。下面照片和姓名变量来自用户输入，示例不自动重试整条流程。

```ts
import { createFaceClient } from './face-client';
const api = createFaceClient('/api/terminal');
const captureKey = crypto.randomUUID();
const draft = await api.captureRegistration(firstImageBase64, captureKey);
const policy = await api.registrationPolicy();
// 展示 policy.body，明确同意后：
const registrationKey = crypto.randomUUID();
const registered = await api.register({
  temp_id: draft.temp_id, display_name: inputName,
  recipients: inputRecipients, policy_version: policy.policy_version,
  consent_result: 'granted',
}, registrationKey);
if (!registered.success || !registered.user_id || !registered.user_token) return;
const verificationKey = crypto.randomUUID();
const originalToken = registered.user_token;
const verified = await api.verifyAndNotify(secondImageBase64, registered.user_id, originalToken, verificationKey);
// 重试上一行保留原照片、originalToken、verificationKey；匹配成功后正常查询使用新令牌。
if (verified.matched && verified.check_id && verified.user_token) {
  const result = await api.mailResult(verified.check_id, verified.user_token);
  // UI显示 recipient_results；未完成时继续间隔查询，完成后结束会话。
}
```

```ts
const person = await api.identify(imageBase64, crypto.randomUUID());
if (!person.matched || !person.user_id || !person.user_token) return;
// 用户点击“是”：
const contacts = await api.confirmRecipients(person.user_id, true, person.user_token, crypto.randomUUID());
// 展示 contacts.recipients、consent_body，明确同意后：
const sendKey = crypto.randomUUID();
const sent = await api.notifySafety(person.user_id, true, contacts.policy_version!, person.user_token, sendKey);
if (sent.check_id) await api.mailResult(sent.check_id, person.user_token);
// 离开页面：
await api.endSession(person.user_token);
```

草稿完成前取消用 api.cancelRegistration(temp_id)，资料登记成功后清理当前会话用 api.endSession(user_token)。这些调用也支持固定幂等键。不要把照片、姓名或令牌写入 localStorage。

## 邮件状态与错误

| 字段/值 | 含义与处理 |
| --- | --- |
| mail_status=queued/processing | 等待或处理中，继续查结果，不能显示发送成功 |
| recipient status=queued/sending | 单个收件人等待/发送中 |
| accepted | 邮件服务商已受理，不保证到达收件箱 |
| delivered/bounced | 后续回调报告送达/退信；退信需修正联系人，不会自动撤销已完成登记 |
| partially_accepted | 部分受理；展示逐项状态，登记仍 pending_registration |
| failed | 明确失败；仅 MAIL-002 且期限内、尝试不足 3 次的失败可请求 retry |
| unknown | 可能已发送，等待回调/人工核对，不能自动重发 |
| cancelled | 授权或期限已失效，没有继续发送 |

统一错误：`{ "error": { "code": "...", "message": "...", "request_id": "...", "details": {} } }`，details 可缺省。

| HTTP | 常见 code | 前端处理 |
| --- | --- | --- |
| 400 | VALIDATION_ERROR / INVALID_FACE_IMAGE / IDEMPOTENCY_KEY_REQUIRED | 修正字段、图片格式或请求头 |
| 401 | TERMINAL_AUTH_REQUIRED / TERMINAL_AUTH_FAILED | 检查服务端代理的终端配置 |
| 401 | USER_SESSION_REQUIRED / USER_SESSION_EXPIRED | 重新验证本人，停止使用旧令牌 |
| 403 | USER_ID_MISMATCH / IDENTITY_CONFIRMATION_REQUIRED | 使用识别结果的 ID，先确认本人 |
| 404 | NOT_FOUND | 结果不存在或不属于本次用户/终端 |
| 409 | POLICY_VERSION_CHANGED | 重新获取文面并重新取得同意 |
| 409 | IDEMPOTENCY_CONFLICT / SESSION_ALREADY_USED | 不重复创建邮件；保持原请求重试或查询既有 check_id |
| 410 | TIME-001 | 草稿过期，清理并重新采集 |
| 422 | FACE-001 / FACE-002 / FACE_QUALITY_FAILED | 重拍；展示 error.details 中可用评分 |
| 429 | RATE_LIMITED / FACE-004 | 按 retry_after_seconds/Retry-After 等待，不连续重试 |
| 503 | SERVICE_NOT_CONFIGURED / FACE_SERVICE_UNAVAILABLE / FACE_AUTH_EXPIRED / FACE_ACCESS_DENIED | 服务配置、AWS 资源、身份或权限问题，不降低评分门槛掩盖故障 |

旧 split enrollments、verify-registration、users/me、safety-checks 接口暂时保留兼容，在 OpenAPI 标记 deprecated。新前端只按本文最终接口接入，不混用旧的手动登记发信步骤。
