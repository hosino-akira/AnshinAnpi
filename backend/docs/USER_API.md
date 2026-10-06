# 用户端 API v0.4.0

调用约定及顺序见 [Android 对接文档](FRONTEND_FACE_HANDOFF.md)。

单机器人模式，不传设备凭据或用户令牌。后续步骤使用 user_id；后端保留人脸验证、本人确认、有效期与防重复发送。

发送请求成功时返回 success / send_requested / check_id / user_id，用户端不轮询邮件状态。送达、退信、失败等详细记录继续保存在后端，管理端后续单独对接。

结构化契约见 [OpenAPI](openapi.json)。旧 enrollments、users/me、safety-checks 和诊断 mail-results 接口保留兼容，不用于新的 Android 用户流程。

注册①及③仅检查同一张脸是否已关联注册成功的 active 用户，高度匹配返回 409 FACE_ALREADY_REGISTERED，不因姓名不同而另建用户。pending_registration 不视为已登记：仅拍照、取消、中途放弃、未通过二次验证或登记邮件未全部受理的人可以重新进行初回登记，安否识别也不会匹配这些记录。二次验证仍只比对本次登记的 user_id；验证通过且登记邮件全部受理后，用户成为 active。注册③在数据库事务锁内复查已完成登记并建立本次人脸记录。错误详情只包含评分及门槛，不披露已有姓名、用户 ID 或联系人。旧登记完成接口使用相同检查。
