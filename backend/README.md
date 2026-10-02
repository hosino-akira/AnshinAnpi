# Node.js 用户端后端

使用 Node.js 22+、Fastify、PostgreSQL 和 Redis，实现开发规格书第 4～11 章的用户端接口。AWS 接入采用 SDK v3：Rekognition 负责生体检测和脸部识别、SES 负责单宛先邮件、KMS 负责持久化个人数据加密，Secrets Manager 管理生产环境密钥。

## 本地启动

在项目根目录运行：

```powershell
.\scripts\backend.ps1 -Action start
```

该命令补齐 `.env` 中的本地随机密钥、启动 PostgreSQL 和无持久化 Redis、应用迁移、构建并启动 API。地址为 `http://localhost:3001`，可通过 `/health/ready` 检查数据库连接，通过 `/openapi.json` 获取 OpenAPI 文档。Redis 关闭 RDB/AOF，数据目录使用内存文件系统，重启后临时登记失效。

需要本地终端及开发同意文面时，在 `backend` 目录运行：

```powershell
npm ci
npm run provision:dev
```

终端凭据保存在 Git 忽略的 `backend/.local-terminal.json`，不打印到日志。这项命令只允许开发环境；开发同意文面明确标记为测试用途。它不会创建正式用户或发送邮件。

开发时也可以在 PostgreSQL、Redis 已启动后运行 `npm run dev`。配置从项目根目录 `.env` 加载，既有环境变量优先。Docker 使用 `postgres:5432` 和 `redis:6379`，主机运行 Node 使用 `localhost:5433` 和 `localhost:6380`。

AWS 资源尚未配置时，普通数据与文面接口可以调用；需要识别或发信的接口会返回 `503 SERVICE_NOT_CONFIGURED`，不会模拟成功。测试提供的替代服务只能通过测试代码注入，运行服务器没有 HTTP/环境变量开关来接受伪造生体判定。

## 接口约定

详细合同参阅 [用户端接口文档](docs/USER_API.md)；机器可读合同为 [OpenAPI](docs/openapi.json)。修改请求格式后运行 `npm run docs:generate` 更新导入文件，在线 `/openapi.json` 始终从当前定义生成。

所有业务接口使用 `X-Terminal-Id` 和 `X-Terminal-Token` 认证。识别成功后返回短期 `user_token`，后续本人操作使用 `Authorization: Bearer ...`，服务端校验所属终端、用户状态、用途、本人确认和超时。POST、PATCH、PUT、DELETE 必须提供 `Idempotency-Key`；邮件回调除外。

发送接口返回 `202 queued`，前端轮询发送结果。`queued`/`sending` 不是成功；`accepted` 才表示服务商已接受。`unknown` 表示外部请求可能已成功，需要回调或工作人员核对，不能自动重发。

初次登记确认、姓名确认、实时生体检测、服务端阈值、同意版本及联系人有效状态均在后端检查。姓名、联系人姓名、邮箱和 Rekognition 引用使用认证加密保存；同意前的数据只进入加密的临时 Redis，最长 15 分钟，90 秒无操作失效。临时 Redis 使用单独本地 AES 密钥，生产配置从 Secrets Manager 读取。

Rekognition 不导出原始特征向量；数据库 `face_templates.template_format='provider_reference'` 时保存加密的 Collection/FaceId 引用，真正的特征由 AWS Collection 管理。原图不写入 PostgreSQL 或 S3。用户暂停、注销或脸部模板删除会生成外部特征清理任务，后台定期重试；登记云调用与数据库提交间的异常由短期租约及 Collection 对账处理。Collection 应专用于本应用。

## AWS 接入信息

需要创建或提供以下信息，具体步骤见 [AWS 配置清单](docs/AWS_SETUP.md)：

- AWS 账户与 Region；本机 AWS CLI Profile 名称，或部署时的 IAM Role ARN。
- Rekognition Collection ID、支持 Face Liveness 的 Region，以及前端使用的 Cognito Identity Pool ID/受控临时凭据来源。
- SES 已验证的发件地址或域名、沙箱状态、Configuration Set、SNS Topic ARN。
- KMS 对称密钥 ARN、Secrets Manager Secret ARN。
- 对外 HTTPS API 地址与允许访问的前端 Origin，供 SNS 回调和跨域配置使用。

Access Key/Secret Key 不需要发送到聊天。SDK 使用默认凭据链读取本机 Profile，云上优先使用 IAM Role。Docker 不自动挂载主机 `.aws`；本地需要调用 AWS 时可在主机运行 Node，或按部署环境提供受控凭据。

## 验证

```powershell
# backend 目录：密码学、输入规则、SNS 签名及 AWS 适配层单元测试
npm test

# 项目根目录：自动创建、迁移、删除独立测试库；使用真实 PostgreSQL/Redis
.\scripts\test-backend-integration.ps1
```

集成测试覆盖完整登记及安否操作、重复发送竞争、跨用户/终端访问、不同意数据清除、失败或近似候选不显示姓名、短期令牌、回调去重与未知结果恢复。脸部与邮件服务使用测试替代实现，不访问 AWS 或发送真实邮件。

`npm run verify:audit` 检查当前保留审计记录的 HMAC 链。日志签名已实现，但生产的外部链头锚定、历史签名密钥轮换及归档需按运维方案配置。

## 当前范围

本次完成用户端 API、邮件队列消费、AWS 适配、数据库迁移与接口文档。现有 React 页面仍是展示用模拟流程，接入时按接口文档替换 `runProcessing()` 并接入 Face Liveness 专用组件。管理端 API、正式认证服务、部署至 AWS、个人数据保留期限的定期物理删除、备份轮转和生产同意文面审批不属于本次用户接口实现。
