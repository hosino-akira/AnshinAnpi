# 用户端 API v0.4.0

调用约定及顺序见 [Android 对接文档](FRONTEND_FACE_HANDOFF.md)。

单机器人模式，不传设备凭据或用户令牌。后续步骤使用 user_id；后端保留人脸验证、本人确认、有效期与防重复发送。

发送请求成功时返回 success / send_requested / check_id / user_id，用户端不轮询邮件状态。送达、退信、失败等详细记录继续保存在后端，管理端后续单独对接。

结构化契约见 [OpenAPI](openapi.json)。旧 enrollments、users/me、safety-checks 和诊断 mail-results 接口保留兼容，不用于新的 Android 用户流程。
