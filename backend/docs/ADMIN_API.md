# 管理端：单管理员 + 邮箱和密码

管理端与用户端共用现有 Node.js 后端及 PostgreSQL 八张业务表。管理配置只有 `app_meta.administrator`（数据库约束保证仅一行）和 `app_meta.admin_settings` 两张辅助表，不增加角色管理、独立数据库或 Redis。

## 已初始化的本地账号

- 邮箱：`admin@anshin-anpi.jp`
- 名称：`安心施設 管理者`
- 初始随机密码在 Git 忽略的 `backend/.admin-setup.json` 中，初始化工具不向日志打印凭据。
- 使用邮箱和密码登录；将密码存入密码管理器后删除初始化文件。按项目所有者的最新要求，不启用多因素认证，原 XLSX 式样书保持不变。

新环境先应用数据库迁移，再运行 `npm run provision:admin`。已有账号不会被覆盖。丢失密码时，在有权访问服务器的本地终端运行 `npm run provision:admin -- --reset`；这会生成新的密码、撤销全部旧会话并记录审计。不提供公网找回接口。

## 启动与接入

在 `backend` 运行 `npm start`。本地管理前端在 `anshin-anpi-admin-source` 运行 `npm run dev`，然后打开 `/admin`。前端的 `ANSHIN_BACKEND_URL` 默认 `http://127.0.0.1:3002`，必须与实际 API 监听地址一致。现有根 `.env` 可继续使用；数据库升级使用 `scripts/database.ps1 -Action migrate`。

浏览器访问同源 `/api/admin/*`，代理至后端 `/v1/admin/*`。开发代理只允许本机地址；后端 `CORS_ORIGINS` 必须包含实际前端 Origin（含端口）。已构建的 Cloudflare Worker 支持环境绑定 `ANSHIN_BACKEND_URL`；线上需要可访问的 HTTPS 后端地址，并把站点 Origin 加入后端 `CORS_ORIGINS`。当前临时站点尚未发布这些更改，也没有替它配置线上后端。

会话仅在单后端进程内加密保存，重启后重新登录。Cookie 为 HttpOnly、SameSite=Strict，生产模式加 Secure；15 分钟无操作失效，最长 8 小时。密码使用随机盐 scrypt。连续 5 次登录失败锁定 5 分钟，锁定状态保存在数据库，重启不清除。管理请求不进入本地原始请求日志。

## API

`POST /login` 请求 `{email,password}`，响应 `{admin,csrf_token}` 并设置 Cookie。`GET /session` 可在刷新页面后取得会话及 CSRF 令牌。以下路径均以 `/v1/admin` 开头，全部要求管理员 Cookie；所有写操作还要求 `X-CSRF-Token` 和 `Idempotency-Key`。

| 接口 | 用途 |
|---|---|
| POST `/logout` | 撤销会话并清 Cookie |
| PUT `/profile` | 修改名称、邮箱或密码；再次校验当前密码，保存后所有会话失效 |
| GET `/dashboard` | 真实登记数、联系人数量、东京时区当日统计、邮件错误和近期操作 |
| GET `/users?limit=200&offset=0` | 分页读取登记者及联系人；不返回照片或脸部特征 |
| POST `/users/search` | 姓名完全一致搜索，必须记录用途 reason |
| PUT `/users/{id}` | 修改姓名、联系人、停用；确认本人身份并检查数据版本 |
| DELETE `/users/{id}` | 记录单管理员删除申请、停用、擦除姓名/邮箱与投递快照；保留审计证据 |
| DELETE `/users/{id}/recipients/{recipientId}` | 删除联系人；最后一个有效联系人删除后自动停用用户 |
| POST `/users/{id}/face` | 已停用用户在本人立会并同意后重新登记，恢复使用 |
| POST `/users/{id}/consent` | 本人在场确认最新登记文面，记录新的同意履历 |
| GET `/settings` | 当前邮件模板、两种同意文面及历史版本 |
| PUT `/mail-template` | 保存安否邮件标题、正文；现有发送工作进程实时读取 |
| POST `/policies/{registration或safety}` | 保存新版本和适用日期，不覆盖旧版本；按东京日期自动生效 |
| GET `/audit-logs` | 按时间、目标、游标分页查看日志，不提供下载 |

字段和校验以 `openapi.json` 为准。记录用途仅允许 `support/correction/suspension/deletion/audit`，不会把姓名或任意备注加入审计。管理员操作、查询日志及拒绝的已认证操作均进入现有 HMAC 审计链。

## 数据联动

- 修改使用中登记者的联系人邮箱或添加联系人时，变更和确认邮件入队在同一个数据库事务完成。SMTP 未配置会拒绝该修改，不伪装成已通知。暂停或未完成登记的用户不会因修改联系人而发送通知。
- 联系人变更取消旧宛先待发邮件，清除历史邮箱快照，避免按过期资料发送。通知使用现有 `safety_checks` / `mail_deliveries`，增加 `contact_change` 类型，没有第二套队列。
- 使用停止、删除或请求脸部重登会即时撤销识别资格，取消待发邮件。暂停后恢复使用需要本人立会重新登记脸部；不恢复已经撤销的云端特征。
- 脸部重登沿用现有照片识别模式，检查图片质量和重复登记；不会声称通过活体检测。照片只在请求内存中处理，不保存原图；管理端使用通用头像。
- 删除时马上清除业务姓名、邮箱及投递快照。AWS 特征由现有清理工作进程删除，30 天到期且外部特征清理成功后才物理删除用户行。必须保持邮件工作进程启用；若外部清理失败，保留清理引用供重试。
- 同意文面发布必须使用新版本号，不允许过去日期。重要登记文面变化要求重新同意后才能安否发信；管理页面提供本人在场的再同意入口。未来文面保存后可在版本履历查看，用户端在适用日前仍取得原版本。
- 并发修改使用数据库行锁和完整时间戳 `revision`，旧页面保存返回 `409 ADMIN_REVISION_CHANGED`。管理操作的成功响应加密缓存 15 分钟；重启后版本检查及邮件唯一约束阻止重复变更通知。

## 验证

`npm test` 覆盖密码、Cookie 和接口权限合同；根目录 `scripts/test-backend-integration.ps1` 使用独立测试库验证管理端和用户端的完整流程，不访问 AWS 或发送真实邮件。前端 `tests/admin-proxy.test.mjs` 验证 Cookie/CSRF 转发及跨站拒绝。`npm run verify:audit` 同时验证原有记录与新增管理记录。

本次验证：后端单元测试 40/40、独立数据库集成测试 46/46、管理及用户代理测试 8/8；前端类型检查、修改文件的静态检查及生产构建通过。实际本地数据库经同源代理验证密码登录、五类读取接口、退出和旧会话拒绝，未发送真实邮件。前端全量测试另有两项模板断言失败：主页缺少 `codex-preview` 元数据，构建 CSS 缺少模板预期的滚动工具样式；对应主页布局、全局样式和原测试文件未在本次修改。
