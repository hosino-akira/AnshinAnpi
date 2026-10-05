"use client";

import { useEffect, useRef, useState } from 'react';
import { faceApi, FaceApiError } from '@/lib/face-api';
import { createFaceClient } from '@/lib/face-client';
import './face.css';

type Policy = { policy_version: string; body: string };
type Session = { user_id: string };
type Metrics = { similarity_score?: number | null; match_threshold?: number;
  face_confidence?: number | null; brightness?: number | null; sharpness?: number | null;
  liveness_score?: number | null };
type Result = Partial<Session> & { result: string; display_name?: string; metrics: Metrics };
type Attempt = { time: string; result: string; metrics: Metrics };
const score = (value?: number | null) => typeof value === 'number' ? value.toFixed(2) : '无可用分数';
const faceClient = createFaceClient();

async function readPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('请选择 10 MiB 以下的 JPEG 或 PNG 图片。');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const ratio = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法读取图片。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (base64.length <= 690000) return base64;
    }
    throw new Error('压缩后的图片仍过大，请选择较小图片。');
  } finally { bitmap.close(); }
}

export default function FaceDevelopmentPage() {
  const [policy, setPolicy] = useState<Policy>();
  const [connected, setConnected] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [photo, setPhoto] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [message, setMessage] = useState('正在连接本地后端…');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [checkId, setCheckId] = useState<string>();
  const [safetyContacts, setSafetyContacts] = useState<Awaited<ReturnType<typeof faceClient.confirmRecipients>>>();
  const [safetyConsent, setSafetyConsent] = useState(false);
  const [identified, setIdentified] = useState(false);
  const draftId = useRef<string | undefined>(undefined);
  const session = useRef<Session | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const pending = useRef(false);
  const addResult = (result: string, metrics: Metrics) => setAttempts(old =>
    [{ time: new Date().toLocaleTimeString(), result, metrics }, ...old].slice(0, 5));

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let active = true;
    Promise.all([faceClient.terminal(), faceClient.registrationPolicy()]).then(([terminal, currentPolicy]) => {
      if (!active) return;
      if (!terminal.capabilities.face) throw new Error('后端人脸服务尚未配置。');
      setPolicy(currentPolicy); setConnected(true); setMessage('连接就绪。选择照片后可以登记或识别。');
    }).catch(() => { if (active) setError('后端连接失败，请确认本地开发服务已启动。'); });
    return () => {
      active = false; readVersion.current++;
      if (draftId.current) void faceClient.cancelRegistration(draftId.current).catch(() => {});
      if (session.current) void faceApi('/sessions/current', 'DELETE', {}, session.current.user_id).catch(() => {});
    };
  }, []);

  const clearPhoto = () => { setPhoto(undefined); readVersion.current++; if (fileInput.current) fileInput.current.value = ''; };
  const failure = (cause: unknown) => {
    if (cause instanceof FaceApiError) {
      const descriptions: Record<string, string> = {
        'FACE-001': '图片中没有检测到人脸。', 'FACE-002': '请上传只有一张人脸的照片。',
        FACE_QUALITY_FAILED: '照片未通过质量检查，请检查清晰度、光线和脸部角度。',
        INVALID_FACE_IMAGE: '后端只接受 512 KiB 以下的 JPEG 或 PNG 图片。',
        FACE_VERIFICATION_REQUIRED: '验证会话已过期，请结束本次操作后重新开始。',
        'TIME-001': '临时登记已过期，请重新开始。',
        FACE_SERVICE_UNAVAILABLE: 'AWS 人脸服务暂时不可用。',
        FACE_AUTH_EXPIRED: '本机 AWS 登录已过期，请重新登录后重启后端。',
        FACE_ACCESS_DENIED: 'AWS 拒绝了人脸接口请求，请检查 IAM 权限。',
      };
      setError(cause.status === 429 ? `操作受限，请${cause.retryAfterSeconds ? `等待 ${cause.retryAfterSeconds} 秒后` : '稍后'}重试。`
        : (descriptions[cause.code] || `操作未完成：${cause.code}`)
          + (typeof cause.details?.aws_error === 'string' ? `（${cause.details.aws_error} / ${cause.details.aws_operation}）` : ''));
      addResult('未完成', (cause.details ?? {}) as Metrics);
    } else { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); addResult('未完成', {}); }
  };

  const run = async (purpose: 'enrollment' | 'registration' | 'safety') => {
    if (!photo || !consent || pending.current) return;
    if (purpose === 'enrollment' && (!policy || !displayName.trim() || !contactName.trim() || !contactEmail.trim())) {
      setError('请填写本人姓名、联系人姓名和邮箱。'); return;
    }
    pending.current = true; setBusy(true); setError(''); setMessage('后端正在处理照片…');
    try {
      if (purpose === 'enrollment') {
        if (draftId.current) {
          try { await faceClient.cancelRegistration(draftId.current); }
          catch (cause) { if (!(cause instanceof FaceApiError && cause.status === 410)) throw cause; }
          draftId.current = undefined;
        }
        const draft = await faceClient.captureRegistration(photo);
        draftId.current = draft.temp_id;
        const completed = await faceClient.register({ temp_id: draft.temp_id, display_name: displayName,
          policy_version: policy!.policy_version, consent_result: 'granted', recipients: [{ name: contactName, email: contactEmail }] });
        if (!completed.user_id) throw new Error('登记未完成。');
        session.current = { user_id: completed.user_id };
        draftId.current = undefined; setRegistered(true); setIdentified(false); setCheckId(undefined);
        addResult('资料保存成功，待二次验证', draft.metrics); setDisplayName(''); setContactName(''); setContactEmail('');
        setMessage('照片已登记。请上传另一张照片验证刚登记的人脸。');
      } else {
        const result = purpose === 'registration'
          ? await faceClient.verifyAndNotify(photo, session.current?.user_id ?? '')
          : await faceClient.identify(photo);
        addResult(result.result === 'matched' ? '匹配成功' : result.result === 'ambiguous' ? '候选相近，无法确认' : '未匹配', result.metrics);
        if (result.result === 'matched' && result.user_id) {
          session.current = { user_id: result.user_id };
          setCheckId(result.check_id); setSafetyContacts(undefined); setSafetyConsent(false);
          setIdentified(purpose === 'safety');
          setMessage(`匹配成功：${result.display_name ?? '本人'}。相似度 ${score(result.metrics.similarity_score)} 分。${result.check_id ? '登记通知提交成功。' : '请确认是本人后获取联系人。'}`);
        } else setMessage('未能确认本人，请查看评分。日常识别只匹配已激活用户。');
      }
    } catch (cause) { failure(cause); setMessage('本次操作未完成。'); }
    finally { clearPhoto(); setConsent(false); pending.current = false; setBusy(false); }
  };

  const cancel = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      if (draftId.current) {
        try { await faceClient.cancelRegistration(draftId.current); }
        catch (cause) { if (!(cause instanceof FaceApiError && cause.status === 410)) throw cause; }
      }
      if (session.current) {
        try { await faceApi('/sessions/current', 'DELETE', {}, session.current.user_id); }
        catch (cause) { if (!(cause instanceof FaceApiError && cause.status === 401)) throw cause; }
      }
      draftId.current = undefined; session.current = undefined;
      setRegistered(false); clearPhoto(); setDisplayName(''); setContactName(''); setContactEmail('');
      setCheckId(undefined); setSafetyContacts(undefined); setSafetyConsent(false); setIdentified(false);
      setConsent(false); setAttempts([]); setError(''); setMessage('已结束操作。');
    } catch (cause) { failure(cause); } finally { pending.current = false; setBusy(false); }
  };

  const runMail = async (action: 'contacts' | 'send') => {
    const current = session.current;
    if (!current || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (action === 'contacts') setSafetyContacts(await faceClient.confirmRecipients(current.user_id, true));
      if (action === 'send' && safetyConsent && safetyContacts?.policy_version) {
        const result = await faceClient.notifySafety(current.user_id, true, safetyContacts.policy_version);
        setCheckId(result.check_id ?? undefined); setMessage('发送成功，安否通知请求已提交。');
      }

    } catch (cause) { if (action === 'send') { setError(''); setMessage('操作已结束。'); } else failure(cause); }
    finally { pending.current = false; setBusy(false); }
  };

  if (!import.meta.env.DEV) return <main className="face-dev"><p>此测试页面仅供本地开发使用。</p></main>;
  return <main className="face-dev">
    <header><a href="/">返回首页</a><h1>图片人脸识别联调</h1>
      <p>上传 JPEG 或 PNG 照片，由后端检查图片并识别人脸。不需要靠近屏幕完成活体挑战。</p>
      <p>图片模式不进行活体检测。识别分数表示人脸相似度，登记照片没有匹配分数。</p></header>
    <p role="status" className="face-status">{message}</p>
    {error && <p role="alert" className="face-error">{error}</p>}
    <section className="face-card"><h2>选择本次照片</h2>
      <input ref={fileInput} aria-label="人脸照片" type="file" accept="image/jpeg,image/png" capture="user" disabled={busy || reading}
        onChange={e => {
          const file = e.target.files?.[0]; const version = ++readVersion.current;
          setPhoto(undefined); setError(''); if (!file) return; setReading(true);
          void readPhoto(file).then(value => { if (version === readVersion.current) setPhoto(value); })
            .catch(cause => { if (version === readVersion.current) setError(cause.message); })
            .finally(() => { if (version === readVersion.current) setReading(false); });
        }}/>
      {reading && <p>正在压缩图片…</p>}
      {photo && <img src={`data:image/jpeg;base64,${photo}`} alt="待上传照片预览" style={{ maxWidth: '100%', maxHeight: 280 }}/>}
      {policy && <details><summary>查看登记同意文案</summary><p>{policy.body}</p></details>}
      <label className="face-consent"><input type="checkbox" checked={consent} disabled={busy}
        onChange={e => setConsent(e.target.checked)}/>我同意将本次照片提交 AWS 进行人脸处理；登记时同时保存姓名和联系人信息。</label>
    </section>
    {!registered ? <>
      <section className="face-card"><h2>登记测试</h2>
        <label>本人姓名<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={50} disabled={busy}/></label>
        <label>联系人姓名<input value={contactName} onChange={e => setContactName(e.target.value)} maxLength={50} disabled={busy}/></label>
        <label>联系人邮箱<input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} disabled={busy}/></label>
        <button disabled={!connected || !photo || !consent || busy || reading} onClick={() => void run('enrollment')}>上传照片并登记</button>
      </section>
      <section className="face-card"><h2>识别已有用户</h2><p>仅匹配已完成邮件激活的用户。</p>
        <button disabled={!connected || !photo || !consent || busy || reading} onClick={() => void run('safety')}>上传照片并识别</button></section>
    </> : !checkId && <section className="face-card"><h2>验证刚登记的人脸</h2><p>请选择另一张照片，并勾选本次同意。</p>
      <button disabled={!photo || !consent || busy || reading} onClick={() => void run('registration')}>上传照片验证本人</button></section>}
    {identified && !checkId && <section className="face-card"><h2>安否邮件</h2>
      {!safetyContacts && <button disabled={busy} onClick={() => void runMail('contacts')}>是本人，获取联系人</button>}
      {safetyContacts && <><ul>{safetyContacts.recipients.map(contact => <li key={contact.recipient_id}>{contact.name}：{contact.masked_email}</li>)}</ul>
        <p>{safetyContacts.consent_body}</p>
        <label><input type="checkbox" checked={safetyConsent} onChange={e => setSafetyConsent(e.target.checked)}/>我同意向以上联系人发送本次安否通知</label>
        <button disabled={busy || !safetyConsent} onClick={() => void runMail('send')}>同意并发送安否邮件</button></>}
    </section>}
    {checkId && <section className="face-card"><h2>发送成功</h2><p>发送请求已提交。</p></section>}
    {attempts.length > 0 && <section className="face-card"><h2>最近检测评分</h2>{attempts.map((attempt, index) =>
      <article key={`${attempt.time}-${index}`}><h3>{attempt.time} · {attempt.result}</h3>
        <p>人脸相似度：{score(attempt.metrics.similarity_score)}
          {attempt.metrics.match_threshold !== undefined && `；匹配门槛：${score(attempt.metrics.match_threshold)}`}</p>
        <p>人脸检测置信度：{score(attempt.metrics.face_confidence)}；亮度：{score(attempt.metrics.brightness)}；清晰度：{score(attempt.metrics.sharpness)}</p>
        <p>活体分数：图片模式不检测活体</p>
      </article>)}</section>}
    <button className="face-secondary" disabled={busy || reading} onClick={() => void cancel()}>结束操作并清空界面</button>
  </main>;
}
