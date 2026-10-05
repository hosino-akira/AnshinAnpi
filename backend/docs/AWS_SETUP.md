# AWS 接入配置清单

后端已经提供 AWS SDK 适配和配置项。Rekognition、前端活体凭据和生产加密资源分别配置与验证。邮件采用樱花 SMTP，配置见 [SMTP 邮件接入](MAIL_SMTP.md)，不需要 AWS SES 或 SNS 邮件权限。

此前对旧美国地区的复查：Profile `anshin-dev`、Region `us-east-1` 能调用 AWS，
但 `anshin-anpi-faces-dev` 的查询返回 `ResourceNotFoundException`（HTTP 400），
当时该 Collection 不存在。现改用东京 `ap-northeast-1`，应以主目录当前配置重新检查东京资源；旧地区记录不代表东京状态。
最终登记验证成功后会自动入队登记通知，完整测试需配置 SMTP、启用邮件工作进程并重启后端。
只读复核命令为 `npm run check:rekognition`。图片模式不需要前端 Cognito 或活体视频；
`npm run check:rekognition:liveness` 仅用于保留的可选活体流程。

## 需要提供的信息

| 配置 | 用途 |
| --- | --- |
| `AWS_REGION` | KMS、Secrets Manager 所在 Region |
| `AWS_REKOGNITION_REGION` | 同时支持所需 Rekognition 与 Face Liveness 的 Region；可与其他服务不同 |
| `AWS_REKOGNITION_COLLECTION_ID` | 本应用专用脸部 Collection，不与其他应用共用 |
| `AWS_KMS_KEY_ARN` | 用于个人数据信封加密的对称 KMS 密钥 |
| `AWS_SECRET_ARN` | 包含暂存、查询、审计密钥的 Secrets Manager Secret |
| AWS CLI Profile 或 IAM Role ARN | 后端调用 AWS 的凭据来源 |
| Cognito Identity Pool ID/前端临时凭据方案 | Face Liveness 前端视频流所需的受限 AWS 凭据 |
| HTTPS API 地址、前端 Origin | 跨域配置 |

SMTP 邮箱使用服务商提供的账号认证，与 AWS Region 和 SES 沙箱无关。

## 建议创建顺序

1. 确定服务 Region 和 AWS 账户。Face Liveness 的 Region 覆盖与一般图像识别可能不同，以 [AWS Face Liveness 入门](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-getting-started.html) 及 [AWS Region/Endpoint 表](https://docs.aws.amazon.com/general/latest/gr/rekognition.html) 为准，不仅凭“离设施最近”选择。
2. 创建一个专用 Rekognition Collection。它保存脸部特征向量，应用数据库保存加密的 Collection/FaceId 引用。[Collection 的存储行为](https://docs.aws.amazon.com/rekognition/latest/dg/collections.html)。
3. 为前端的 Face Liveness 组件配置 Cognito Identity Pool 或受控临时凭据。客户端仅允许完成 `rekognition:StartFaceLivenessSession`，创建会话、读取生体结果、Collection 操作留在后端。前端只向用户 API 交回 session ID，后端自行核验得分和参考图。
4. 配置 SMTP 并执行 `npm run check:smtp`，验证加密连接和邮箱认证。
5. 创建对称 KMS 密钥和 Secrets Manager Secret，赋予后端角色最小权限。
6. 设置环境变量和生产正式同意文面，在指定测试邮箱验证实际收件，再进行正式用户联调。

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
| KMS | `GenerateDataKey`、`Decrypt` | 指定 Key ARN，绑定本应用加密上下文 |
| Secrets Manager | `GetSecretValue` | 指定 Secret ARN；Secret 使用自定义 KMS 时相应允许 Decrypt |

在选定账户、Region 和实际 ARN 后生成最终 IAM Policy；上述表是应用实际调用的操作清单，不把管理资源权限授予运行角色。

## 原图与配信数据

CreateFaceLivenessSession 使用 `AuditImagesLimit=0`，不设置 S3 OutputConfig，参考图由 GetFaceLivenessSessionResults 以 bytes 返回，仅在加密短期进程内存 中处理，不持久化原图。[AWS 生体会话结果](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_GetFaceLivenessSessionResults.html)。AWS 生体会话自身约 3 分钟失效，[会话有效期](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CreateFaceLivenessSession.html)。

SMTP 对明确临时拒绝或连接前失败最多追加两次尝试，发送途中结果未知时不自动重发。SMTP 当前只记录服务器受理，不通过 SNS 更新送达状态；说明见 [SMTP 邮件接入](MAIL_SMTP.md)。

正式同意文面需明确 AWS 的脸部特征存储、使用 Region、委托处理和删除方式。当前 `dev-v1` 仅用于本地接口验证。
