# AWS 接入配置清单

目前 AWS 资源尚未创建，后端已经预留 SDK 适配和配置项。完成以下配置后，可进行真实脸部识别与邮件的联调；本次没有调用 AWS 创建资源或发送真实邮件。

## 需要提供的信息

| 配置 | 用途 |
| --- | --- |
| `AWS_REGION` | SES、KMS、Secrets Manager 所在 Region |
| `AWS_REKOGNITION_REGION` | 同时支持所需 Rekognition 与 Face Liveness 的 Region；可与其他服务不同 |
| `AWS_REKOGNITION_COLLECTION_ID` | 本应用专用脸部 Collection，不与其他应用共用 |
| `AWS_KMS_KEY_ARN` | 用于个人数据信封加密的对称 KMS 密钥 |
| `AWS_SECRET_ARN` | 包含暂存、查询、审计密钥的 Secrets Manager Secret |
| `AWS_SES_FROM_EMAIL` | 已验证的专用发件地址，例如本域的 no-reply 地址 |
| `AWS_SES_CONFIGURATION_SET` | 用于配信通知的 SES Configuration Set 名称 |
| `AWS_SES_SNS_TOPIC_ARN` | 接收 SES 事件的 SNS Topic ARN |
| AWS CLI Profile 或 IAM Role ARN | 后端调用 AWS 的凭据来源 |
| Cognito Identity Pool ID/前端临时凭据方案 | Face Liveness 前端视频流所需的受限 AWS 凭据 |
| HTTPS API 地址、前端 Origin | SNS 回调与跨域配置 |

同时需要确认 SES 是否仍在沙箱；沙箱内只能发送到验证过的收件人或 SES 模拟邮箱。发件身份和生产访问申请按 [SES 身份验证](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)、[SES 沙箱](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) 配置。

## 建议创建顺序

1. 确定服务 Region 和 AWS 账户。Face Liveness 的 Region 覆盖与一般图像识别可能不同，以 [AWS Face Liveness 入门](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-getting-started.html) 及 [AWS Region/Endpoint 表](https://docs.aws.amazon.com/general/latest/gr/rekognition.html) 为准，不仅凭“离设施最近”选择。
2. 创建一个专用 Rekognition Collection。它保存脸部特征向量，应用数据库保存加密的 Collection/FaceId 引用。[Collection 的存储行为](https://docs.aws.amazon.com/rekognition/latest/dg/collections.html)。
3. 为前端的 Face Liveness 组件配置 Cognito Identity Pool 或受控临时凭据。客户端仅允许完成 `rekognition:StartFaceLivenessSession`，创建会话、读取生体结果、Collection 操作留在后端。前端只向用户 API 交回 session ID，后端自行核验得分和参考图。
4. 验证 SES 发件域名及 DKIM，配置 SPF/DMARC，申请离开沙箱。创建 Configuration Set 和 SNS 事件目标，至少启用 SEND、DELIVERY、BOUNCE、COMPLAINT、REJECT/RENDERING_FAILURE。配置 API 的 `https://<host>/v1/mail/webhooks` 为 HTTPS 订阅端点。后端验证签名及允许的 Topic 后使用 ConfirmSubscription 确认订阅。
5. 创建对称 KMS 密钥和 Secrets Manager Secret，赋予后端角色最小权限。
6. 设置环境变量和生产正式同意文面，在已验证测试收件人/SES 模拟邮箱上验证成功、退信、限流和超时处理，再进行正式用户联调。

## 密钥配置

开发环境 `scripts/backend.ps1 setup` 会生成 32 字节随机密钥，存入 Git 忽略的 `.env`。生产使用 `NODE_ENV=production`、`DATA_ENCRYPTION_MODE=kms`、`AWS_KMS_KEY_ARN` 与 `AWS_SECRET_ARN`。生产模式不允许把个人数据直接用开发本地密钥加密。

Secret 的 JSON 值包含以下三个 base64 编码的 32 字节随机密钥：

```json
{
  "TEMPORARY_ENCRYPTION_KEY": "<base64 32 bytes>",
  "LOOKUP_HMAC_KEY": "<base64 32 bytes>",
  "AUDIT_HMAC_KEY": "<base64 32 bytes>"
}
```

KMS GenerateDataKey 产生数据键，AES-256-GCM 加密内容，数据库只保存密文、nonce、tag 和 KMS 包装过的键，绑定 application/purpose 加密上下文。暂存、HMAC 查询与审计分别使用独立密钥。已有数据的本地/KMS 切换和 HMAC 键轮换需要重加密/重建摘要，不能直接替换环境变量后忽略旧数据。

本机开发可设置 `AWS_PROFILE=<profile>` 并先完成 `aws sso login --profile ...`；SDK 使用默认凭据链。部署到 ECS/EC2/Lambda 等环境时使用运行角色，不在镜像、代码、接口请求或聊天中填写长期 Access Key。

## 后端 IAM 权限范围

| 服务 | 必需操作 | 限制范围 |
| --- | --- | --- |
| Rekognition | `CreateFaceLivenessSession`、`GetFaceLivenessSessionResults`、`DetectFaces` | 使用该账户和指定 Region；这些操作按 AWS 支持的资源权限配置 |
| Rekognition Collection | `IndexFaces`、`SearchFacesByImage`、`DeleteFaces`、`ListFaces` | 仅本应用 Collection ARN |
| SES | `SendEmail` | 已验证发件身份，限制 From 地址；不赋予修改整个账户的权限 |
| SNS | `ConfirmSubscription` | 配信 Topic ARN |
| KMS | `GenerateDataKey`、`Decrypt` | 指定 Key ARN，绑定本应用加密上下文 |
| Secrets Manager | `GetSecretValue` | 指定 Secret ARN；Secret 使用自定义 KMS 时相应允许 Decrypt |

在选定账户、Region 和实际 ARN 后生成最终 IAM Policy；上述表是应用实际调用的操作清单，不把管理资源权限授予运行角色。

## 原图与配信数据

CreateFaceLivenessSession 使用 `AuditImagesLimit=0`，不设置 S3 OutputConfig，参考图由 GetFaceLivenessSessionResults 以 bytes 返回，仅在内存或加密短期 Redis 中处理，不持久化原图。[AWS 生体会话结果](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_GetFaceLivenessSessionResults.html)。AWS 生体会话自身约 3 分钟失效，[会话有效期](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CreateFaceLivenessSession.html)。

SES SDK 的重试设为 1 次调用；应用对明确限流最多重试 2 次，对网络超时等结果未知请求不自动重发。邮件 tag `anshin_delivery_id` 用于把签名通知关联到对应宛先，不放用户姓名、邮箱或脸部数据。SES SendEmail API 没有可供本应用使用的客户端幂等键，[API 结构](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)。

Webhook 校验 SNS 签名、证书 URL、配置 Topic ARN、15 分钟时间窗口和事件 ID，原始 payload 不入库。[SNS 签名要求](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)。延迟过久的通知会拒绝，应配合 AWS 投递重试、告警与人工核对；不能通过关闭签名验证来恢复配信状态。

正式同意文面需明确 AWS 的脸部特征存储、使用 Region、委托处理和删除方式。当前 `dev-v1` 仅用于本地接口验证。
