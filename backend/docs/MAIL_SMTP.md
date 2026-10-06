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
FACILITY_NAME=ご利用施設
MAIL_WORKER_ENABLED=true
```

密码含 `#` 或空格时用引号包裹，避免 `.env` 解析截断。SMTP_USER 使用配置文件里的完整邮箱地址，密码无需提供给前端或放入聊天。

端口 587 使用强制 STARTTLS，`SMTP_SECURE=false` 表示连接建立后升级为 TLS，并不允许明文登录。端口 465 则配置 `SMTP_SECURE=true`，连接开始即使用 TLS。证书验证开启，SMTP 协议日志关闭。[Nodemailer SMTP 配置](https://nodemailer.com/smtp)。

可选 `SMTP_REPLY_TO_EMAIL` 设置回复地址。`SERVICE_CONTACT` 设置正文联系方式，留空时引导联系设施工作人员。生产环境已配置的 Secrets Manager JSON 可以额外保存 `SMTP_PASSWORD`，其值优先于环境变量中的密码；普通本地运行只需 `.env`。

`FACILITY_NAME` 设置安否确认正文的设施名称，未填写时使用已确认的「ご利用施設」。管理员页面目前仍为临时文案编辑与示例预览，保存编辑不会修改后端实际邮件模板。

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

## 两种业务邮件

两种邮件均已接入后端业务接口和数据库发送队列，正常流程无需调用测试发信脚本。

| 邮件 | 触发接口与条件 | 收件人及内容 |
| --- | --- | --- |
| 初回注册确认 | `POST /v1/registrations/verify`，本次登记的二次人脸验证通过后自动入队 | 本次登记的 1～2 位联系人；主题 `【安心安否確認】連絡先登録のお知らせ`，正文包括该收件人称呼、登记人姓名、登记时间、服务说明及误登记联系方式 |
| 安否确认 | 已注册用户识别 → `POST /v1/users/{user_id}/recipients` 本人确认 → `POST /v1/safety-notifications` 同意发送 | 该用户的有效联系人；主题 `【安心安否確認】姓名さんからのお知らせ`，正文包括该收件人称呼、操作者姓名、操作时间、设施名称及本人操作的自动邮件说明 |

SMTP 与现有 SES 适配器共用 `backend/src/mail-message.js` 的文案。安否邮件的 `{{送信先名}}`、`{{登録者名}}`、`{{確認日時}}`、`{{施設名}}` 在发送时分别替换为该收件人的解密姓名、登记人的解密姓名、安否操作创建时间和设施配置。注册邮件时间取 `users.created_at`；所有正文时间均按 `terminals.timezone` 显示，数据库继续保存 UTC 时间。正文保留送信专用提示和紧急情况下拨打 119／110 的提示，不包含脸部数据、健康信息或其他联系人信息。

API 提交后由邮件工作进程自动发送，前端结束本次会话不会撤销已同意并入队的邮件；过期、用户停用或撤回同意仍按原有授权检查取消发送。仅拍照、取消注册、人脸不匹配、拒绝本人确认或拒绝发送同意时不触发业务邮件。同一操作的重复提交复用发送记录，已受理的收件人不会重复发送。

集成测试已覆盖两种业务接口经过 SMTP 适配器发送、每位联系人独立收信、模板区分、Message-ID 和受理状态记录、前端结束会话后继续发送及重复提交去重。自动化测试使用隔离数据库和测试传输，不向真实联系人发信。

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

首次测试邮件未送达 Gmail。随后服务器管理员在樱花控制台配置了 `miteken.sakura.ne.jp` 的 SPF 和 DKIM；邮箱账号的 SMTP_PASSWORD 不能替代服务器管理权限。

控制台使用邮箱地址登录时，只能管理邮箱，无法显示“メールドメイン”等域名认证设置。管理员应使用 `miteken.sakura.ne.jp` 和服务器管理员密码登录同一控制台；不要用邮箱密码代替管理员密码。[樱花登录要求](https://help.sakura.ad.jp/mail/2811/)。

本地 API 已重启加载 SMTP 配置，`GET /v1/terminal` 的 `capabilities.mail` 为 `true`。本地验证通过 29 项单元测试、31 项集成测试和前端 TypeScript 检查。

配置后查询到公开 SPF 记录 `v=spf1 a:www3803.sakura.ne.jp mx ~all`，授权服务器 IP `163.43.102.13` 与首次退信里的发送 IP 一致。再次向已确认的测试收件地址发送一封邮件，SMTP 受理后未发现对应退信，用户确认 Gmail 已收到邮件。此次真实投递验证通过；未读取 Gmail 原始邮件头，因此不单独断言 SPF 和 DKIM 的收件端认证结果。

随后 2026-10-05 17:37（东京时间）的业务注册确认邮件在二次验证后正常入队，17:37:46 被 SMTP 受理，但收到 Gmail 的 `550 5.7.30` 永久退信，明确指出 `DKIM = did not pass`。这封业务邮件未投递成功，公开 SPF 记录仍存在；先前一封测试邮件成功收件不能证明 DKIM 配置已通过所有后续投递的验证。需核对控制台 DKIM 选择器、公开密钥记录及实际签名配置。[Gmail 错误码说明](https://support.google.com/mail/answer/3726730?hl=en)。

管理员提供的 DKIM 选择器为 `rs20261005`。本地 DNS 和 Google 公共 DNS（8.8.8.8）均查询到 `rs20261005._domainkey.miteken.sakura.ne.jp` 的 TXT 公开密钥，拼接 TXT 分段后可解析为有效的 RSA 2048 位公钥。这只确认 DNS 公钥已发布，仍需实际收件邮件头或服务器签名日志确认签名域名、选择器、私钥对应关系及验证结果。

SPF 设置入口为“ドメイン/SSL”→目标域名“設定”→“メールドメイン設定”→“SPFレコードの使用”。DKIM 设置入口为“メール”→“メールドメイン”→目标域名“設定”→“DKIM設定”。具体可用选项以账户实际面板为准，初期域名按樱花官方指引处理。[樱花 Gmail 投递说明](https://help.sakura.ad.jp/rs/2861/)、[SPF 设置](https://help.sakura.ad.jp/domain/2306/)、[DKIM 设置](https://help.sakura.ad.jp/mail/2811/)。
