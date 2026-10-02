import { z } from 'zod';
import { bodySchemas } from './validation.js';

const routes = [
  ['get','/health/live','存活检查'], ['get','/health/ready','数据库与临时存储就绪检查'],
  ['get','/v1/terminal','终端信息与 AWS 服务配置状态'],
  ['get','/v1/consent-policies','获取当前同意文面'],
  ['post','/v1/enrollments','开始临时登记','empty',201],
  ['get','/v1/enrollments/{id}','查询临时登记进度'],
  ['patch','/v1/enrollments/{id}/profile','暂存登记人姓名','profile'],
  ['post','/v1/enrollments/{id}/face','核验并暂存生体参考脸图','face'],
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
    const publicRoute = path.startsWith('/health/') || path.endsWith('/webhooks');
    const parameters = [];
    if (path.includes('{id}')) parameters.push({ name:'id',in:'path',required:true,schema:{ type:'string',format:'uuid' } });
    if (method !== 'get' && !publicRoute) parameters.push({ name:'Idempotency-Key',in:'header',required:true,schema:{ type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$' } });
    if (path==='/v1/consent-policies') parameters.push({ name:'type',in:'query',required:true,schema:{ type:'string',enum:['registration','safety'] } });
    const security = publicRoute ? [] : [{ TerminalId:[],TerminalToken:[],...(bearer ? { UserToken:[] } : {}) }];
    const responses = { [status]: { description: status===202 ? '操作已入队；轮询结果，queued 不代表已发送' : '成功',
      ...(status!==204 ? { content:{ 'application/json':{ schema:{ type:'object' } } } } : {}) } };
    for (const error of [400,401,403,404,409,410,422,429,503]) responses[error]={ description:'参阅接口文档中的错误码',content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/Error' } } } };
    paths[path] ??= {};
    paths[path][method]={ summary,security,parameters,responses,
      ...(body ? { requestBody:{ required:true,content:{ 'application/json':{ schema:z.toJSONSchema(bodySchemas[body],{ io:'input',unrepresentable:'any' }) } } } } : {}) };
    if (path==='/v1/faces/liveness-sessions') paths[path][method].description='purpose=registration 时必须带 registration 用户令牌；enrollment 时须提供 enrollment_id。AWS Face Liveness 视频使用专用前端组件直接提交。';
    if (path.endsWith('/webhooks')) paths[path][method].description='SNS 签名、Topic ARN、时间窗口和事件 ID 均由后端校验，不接受未签名客户端配信状态。';
  }
  return { openapi:'3.1.0',info:{ title:'安心安否確認 用户端 API',version:'0.1.0' },servers:[{ url:'http://localhost:3001' }],paths,
    components:{ securitySchemes:{ TerminalId:{ type:'apiKey',in:'header',name:'X-Terminal-Id' },
      TerminalToken:{ type:'apiKey',in:'header',name:'X-Terminal-Token' },UserToken:{ type:'http',scheme:'bearer',description:'短期不透明用户令牌' } },
    schemas:{ Error:{ type:'object',required:['error'],properties:{ error:{ type:'object',required:['code','message','request_id'],
      properties:{ code:{ type:'string' },message:{ type:'string' },request_id:{ type:'string',format:'uuid' },details:{ type:'object' } } } } } } } };
}
