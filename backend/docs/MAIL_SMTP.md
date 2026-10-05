# SMTP 邮件接入

后端已使用 Nodemailer 通过 SMTP 发送登记通知和安否通知。根据提供的 `mail.mobileconfig`，当前设置为樱花邮箱；邮件不使用 AWS SES，脸部识别仍使用 AWS Rekognition。

## 本地配置

根目录 `.env` 是 Git 忽略文件：

```dotenv
SMTP_HOST=miteken.sakura.ne.jp
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=anshin@miteken.sakura.ne.jp
SMTP_PASSWORD=填写邮箱密码
SMTP_FROM_EMAIL=anshin@miteken.sakura.ne.jp
SMTP_REPLY_TO_EMAIL=
SERVICE_CONTACT=
MAIL_WORKER_ENABLED=true
```

密码含 `#` 或空格时用引号包裹，避免 `.env` 解析截断。SMTP_USER 使用配置文件里的完整邮箱地址，密码无需提供给前端或放入聊天。

端口 587 使用强制 STARTTLS，`SMTP_SECURE=false` 表示连接建立后升级为 TLS，并不允许明文登录。端口 465 则配置 `SMTP_SECURE=true`，连接开始即使用 TLS。证书验证开启，SMTP 协议日志关闭。[Nodemailer SMTP 配置](https://nodemailer.com/smtp)。

可选 `SMTP_REPLY_TO_EMAIL` 设置回复地址。`SERVICE_CONTACT` 设置正文联系方式，留空时引导联系设施工作人员。生产环境已配置的 Secrets Manager JSON 可以额外保存 `SMTP_PASSWORD`，其值优先于环境变量中的密码；普通本地运行只需 `.env`。

## 检查和测试邮件

在 `backend` 目录运行：

```powershell
# 仅建立加密连接并登录，不发送邮件
npm run check:smtp

# 明确发送一封测试邮件到指定收件人
node scripts/check-smtp.js --send-to anshin@miteken.sakura.ne.jp
```

检查成功返回 `status: ok`、`tls: true`、`authenticated: true`。测试主题为“【安心安否確認】SMTP 接続テスト”，不包含真实用户信息。发送成功返回 accepted 与 Message-ID，不创建业务记录。连接检查只证明连接和认证成功，真实收件仍需查看测试邮箱。

## 启动和业务结果

修改环境配置后重启 API。SMTP 运行不需要 AWS 邮件权限，Docker 通过原有 `env_file: .env` 读取配置。脸部识别仍需本地 AWS Profile，所以本机 Docker 同时使用原有 AWS 登录覆盖文件：

```powershell
docker compose -f compose.yaml -f compose.aws-local.yaml up -d --build --wait api
```

主机运行可在 `backend` 目录执行 `npm start`。邮件工作进程默认启用；运行环境中 `MAIL_WORKER_ENABLED=false` 会关闭它。

二次登记验证成功后自动入队登记通知。每个收件人分别发送一封邮件，不使用 Cc/Bcc；所有登记通知都被 SMTP 服务器接受后激活用户。日常安否通知需要识别、本人确认及发送同意。SMTP 服务器受理后保存 accepted 与 Message-ID，用户端显示“送信受付完了”。后台结果通过 `GET /v1/mail-results/{check_id}?user_id={user_id}` 查询。

SMTP 受理不等于收件箱投递或阅读成功。当前不接入 SMTP 退信邮箱、DSN 或第三方配信回调，SNS 邮件回调在 SMTP 运行时返回未配置，不能用于更新 SMTP 记录。

## 失败和重复发送

| 错误 | 结果及处理 |
| --- | --- |
| 配置缺失 `MAIL_CONFIG_REQUIRED` | 不连接、不发送 |
| 密码或认证错误 `MAIL_AUTH_REQUIRED` | failed，不自动重试 |
| TLS 错误 `MAIL_TLS_FAILED` | failed，不降级为明文 |
| SMTP 5xx 拒绝 `MAIL-001` | failed，不自动重试 |
| SMTP 4xx 或明确连接前失败 `MAIL-002` | 有效发送时间内最多追加两次尝试 |
| DATA 阶段超时或连接中断 `MAIL_RESULT_UNKNOWN` | unknown，不自动重发，需人工核对 |

Message-ID 包含内部 delivery_id，不包含用户姓名或收件地址；明确允许的重试保持该 ID。SMTP 没有通用幂等保证，相同 Message-ID 本身不保证服务器去重，因此 unknown 不重发。队列只处理当前 SMTP provider 的记录，历史其他 provider 的待发送记录不会切换通道自动发出。

本地自动化测试包括 SMTP 协议/MIME、单宛先发送、登记激活、认证失败、临时拒绝和未知结果处理；测试不会向真实收件人发信。

## 本次 Gmail 投递检查

2026-10-05 的真实连接检查已通过 TLS 和账号认证，测试邮件也被樱花 SMTP 受理。随后收到 Gmail 的 `550 5.7.26` 退信，认证结果为：

```text
DKIM = did not pass
SPF [miteken.sakura.ne.jp] = did not pass
```

这封测试邮件未送达 Gmail。需要服务器管理员在樱花控制台修复 `miteken.sakura.ne.jp` 的 SPF 或 DKIM 认证，再测试真实收件。邮箱账号的 SMTP_PASSWORD 不能替代服务器管理权限。

控制台使用邮箱地址登录时，只能管理邮箱，无法显示“メールドメイン”等域名认证设置。管理员应使用 `miteken.sakura.ne.jp` 和服务器管理员密码登录同一控制台；不要用邮箱密码代替管理员密码。[樱花登录要求](https://help.sakura.ad.jp/mail/2811/)。

本地 API 已重启加载 SMTP 配置，`GET /v1/terminal` 的 `capabilities.mail` 为 `true`。本地验证通过 29 项单元测试、31 项集成测试和前端 TypeScript 检查；这些结果不代表 Gmail 投递已修复。

SPF 设置入口为“ドメイン/SSL”→目标域名“設定”→“メールドメイン設定”→“SPFレコードの使用”。DKIM 设置入口为“メール”→“メールドメイン”→目标域名“設定”→“DKIM設定”。具体可用选项以账户实际面板为准，初期域名按樱花官方指引处理。[樱花 Gmail 投递说明](https://help.sakura.ad.jp/rs/2861/)、[SPF 设置](https://help.sakura.ad.jp/domain/2306/)、[DKIM 设置](https://help.sakura.ad.jp/mail/2811/)。
