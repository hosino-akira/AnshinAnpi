# Node.js 用户端后端

使用 Node.js 22+、Fastify、PostgreSQL，实现开发规格书第 4～11 章的用户端接口。邮件使用 SMTP/Nodemailer 单宛先发送；AWS SDK v3 的 Rekognition 负责生体检测和脸部识别，KMS 负责持久化个人数据加密，Secrets Manager 管理生产环境密钥。

## 本地启动

在项目根目录运行：

```powershell
.\scripts\backend.ps1 -Action start
```

该命令补齐 `.env` 中的本地随机密钥、启动 PostgreSQL、应用迁移、构建并启动 API。地址为 `http://localhost:3001`，可通过 `/health/ready` 检查数据库连接，通过 `/openapi.json` 获取 OpenAPI 文档。临时数据保存在单个后端进程的内存中，后端重启后未完成登记失效。

如果 Docker Desktop 启动时报 `could not find redis: not found`，旧 API 容器仍保留移除 Redis 前的依赖信息。在项目根目录运行以下命令，按当前配置重新构建和创建服务；PostgreSQL 数据卷会保留：

```powershell
docker compose up -d --build --wait
```

`docker compose start` 只启动已有容器，不会更新容器配置或应用代码，因此升级后应使用 `up`。

首次安装依赖，或检查固定机器人记录时，在 `backend` 目录运行：

```powershell
npm ci
npm run provision:dev
```

后端在启动时自动初始化固定机器人记录，复用已有 LOCAL-DEV-01 的终端 UUID，保留历史关联；空库使用代码内固定 UUID。App 无需终端凭据文件。provision:dev 只用于开发环境检查和初始化该记录，不再签发 Token。

开发时也可以在 PostgreSQL 已启动后运行 `npm run dev`。配置从项目根目录 `.env` 加载，既有环境变量优先。Docker 使用 `postgres:5432` ，主机运行 Node 使用 `localhost:5433` 。

AWS 资源尚未配置时，普通数据与文面接口可以调用；需要识别或发信的接口会返回 `503 SERVICE_NOT_CONFIGURED`，不会模拟成功。测试提供的替代服务只能通过测试代码注入，运行服务器没有 HTTP/环境变量开关来接受伪造生体判定。

## 接口约定

详细合同参阅 [用户端接口文档](docs/USER_API.md)；机器可读合同为 [OpenAPI](docs/openapi.json)。修改请求格式后运行 `npm run docs:generate` 更新导入文件，在线 `/openapi.json` 始终从当前定义生成。

最终流程及可复制请求见 [前端调用交接](docs/FRONTEND_FACE_HANDOFF.md)。主机联调地址为 `http://192.168.0.51:3002`，当前工作树的 Node API 使用 3002；上面的 Docker 启动端口依实际配置。新版登记使用 capture → 一次 register → verify 自动入队登记通知 → GET mail-results。全部邮件受理后才激活用户。安否使用 identify → 本人确认并获取遮蔽联系人 → safety-notifications → GET mail-results。旧拆分接口保留兼容，OpenAPI 已标记弃用。

当前为单机器人模式，业务接口不再要求或使用 `X-Terminal-Id`、`X-Terminal-Token`。任何能够访问 API 的客户端均归属固定机器人，设备身份不再验证。注册或识别成功后返回 user_id，后续直接传该 ID，不使用 Authorization 或用户令牌。后端保留人脸验证记录、本人确认和有效期。POST、PATCH、PUT、DELETE 必须提供 `Idempotency-Key`；邮件回调除外。

发送接口返回 `202 queued`，前端轮询发送结果。`queued`/`sending` 不是成功；`accepted` 才表示服务商已接受。`unknown` 表示外部请求可能已成功，需要回调或工作人员核对，不能自动重发。

初次登记验证、本人确认、服务端阈值、同意版本及联系人有效状态均在后端检查。当前图片流程不进行活体检测，返回 liveness_passed=false；可选活体旧接口另行保留。姓名、联系人姓名、邮箱和 Rekognition 引用使用认证加密保存；正式登记前的数据只进入加密的临时内存，最长 15 分钟，90 秒无操作失效。临时内存使用单独本地 AES 密钥，生产配置从 Secrets Manager 读取。

Rekognition 不导出原始特征向量；数据库 `face_templates.encrypted_template` 保存加密的 Collection/FaceId 引用，真正的特征由 AWS Collection 管理。原图不写入 PostgreSQL 或 S3。用户暂停或注销会将模板标记 revoked；邮件工作进程在现有 face_templates 表中读取待清理引用，清除 AWS 特征后标记 deleted。取消或失败的登记尝试立即清理云端引用，不再使用独立清理队列和租约。Collection 应专用于本应用。

## Docker 本地 AWS 登录凭据

本机的 `anshin-dev` 使用 AWS CLI 的 `aws login` 短期登录。普通 Compose 不会读取主机 AWS Profile。完成本机登录后，在项目根目录使用本地覆盖配置启动 API：

```powershell
docker compose -f compose.yaml -f compose.aws-local.yaml up -d --no-deps --force-recreate api
```

覆盖配置将当前 Windows 用户的 `.aws/config` 只读挂载到容器，并挂载 `.aws/login/cache` 供 SDK 读取和更新短期登录缓存。缓存必须可写，否则自动刷新无法保存。SDK 根据 `.env` 的 `AWS_PROFILE` 选择 Profile；服务地区仍由 `.env` 的 AWS_REGION / AWS_REKOGNITION_REGION 决定。凭据不复制到镜像，也不写入仓库或浏览器。

