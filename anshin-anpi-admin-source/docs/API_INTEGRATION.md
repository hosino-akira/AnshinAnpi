# 前端 API 接入指南（最终版）

完整参数、JSON 响应及同事局域网代理配置见 [前端交接文档](../../backend/docs/FRONTEND_FACE_HANDOFF.md)。
后端合同见 [用户端接口](../../backend/docs/USER_API.md)，导入文件为 [OpenAPI](../../backend/docs/openapi.json)。

开发机后端：`http://192.168.0.51:3002`。本机前端：`http://localhost:5173/`，上传图片测试页：`http://localhost:5173/dev/face`。

## 已接入的画面与接口

| 画面 | 操作 | 后端接口 |
| --- | --- | --- |
| SCR-02 | 拍照、质量检查、取得临时 ID | POST /v1/registrations/capture |
| SCR-03/04/05 | 页面内填写姓名、展示同意正文、联系人 | GET /v1/consent-policies?type=registration；字段暂存页面内存 |
| SCR-06 | 确定登记时一次提交所有资料 | POST /v1/registrations |
| SCR-07 | 再拍照，验证通过自动入队登记通知 | POST /v1/registrations/verify |
| SCR-08 | 只查询邮件受理结果 | GET /v1/mail-results/{check_id} |
| SCR-09 | 全部登记邮件受理后显示登记完成 | registration_completed=true、user_status=active |
| SCR-10 | 拍照识别已激活用户 | POST /v1/faces/identify |
| SCR-11 | 点击“是”取得联系人；“不是”撤销会话 | POST /v1/users/{user_id}/recipients，confirmed=true/false |
| SCR-12 | 展示实际联系人及 masked_email | 安否本人确认接口返回的 recipients |
| SCR-13 | 展示发送同意正文并发送 | POST /v1/safety-notifications |
| SCR-14 | 查询实际发送结果 | GET /v1/mail-results/{check_id} |

首页已去掉邮件模拟计时成功、演示姓名和演示联系人，状态以实际返回为准。邮件处理中不会显示已完成；可点击“メール結果を確認する”查询，不会重复发信。评分显示每次后端返回的相似度及照片质量。测试页提供文件上传、二次验证、安否联系人确认/同意发送和结果查询。

## 可复用代码

- `lib/face-api.ts`：fetch、JSON、用户令牌、固定防重复请求编号和错误处理。
- `lib/face-client.ts`：captureRegistration、registrationPolicy、register、verifyAndNotify、identify、confirmRecipients、notifySafety、mailResult、cancelRegistration、endSession。
- `app/page.tsx`：摄像头 canvas 截图、登记/安否画面连接。
- `app/dev/face/page.tsx`：上传文件压缩和接口联调。
- `build/local-terminal-proxy.mjs` 与 `vite.config.ts`：本机 Vite 服务端终端代理。

本机 `.env.local`：

```dotenv
ANSHIN_DEV_FACE_ENABLED=true
ANSHIN_BACKEND_URL=http://127.0.0.1:3002
```

该代理用于本机网页自测，将 /api/terminal/... 转发到本机后端 /v1/...，透传 user_id 请求内容和防重复编号，不读取终端凭据文件。后端统一使用固定机器人，App 不再需要 X-Terminal-Id 或 X-Terminal-Token。Android App 直接访问 http://192.168.0.51:3002/v1/...；本机代理仅接受回环后端和本机同源请求，不能作为远程 App 的入口。生产构建不启用开发代理或测试页。

所有写操作支持显式传入 Idempotency-Key：一次操作固定键；网络失败重试保留相同请求正文、照片与原令牌。不要重试整条注册流程。注册④成功返回的新令牌用于后续查询；原请求重试仍用原登记令牌。后端用户会话最多 15 分钟，5 分钟无相关接口调用失效；屏幕触摸和本地输入不会刷新后端计时。结束时清除页面个人信息。

## 验证和环境限制

运行 `npx tsc --noEmit`、`npm run test:liveness`、`npx vite build`。代理测试不需要终端凭据，不发送真实邮件或人脸。

照片为 JPEG/PNG 纯 Base64，解码后最大 512 KiB；摄像头/测试页缩小到最长边 1024 后压缩。图片模式不检测活体，不需 Cognito。没有候选的评分为 null；HTTP 200 还需检查 matched/result，不能直接当识别成功。

人脸识别使用东京 ap-northeast-1 的 AWS Rekognition，邮件通过樱花 SMTP 发送。SMTP 配置及检查命令见 [后端 SMTP 说明](../../backend/docs/MAIL_SMTP.md)。人脸和邮件需分别验证；接口不会模拟成功。

用户端不使用 Authorization，注册/识别返回 user_id。发送完成页显示请求提交成功，不查询或展示邮件投递、退信或异步失败。
