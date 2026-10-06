import { z } from 'zod';
import { bodySchemas } from './validation.js';
import { adminSchemas, adminRoutes } from './admin-service.js';

const routes = [
  ['post','/v1/registrations/capture','登録① 写真を確認して一時 ID を返す','photoCapture',201],
  ['post','/v1/registrations','登録③ 登録情報を一括保存する','registration',201],
  ['post','/v1/registrations/verify','登録④ 写真を照合し、成功後に登録通知を自動でキューに追加する','registrationVerification',200,true],
  ['get','/v1/registrations/{id}','仮登録の進捗を取得する'],
  ['delete','/v1/registrations/{id}','仮登録を取り消す','empty'],
  ['post','/v1/users/{id}/recipients','安否② 本人を確認し、連絡先と送信の同意文面を返す','recipientConfirmation',200,true],
  ['post','/v1/safety-notifications','安否③ 同意に基づき安否確認通知を送信する','safetyNotification',202,true],
  ['get','/v1/mail-results/{id}','登録⑤／安否 メール結果を読み取る',null,200,true],
  ['post','/v1/mail-results/{id}/retry','再試行可能な送信失敗の宛先だけに再送する','empty',202,true],
  ['get','/health/live','稼働状況の確認'], ['get','/health/ready','データベースと一時ストレージの準備状況の確認'],
  ['get','/v1/terminal','端末情報と AWS サービスの設定状況'],
  ['get','/v1/consent-policies','現在の同意文面を取得する'],
  ['post','/v1/enrollments','仮登録を開始する','empty',201],
  ['get','/v1/enrollments/{id}','仮登録の進捗を取得する'],
  ['patch','/v1/enrollments/{id}/profile','登録者の氏名を一時保存する','profile'],
  ['post','/v1/enrollments/{id}/face','アップロードした写真または生体検知の参照顔画像を確認して一時保存する','face'],
  ['post','/v1/enrollments/{id}/consent','登録への同意または拒否を記録する','consent'],
  ['put','/v1/enrollments/{id}/recipients','1～2 件の連絡先を一時保存する','recipients'],
  ['post','/v1/enrollments/{id}/complete','正式な登録情報を一つのトランザクションで保存する','empty',201],
  ['delete','/v1/enrollments/{id}','仮登録を取り消して消去する','empty'],
  ['post','/v1/faces/liveness-sessions','サーバー側の生体検知セッションを作成する','liveness',201],
  ['post','/v1/faces/verify-registration','登録後に顔を再確認する','face',200,true],
  ['post','/v1/faces/identify','利用可能な登録者から本人を認証する','face'],
  ['post','/v1/users/me/confirmation','表示された氏名が本人か確認または否定する','confirmation',200,true],
  ['get','/v1/users/me/recipients','連絡先の氏名とマスク済みメールアドレスを取得する',null,200,true],
  ['post','/v1/enrollments/{id}/confirmation-mails','登録確認メールの送信を開始する','empty',202,true],
  ['post','/v1/safety-checks','今回の同意に基づき安否確認メールの送信を開始する','safety',202,true],
  ['get','/v1/safety-checks/{id}','宛先ごとの配信状況を取得する',null,200,true],
  ['post','/v1/safety-checks/{id}/retry','条件を満たす送信失敗の宛先だけに再送する','empty',202,true],
  ['delete','/v1/sessions/current','現在の利用者セッションを終了する','empty',200,true],
  ['post','/v1/mail/webhooks','SNS 経由の SES 配信通知を受信して検証する',null,204],
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
    const responses = { [status]: { description: status===202 ? '送信要求を受け付けました。利用者画面には送信成功を表示し、受信状況は問い合わせません' : '成功',
      ...(status!==204 ? { content:{ 'application/json':{ schema:responseName ? { $ref:`#/components/schemas/${responseName}` } : {type:'object'} } } } : {}) } };
    if (['/v1/registrations','/v1/safety-notifications'].includes(path)) responses[200]={description:'利用者が同意を拒否したため、メールの送信要求を作成しません',content:{'application/json':{schema:{$ref:`#/components/schemas/${responseName}`}}}};
    for (const error of [400,401,403,404,409,410,422,429,503]) responses[error]={ description:'API 文書のエラーコードを参照してください',content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/Error' } } } };
    paths[path] ??= {};
    paths[path][method]={ summary,security,parameters,responses,
      ...(body ? { requestBody:{ required:true,content:{ 'application/json':{ schema:z.toJSONSchema(bodySchemas[body],{ io:'input',unrepresentable:'any' }) } } } } : {}) };
    if (path.startsWith('/v1/mail-results')) { paths[path][method].deprecated=true; paths[path][method].description='バックエンドの診断用に残している API です。利用者端末からは呼び出しません。管理画面とは今後別途連携します。'; }
    if (path.startsWith('/v1/enrollments') || path.startsWith('/v1/safety-checks') || path.startsWith('/v1/users/me') || path==='/v1/faces/verify-registration') paths[path][method].deprecated=true;
    if (['photoCapture','registrationVerification'].includes(body)) paths[path][method].description='写真は JPEG/PNG の Base64 データのみとし、デコード後の上限は 512 KiB です。画像モードでは生体検知を行いません。照合が成功すると登録通知を自動でキューに追加し、check_id と send_requested=true を返します。';
    if (path==='/v1/registrations/capture' || path==='/v1/registrations') paths[path][method].description =
      (paths[path][method].description ?? '') + ' 登録が完了した active の利用者と高い類似度で一致した場合だけ、409 FACE_ALREADY_REGISTERED を返します。未完了の pending_registration は再登録を妨げず、安否確認の顔認証にも使用しません。氏名が異なっていても、登録済み利用者の重複登録は許可しません。';
    if (path==='/v1/faces/liveness-sessions') paths[path][method].description='purpose=registration の場合は user_id、enrollment の場合は enrollment_id が必須です。AWS Face Liveness の動画は専用のフロントエンドコンポーネントから直接送信します。';
    if (body==='face') paths[path][method].description='image_base64（JPEG/PNG、デコード後 512 KiB 以下、data URL の接頭辞なし）または liveness_session_id のいずれかを指定します。画像モードでは生体検知を行いません。metrics のスコアは 0～100 です。有効な候補がない場合、similarity_score は null になります。登録 API は画像の品質指標だけを返します。';
    if (path.endsWith('/webhooks')) paths[path][method].description='SNS の署名、Topic ARN、許容時間範囲、イベント ID をバックエンドで検証します。署名のないクライアントの配信状況は受け付けません。';
  }
  for (const [method,path,summary,body] of adminRoutes) {
    const parameters=[...path.matchAll(/\{([^}]+)\}/g)].map(([,name])=>({name,in:'path',required:true,schema:{type:'string'}}));
    if (method!=='get' && path!=='/v1/admin/login') parameters.push(
      {name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}},
      {name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',maxLength:100}});
    const responses={200:{description:'成功'}};
    for (const status of [400,401,403,404,409,429,503]) responses[status]={description:'エラー',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}};
    paths[path]??={};
    paths[path][method]={summary,tags:['管理者'],parameters,responses,security:path==='/v1/admin/login' ? [] : [{AdminCookie:[]}],
      ...(body ? {requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(adminSchemas[body],{io:'input',unrepresentable:'any'})}}}} : {})};
  }
  return { openapi:'3.1.0',info:{ title:'安心安否確認 利用者・管理者 API',version:'0.5.0' },servers:[{ url:'http://192.168.0.51:3002',description:'開発用 LAN 内バックエンド（DHCP によりアドレスが変わる場合があります）' },{url:'http://localhost:3002'}],paths,
    components:{ securitySchemes:{AdminCookie:{type:'apiKey',in:'cookie',name:'anshin_admin'}},
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
    Metrics:object({similarity_score:nullableScore,match_threshold:nullableScore,face_confidence:nullableScore,brightness:nullableScore,sharpness:nullableScore,
      yaw:{type:['number','null']},pitch:{type:['number','null']},roll:{type:['number','null']},liveness_passed:flag,liveness_score:nullableScore},['liveness_passed']),
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