需要 AWS 时，后续重建 API 继续带这两个 `-f` 参数；只使用普通 `docker compose up` 或 backend.ps1 start 会恢复基础配置，移除凭据挂载。登录会话到期后需要重新登录；容器凭据成功不代表 Collection 或邮件权限已经配置完成。本地覆盖配置仅用于开发，云部署使用运行角色。
## AWS 接入信息

SMTP 服务器、邮箱密码、TLS 检查及测试发信命令见 [SMTP 邮件接入](docs/MAIL_SMTP.md)。当前使用樱花邮箱 SMTP，不需要 AWS SES 身份或发送权限。

本机配置 `AWS_PROFILE`、`AWS_REGION`、`AWS_REKOGNITION_REGION` 和
`AWS_REKOGNITION_COLLECTION_ID` 后，在 `backend` 目录执行：

```powershell
# 只读查询 Collection，验证后端 SDK 凭据和连接
npm run check:rekognition
# 创建一个真实活体会话，经固定机器人上下文、API 路由及进程内存，并验证幂等重试
npm run check:rekognition:liveness
```

第二项需要访问 PostgreSQL；API 自动使用固定机器人，无需终端凭据。
它通过 Fastify 的请求注入执行现有接口，不要求先监听 HTTP 端口；不会拍摄、
注册人脸或发送邮件。一次 AWS 会话会自然过期，AWS 凭据和会话 ID 不打印。
通过该检查只表示会话创建成功，摄像头挑战和活体结果仍需前端联调。

主机运行 `npm start` 可读取本机 AWS Profile。已有 Docker API 占用 3001 时，
当前工作树可使用 `API_PORT=3002`；专门验证人脸接口时设置
`MAIL_WORKER_ENABLED=false`，关闭该进程的邮件和人脸维护任务。

需要创建或提供以下信息，具体步骤见 [AWS 配置清单](docs/AWS_SETUP.md)：

- AWS 账户与 Region；本机 AWS CLI Profile 名称，或部署时的 IAM Role ARN。
- Rekognition Collection ID、支持 Face Liveness 的 Region，以及前端使用的 Cognito Identity Pool ID/受控临时凭据来源。
- SMTP 主机、端口、TLS 模式、用户名、密码和发件地址。
- KMS 对称密钥 ARN、Secrets Manager Secret ARN。
- 对外 HTTPS API 地址与允许访问的前端 Origin，供跨域配置使用。

Access Key/Secret Key 不需要发送到聊天。SDK 使用默认凭据链读取本机 Profile，云上优先使用 IAM Role。Docker 不自动挂载主机 `.aws`；本地需要调用 AWS 时可在主机运行 Node，或按部署环境提供受控凭据。

## 验证

### 本地接口联调日志

在根目录 `.env` 设置 `API_DEBUG_LOG_ENABLED=true` 并重启 API。每次业务请求的原始参数（校验前）、响应、HTTP 状态、耗时、请求编号和评分同时写入终端及 `backend/logs/api-requests.jsonl`。根目录运行 `.\scripts\watch-api-log.ps1` 可实时查看格式化记录。不依赖前端开发者工具。

照片 Base64 替换为长度、解码大小及是否包含 data URL 前缀；认证令牌和密码隐藏。其他业务字段仅用于本地联调，生产环境强制关闭。日志不进入 Git；达到 10 MiB 时轮转到 `.jsonl.1`，保留最近两份。健康检查、OpenAPI 和原始邮件回调不记录。

照片评分包括 `face_confidence`、`brightness`、`sharpness`、`yaw`、`pitch`、`roll`；质量失败时附带 `failed_checks` 和门槛。照片采集没有人脸相似度，二次比对和识别时查看 `similarity_score`。参数错误返回 `validation_errors`，指出出错字段及校验类型，不包含原始照片或密钥。关闭联调日志使用 `API_DEBUG_LOG_ENABLED=false` 后重启。

```powershell
# backend 目录：密码学、输入规则、SNS 签名及 AWS 适配层单元测试
npm test

# 项目根目录：自动创建、迁移、删除独立测试库；使用真实 PostgreSQL
.\scripts\test-backend-integration.ps1
```

集成测试覆盖完整登记及安否操作、重复发送竞争、跨用户/终端访问、不同意数据清除、失败或近似候选不显示姓名、短期令牌、回调去重与未知结果恢复。脸部与邮件服务使用测试替代实现，不访问 AWS 或发送真实邮件。

`npm run verify:audit` 检查当前保留审计记录的 HMAC 链。日志签名已实现，但生产的外部链头锚定、历史签名密钥轮换及归档需按运维方案配置。

## 当前范围

本次完成用户端 API、邮件队列消费、AWS 适配、数据库迁移与接口文档。本地 React 主页面及 `/dev/face` 已接入图片登记和识别，邮件界面尚未完成正式联调。管理端 API、正式认证服务、部署至 AWS、个人数据保留期限的定期物理删除、备份轮转和生产同意文面审批不属于本次用户接口实现。

数据库按式样书第 10.1 节收敛为 8 张业务表，见 [数据库说明](../database/README.md)。同意文面及版本存放在 `config/consent-policies.json`。无需安装 Redis 或配置 Redis 密码。

用户端接受发送请求后只显示提交成功，不轮询投递结果。邮件实际处理状态保留在后端，管理端之后单独对接。
