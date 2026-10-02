# 数据库结构：式样书 v1.0

依据 `安心安否確認システム_開発仕様書_v1.0_正式版.xlsx` 的 `10_データ仕様`，第 10.1 节 A6:H13。
PostgreSQL 的 `public` 中仅保留下列 8 张业务表。完整字段、类型、约束见 [spec-v1-schema.sql](spec-v1-schema.sql)。

| 表 | 式样书主要字段 | 用途 |
|---|---|---|
| users | user_id, display_name, status, created_at, updated_at | 登记者 |
| face_templates | template_id, user_id, encrypted_template, model_version, threshold_version, status | 加密的 Rekognition Collection/FaceId 引用 |
| recipients | recipient_id, user_id, name, encrypted_email, order_no, status | 1～2 个联系人 |
| consents | consent_id, user_id/temp_id, policy_version, consented_at, terminal_id, result | 同意履历；consent_type 区分注册、安否 |
| safety_checks | check_id, user_id, terminal_id, verified_at, consent_id, status | 注册确认或安否邮件操作 |
| mail_deliveries | delivery_id, check_id, recipient_id, provider_message_id, status, accepted_at | 各收件人的邮件结果 |
| audit_logs | log_id, actor_type, actor_id, action, target_type, target_id, result, occurred_at | 操作记录 |
| terminals | terminal_id, facility_id, status, app_version, last_seen_at | 端末配置 |

式样书列的是“主要項目”，不是完整物理字段。仅补充现有接口需要的临时 ID 关联、端末凭据、邮件操作编号、有效期、尝试次数等字段。删除姓名和邮箱检索摘要、row_version、独立设施表及工作租约表。`display_name`、`recipients.name` 使用式样书的字段名，仍以 bytea 保存现有密文，API 返回解密后的字符串。

同意文面及版本在 [backend/config/consent-policies.json](../backend/config/consent-policies.json) 中配置；`consents.policy_version` 保存实际同意的版本。修改文面时增加版本、将旧版标记 retired、每种类型仅保留一个 published 版本，重启后端生效。GET `/v1/consent-policies?type=registration` 的合同保持不变。

不使用 Redis。临时照片、草稿、短期会话及 15 分钟内的成功响应仅保存在一个 Node.js 进程的内存中，到期物理清除。后端重启后未完成操作需要重新开始。发送编号在 `safety_checks` 有永久唯一约束，重启后同一个发送编号仍能查询原结果，不会再创建邮件。该实现面向单进程使用，不支持多副本共享临时操作。

技术性的迁移记录在 `app_meta.schema_migrations`，不属于业务模型：全库共 8 张业务表和 1 张迁移记录表。历史 001～003 仅用于旧库升级和迁移历史；最终结构由 004 收敛。

## 旧数据库升级

先停止访问数据库的旧版 API，保存 `pg_dump -Fc` 备份到 Git 忽略的 `database/backups/`，然后执行：

```powershell
# 项目根目录；必须先备份旧库并导出文面
node backend/scripts/export-consent-policies.js
.\scripts\database.ps1 -Action migrate
.\scripts\database.ps1 -Action test
.\scripts\database.ps1 -Action status
```

004 在单个事务内迁移现有 8 张表的数据，保留 ID、加密数据、邮件结果及原有审计链；完成后删除旧表和依赖触发器。正在操作的旧会话失效。若仍有旧版外部人脸清理任务，迁移会回滚，需先用旧版清理程序完成任务。永久删除模板前应先将其状态改为 revoked，让邮件工作进程清除 AWS 引用。

完整流程的集成测试使用独立 PostgreSQL 数据库和测试版脸部／邮件服务，不发送真实邮件：

```powershell
.\scripts\test-backend-integration.ps1
```
