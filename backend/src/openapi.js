import { z } from 'zod';
import { bodySchemas } from './validation.js';

const routes = [
  ['post','/v1/registrations/capture','注册① 检查照片并返回临时 ID','photoCapture',201],
  ['post','/v1/registrations','注册③ 一次保存全部登记资料','registration',201],
  ['post','/v1/registrations/verify','注册④ 比对照片，通过后自动入队登记通知','registrationVerification',200,true],
  ['get','/v1/registrations/{id}','查询临时登记进度'],
  ['delete','/v1/registrations/{id}','取消临时登记','empty'],
  ['post','/v1/users/{id}/recipients','安否② 确认本人并返回联系人和发送同意文面','recipientConfirmation',200,true],
  ['post','/v1/safety-notifications','安否③ 同意并发送安否通知','safetyNotification',202,true],
  ['get','/v1/mail-results/{id}','注册⑤／安否 只读查询邮件结果',null,200,true],
  ['post','/v1/mail-results/{id}/retry','重试允许重试的失败收件人','empty',202,true],
  ['get','/health/live','存活检查'], ['get','/health/ready','数据库与临时存储就绪检查'],
  ['get','/v1/terminal','终端信息与 AWS 服务配置状态'],
  ['get','/v1/consent-policies','获取当前同意文面'],
  ['post','/v1/enrollments','开始临时登记','empty',201],
  ['get','/v1/enrollments/{id}','查询临时登记进度'],
  ['patch','/v1/enrollments/{id}/profile','暂存登记人姓名','profile'],
  ['post','/v1/enrollments/{id}/face','核验并暂存上传照片或生体参考脸图','face'],
  ['post','/v1/enrollments/{id}/consent','记录登记同意或拒绝','consent'],
  ['put','/v1/enrollments/{id}/recipients','暂存一至两名联系人','recipients'],
  ['post','/v1/enrollments/{id}/complete','原子保存正式登记资料','empty',201],
  ['delete','/v1/enrollments/{id}','取消并清除临时登记','empty'],
  ['post','/v1/faces/liveness-sessions','创建服务端生体检测会话','liveness',201],
  ['post','/v1/faces/verify-registration','登记后重新核验脸部','face',200,true],
  ['post','/v1/faces/identify','从有效登记人中识别本人','face'],
  ['post','/v1/users/me/confirmation','确认或拒绝本人姓名','confirmation',200,true],
  ['get','/v1/users/me/recipients','读取联系人姓名与掩码邮箱',null,200,true],
  ['post','/v1/enrollments/{id}/confirmation-mails','开始发送登记确认邮件','empty',202,true],
  ['post','/v1/safety-checks','本次同意并开始安否邮件发送','safety',202,true],
  ['get','/v1/safety-checks/{id}','查询宛先逐项配信状态',null,200,true],
  ['post','/v1/safety-checks/{id}/retry','只重试符合条件的失败宛先','empty',202,true],
  ['delete','/v1/sessions/current','结束当前用户会话','empty',200,true],
  ['post','/v1/mail/webhooks','接收并验证 SNS 的 SES 配信通知',null,204],
];

