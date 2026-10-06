# 数据库说明

用户端、管理端共用 PostgreSQL。业务数据在 public 中，管理员账号、管理设置和迁移记录在 app_meta 中。

## 业务表

| 表 | 用途 |
|---|---|
| users | 登记者姓名、使用状态和登记时间 |
| face_templates | 加密的人脸服务引用和识别资格 |
| recipients | 每位用户最多两个联系人的姓名、邮箱和状态 |
| consents | 登记和发送同意的版本、时间与结果 |
| safety_checks | 登记通知、安否通知和联系人变更通知的操作记录 |
| mail_deliveries | 每个收件人的发送状态、失败原因和重试信息 |
| audit_logs | 管理及业务操作的签名审计记录 |
| terminals | 固定机器人配置和最近连接时间 |

app_meta.administrator 保存单管理员账号，app_meta.admin_settings 保存版本化设置，app_meta.schema_migrations 记录已执行的迁移。

姓名、邮箱和人脸服务引用加密保存；原始照片不写入业务数据库。管理员账号、联系人、邮件模板和个人信息文案的操作见 [管理端说明](../backend/docs/ADMIN_API.md)。

## 启动与初始化

根目录 .env 配置 POSTGRES_DB、POSTGRES_USER、POSTGRES_PASSWORD 和 POSTGRES_PORT。默认本机连接地址为 127.0.0.1:5433，Compose 内部连接 postgres:5432。

在项目根目录执行：

```powershell
docker compose up -d --wait postgres
.\scripts\database.ps1 -Action migrate
.\scripts\database.ps1 -Action status
```

保留 migrations 中的全部 SQL 文件；初始化依次执行这些文件，已执行的版本会跳过。新数据卷也会通过 Compose 自动执行迁移。

## 临时数据与有效期

临时照片、登记草稿和人脸会话只在单个后端进程的加密内存中保存。登记草稿和人脸会话最长 15 分钟，连续 5 分钟没有相关有效接口调用时失效；本地屏幕操作不会刷新后端计时。已成功请求的响应缓存 15 分钟。

后端重启会结束未完成的临时操作。邮件发送编号在 safety_checks 中保持唯一，同一发送请求重试不会重复创建邮件。此实现使用单后端进程，不支持多个实例共享临时会话。

## 文案与数据保留

同意文案初始值在 [consent-policies.json](../backend/config/consent-policies.json)，运行中的管理设置保存于数据库；通过管理端发布个人信息文案的新版本和适用日期，不覆盖已有同意履历。

用户删除后立即擦除业务姓名、邮箱和邮件快照；人脸服务引用由后台工作进程清理。30 天保留期结束且外部清理完成后再物理删除用户行，因此需要保持工作进程启用。

PostgreSQL 数据保存在 Compose 的命名卷中，停止容器不会删除数据；备份和数据导出文件应单独保存。