export function openApiDocument() {
  const paths = {};
  for (const [method,path,summary,body,status=200,bearer=false] of routes) {
    const publicRoute = path.startsWith('/health/') || path.endsWith('/webhooks') || path === '/v1/consent-policies';
    const parameters = [];
    if (path.includes('{id}')) parameters.push({ name:'id',in:'path',required:true,schema:{ type:'string',format:'uuid' } });
    if (method !== 'get' && !publicRoute) parameters.push({ name:'Idempotency-Key',in:'header',required:true,schema:{ type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$' } });
    if (path==='/v1/consent-policies') parameters.push({ name:'type',in:'query',required:true,schema:{ type:'string',enum:['registration','safety'] } });
    const security = [];
    const responseName = {
      '/v1/registrations/capture':'CaptureResult','/v1/registrations':'RegistrationResult',
      '/v1/registrations/verify':'FaceResult','/v1/faces/identify':'FaceResult',
      '/v1/users/{id}/recipients':'ContactsResult','/v1/safety-notifications':'SendResult',
      '/v1/mail-results/{id}':'MailResult','/v1/consent-policies':'Policy'
    }[path];
    const responses = { [status]: { description: status===202 ? '发送请求已接受；用户端显示提交成功，不查询收件状态' : '成功',
      ...(status!==204 ? { content:{ 'application/json':{ schema:responseName ? { $ref:`#/components/schemas/${responseName}` } : {type:'object'} } } } : {}) } };
    if (['/v1/registrations','/v1/safety-notifications'].includes(path)) responses[200]={description:'用户拒绝同意，不创建邮件请求',content:{'application/json':{schema:{$ref:`#/components/schemas/${responseName}`}}}};
    for (const error of [400,401,403,404,409,410,422,429,503]) responses[error]={ description:'参阅接口文档中的错误码',content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/Error' } } } };
    paths[path] ??= {};
    paths[path][method]={ summary,security,parameters,responses,
      ...(body ? { requestBody:{ required:true,content:{ 'application/json':{ schema:z.toJSONSchema(bodySchemas[body],{ io:'input',unrepresentable:'any' }) } } } } : {}) };
    if (path.startsWith('/v1/mail-results')) { paths[path][method].deprecated=true; paths[path][method].description='后端诊断保留接口。用户端不调用；管理端之后单独对接。'; }
    if (path.startsWith('/v1/enrollments') || path.startsWith('/v1/safety-checks') || path.startsWith('/v1/users/me') || path==='/v1/faces/verify-registration') paths[path][method].deprecated=true;
    if (['photoCapture','registrationVerification'].includes(body)) paths[path][method].description='照片为 JPEG/PNG 的纯 Base64，解码后最多 512 KiB；图片模式不检测活体。比对通过自动入队登记通知，并返回 check_id 和 send_requested=true。';
    if (path==='/v1/faces/liveness-sessions') paths[path][method].description='purpose=registration 时必须提供 user_id；enrollment 时须提供 enrollment_id。AWS Face Liveness 视频使用专用前端组件直接提交。';
    if (body==='face') paths[path][method].description='二选一：image_base64（JPEG/PNG，解码后不超过512 KiB，不含 data URL 前缀）或 liveness_session_id。图片模式不检测活体。返回 metrics，分数为0–100；无可用候选时 similarity_score 为 null。登记接口仅返回图片质量指标。';
    if (path.endsWith('/webhooks')) paths[path][method].description='SNS 签名、Topic ARN、时间窗口和事件 ID 均由后端校验，不接受未签名客户端配信状态。';
  }
  return { openapi:'3.1.0',info:{ title:'安心安否確認 用户端 API',version:'0.4.0' },servers:[{ url:'http://192.168.0.51:3002',description:'局域网开发后端（地址可能随 DHCP 改变）' },{url:'http://localhost:3002'}],paths,
    components:{ securitySchemes:{},
    schemas:{ ...responseSchemas(), Error:{ type:'object',required:['error'],properties:{ error:{ type:'object',required:['code','message','request_id'],
      properties:{ code:{ type:'string' },message:{ type:'string' },request_id:{ type:'string',format:'uuid' },details:{ type:'object' } } } } } } } };
}

function responseSchemas() {
  const uuid={type:'string',format:'uuid'}, text={type:'string'}, flag={type:'boolean'}, nullableScore={type:['number','null'],minimum:0,maximum:100};
  const object=(properties,required=[])=>({type:'object',properties,required});
  const recipients={type:'array',items:{$ref:'#/components/schemas/RecipientResult'}};
  const metrics={$ref:'#/components/schemas/Metrics'};
  const session={expires_at:{type:'string',format:'date-time'}};
  const mail={check_id:uuid,mail_status:text,recipient_results:recipients,user_id:uuid,user_status:text,registration_completed:flag};
  return {
    Metrics:object({similarity_score:nullableScore,match_threshold:nullableScore,face_confidence:nullableScore,brightness:nullableScore,sharpness:nullableScore,liveness_passed:flag,liveness_score:nullableScore},['liveness_passed']),
    RecipientResult:object({delivery_id:uuid,recipient_id:uuid,status:text,error_code:{type:['string','null']},attempt_count:{type:'integer'}},['delivery_id','recipient_id','status']),
    Policy:object({policy_version:text,title:text,body:text},['policy_version','title','body']),
    CaptureResult:object({temp_id:uuid,face_valid:flag,expires_at:session.expires_at,idle_timeout_seconds:{type:'integer'},metrics},['temp_id','face_valid','expires_at','idle_timeout_seconds','metrics']),
    RegistrationResult:object({success:flag,user_id:{type:['string','null'],format:'uuid'},user_status:{type:['string','null'],enum:['pending_registration',null]},registration_completed:flag,status:text},['success','user_id','user_status','registration_completed']),
    FaceResult:object({user_id:uuid,user_status:text,check_id:uuid,send_requested:flag,registration_completed:flag,matched:flag,result:{type:'string',enum:['matched','no_match','ambiguous']},display_name:text,metrics,similarity_score:nullableScore,verification_status:text,attempts_remaining:{type:'integer'},recovered:flag},['matched','result','metrics','verification_status']),
    ContactsResult:object({success:flag,confirmed:flag,user_id:uuid,policy_version:text,consent_body:text,session_ended:flag,recipients:{type:'array',items:object({recipient_id:uuid,name:text,masked_email:text,status:text},['recipient_id','name','masked_email','status'])}},['success','confirmed','recipients']),
    SendResult:object({success:flag,send_requested:flag,user_id:uuid,check_id:{type:['string','null'],format:'uuid'},session_ended:flag},['success','send_requested','check_id','user_id']),
    MailResult:object({...mail,type:{type:'string',enum:['registration','safety']},status:text,created_at:session.expires_at,completed_at:{type:['string','null'],format:'date-time'}},['check_id','type','mail_status','user_id','user_status','registration_completed','recipient_results'])
  };
}
