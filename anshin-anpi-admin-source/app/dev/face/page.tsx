"use client";

import { useEffect, useRef, useState } from 'react';
import { faceApi, FaceApiError } from '@/lib/face-api';
import { createFaceClient } from '@/lib/face-client';
import { PolicyContent } from '@/components/policy-content';
import './face.css';

type Policy = { policy_version: string; body: string };
type Session = { user_id: string };
type Metrics = { similarity_score?: number | null; match_threshold?: number;
  face_confidence?: number | null; brightness?: number | null; sharpness?: number | null;
  liveness_score?: number | null };
type Result = Partial<Session> & { result: string; display_name?: string; metrics: Metrics };
type Attempt = { time: string; result: string; metrics: Metrics };
const score = (value?: number | null) => typeof value === 'number' ? value.toFixed(2) : 'スコアなし';
const faceClient = createFaceClient();

async function readPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('10 MiB 以下の JPEG または PNG 画像を選択してください。');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const ratio = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を読み込めません。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (base64.length <= 690000) return base64;
    }
    throw new Error('圧縮後も画像が大きすぎます。より小さい画像を選択してください。');
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
  const [message, setMessage] = useState('ローカルのバックエンドに接続しています…');
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
      if (!terminal.capabilities.face) throw new Error('バックエンドの顔認証サービスが設定されていません。');
      setPolicy(currentPolicy); setConnected(true); setMessage('接続しました。写真を選択すると登録や顔認証を行えます。');
    }).catch(() => { if (active) setError('バックエンドへの接続に失敗しました。ローカルの開発サービスが起動しているか確認してください。'); });
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
        'FACE-001': '画像から顔が検出されませんでした。', 'FACE-002': '一人の顔だけが写っている写真をアップロードしてください。',
        FACE_QUALITY_FAILED: '写真の品質基準を満たしていません。鮮明さ、明るさ、顔の角度を確認してください。',
        INVALID_FACE_IMAGE: 'バックエンドは 512 KiB 以下の JPEG または PNG 画像だけを受け付けます。',
        FACE_VERIFICATION_REQUIRED: '認証セッションの有効期限が切れました。今回の操作を終了してからやり直してください。',
        'TIME-001': '仮登録の有効期限が切れました。やり直してください。',
        FACE_SERVICE_UNAVAILABLE: 'AWS の顔認証サービスは一時的に利用できません。',
        FACE_AUTH_EXPIRED: 'この端末の AWS ログインの有効期限が切れました。再ログインしてからバックエンドを再起動してください。',
        FACE_ACCESS_DENIED: 'AWS が顔認証 API の要求を拒否しました。IAM の権限を確認してください。',
      };
      setError(cause.status === 429 ? `操作が制限されています。${cause.retryAfterSeconds ? `${cause.retryAfterSeconds} 秒後に` : 'しばらくしてから'}再試行してください。`
        : (descriptions[cause.code] || `操作が完了しませんでした：${cause.code}`)
          + (typeof cause.details?.aws_error === 'string' ? `（${cause.details.aws_error} / ${cause.details.aws_operation}）` : ''));
      addResult('未完了', (cause.details ?? {}) as Metrics);
    } else { setError(cause instanceof Error ? cause.message : '操作が完了しませんでした。再試行してください。'); addResult('未完了', {}); }
  };

  const run = async (purpose: 'enrollment' | 'registration' | 'safety') => {
    if (!photo || !consent || pending.current) return;
    if (purpose === 'enrollment' && (!policy || !displayName.trim() || !contactName.trim() || !contactEmail.trim())) {
      setError('ご本人の氏名、連絡先の氏名とメールアドレスを入力してください。'); return;
    }
    pending.current = true; setBusy(true); setError(''); setMessage('バックエンドで写真を処理しています…');
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
        if (!completed.user_id) throw new Error('登録が完了しませんでした。');
        session.current = { user_id: completed.user_id };
        draftId.current = undefined; setRegistered(true); setIdentified(false); setCheckId(undefined);
        addResult('情報を保存しました。再撮影による本人確認待ちです', draft.metrics); setDisplayName(''); setContactName(''); setContactEmail('');
        setMessage('写真を登録しました。別の写真をアップロードして、登録した顔を確認してください。');
      } else {
        const result = purpose === 'registration'
          ? await faceClient.verifyAndNotify(photo, session.current?.user_id ?? '')
          : await faceClient.identify(photo);
        addResult(result.result === 'matched' ? '照合成功' : result.result === 'ambiguous' ? '候補が似ているため確認できません' : '該当なし', result.metrics);
        if (result.result === 'matched' && result.user_id) {
          session.current = { user_id: result.user_id };
          setCheckId(result.check_id); setSafetyContacts(undefined); setSafetyConsent(false);
          setIdentified(purpose === 'safety');
          setMessage(`照合成功：${result.display_name ?? 'ご本人'}。類似度 ${score(result.metrics.similarity_score)} 点。${result.check_id ? '登録通知の送信要求を受け付けました。' : 'ご本人か確認してから連絡先を取得してください。'}`);
        } else setMessage('本人を確認できませんでした。評価を確認してください。通常の顔認証は利用開始済みの利用者だけを対象とします。');
      }
    } catch (cause) { failure(cause); setMessage('今回の操作は完了しませんでした。'); }
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
      setConsent(false); setAttempts([]); setError(''); setMessage('操作を終了しました。');
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
        setCheckId(result.check_id ?? undefined); setMessage('送信成功。安否確認通知の送信要求を受け付けました。');
      }

    } catch (cause) { if (action === 'send') { setError(''); setMessage('操作は終了しました。'); } else failure(cause); }
    finally { pending.current = false; setBusy(false); }
  };

  if (!import.meta.env.DEV) return <main className="face-dev"><p>このテストページはローカル開発専用です。</p></main>;
  return <main className="face-dev">
    <header><a href="/">ホームに戻る</a><h1>写真による顔認証の連携テスト</h1>
      <p>JPEG または PNG の写真をアップロードすると、バックエンドで画像を確認し、顔認証を行います。生体検知のために画面へ近づく操作は不要です。</p>
      <p>画像モードでは生体検知を行いません。認証スコアは顔の類似度を示します。登録時の写真には照合スコアがありません。</p></header>
    <p role="status" className="face-status">{message}</p>
    {error && <p role="alert" className="face-error">{error}</p>}
    <section className="face-card"><h2>今回使用する写真を選択</h2>
      <input ref={fileInput} aria-label="顔写真" type="file" accept="image/jpeg,image/png" capture="user" disabled={busy || reading}
        onChange={e => {
          const file = e.target.files?.[0]; const version = ++readVersion.current;
          setPhoto(undefined); setError(''); if (!file) return; setReading(true);
          void readPhoto(file).then(value => { if (version === readVersion.current) setPhoto(value); })
            .catch(cause => { if (version === readVersion.current) setError(cause.message); })
            .finally(() => { if (version === readVersion.current) setReading(false); });
        }}/>
      {reading && <p>画像を圧縮しています…</p>}
      {photo && <img src={`data:image/jpeg;base64,${photo}`} alt="アップロードする写真のプレビュー" style={{ maxWidth: '100%', maxHeight: 280 }}/>}
      {policy && <details><summary>登録の同意文面を確認</summary><PolicyContent body={policy.body} /></details>}
      <label className="face-consent"><input type="checkbox" checked={consent} disabled={busy}
        onChange={e => setConsent(e.target.checked)}/>今回の写真を AWS に送信して顔認証に使用すること、および登録時に氏名と連絡先の情報を保存することに同意します。</label>
    </section>
    {!registered ? <>
      <section className="face-card"><h2>登録テスト</h2>
        <label>ご本人の氏名<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={50} disabled={busy}/></label>
        <label>連絡先の氏名<input value={contactName} onChange={e => setContactName(e.target.value)} maxLength={50} disabled={busy}/></label>
        <label>連絡先のメールアドレス<input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} disabled={busy}/></label>
        <button disabled={!connected || !photo || !consent || busy || reading} onClick={() => void run('enrollment')}>写真をアップロードして登録</button>
      </section>
      <section className="face-card"><h2>登録済みの利用者を認証</h2><p>登録通知メールの送信が受理され、利用開始済みの利用者だけを照合します。</p>
        <button disabled={!connected || !photo || !consent || busy || reading} onClick={() => void run('safety')}>写真をアップロードして認証</button></section>
    </> : !checkId && <section className="face-card"><h2>登録した顔を確認</h2><p>別の写真を選択し、今回の利用に同意するチェックを入れてください。</p>
      <button disabled={!photo || !consent || busy || reading} onClick={() => void run('registration')}>写真をアップロードして本人確認</button></section>}
    {identified && !checkId && <section className="face-card"><h2>安否確認メール</h2>
      {!safetyContacts && <button disabled={busy} onClick={() => void runMail('contacts')}>本人です。連絡先を取得</button>}
      {safetyContacts && <><ul>{safetyContacts.recipients.map(contact => <li key={contact.recipient_id}>{contact.name}：{contact.masked_email}</li>)}</ul>
        <p style={{ whiteSpace: 'pre-line' }}>{safetyContacts.consent_body}</p>
        <label><input type="checkbox" checked={safetyConsent} onChange={e => setSafetyConsent(e.target.checked)}/>上記の連絡先に今回の安否確認通知を送信することに同意します</label>
        <button disabled={busy || !safetyConsent} onClick={() => void runMail('send')}>同意して安否確認メールを送信</button></>}
    </section>}
    {checkId && <section className="face-card"><h2>送信成功</h2><p>送信要求を受け付けました。</p></section>}
    {attempts.length > 0 && <section className="face-card"><h2>直近の検出結果</h2>{attempts.map((attempt, index) =>
      <article key={`${attempt.time}-${index}`}><h3>{attempt.time} · {attempt.result}</h3>
        <p>顔の類似度：{score(attempt.metrics.similarity_score)}
          {attempt.metrics.match_threshold !== undefined && `；照合のしきい値：${score(attempt.metrics.match_threshold)}`}</p>
        <p>顔検出の信頼度：{score(attempt.metrics.face_confidence)}；明るさ：{score(attempt.metrics.brightness)}；鮮明さ：{score(attempt.metrics.sharpness)}</p>
        <p>生体検知スコア：画像モードでは生体検知を行いません</p>
      </article>)}</section>}
    <button className="face-secondary" disabled={busy || reading} onClick={() => void cancel()}>操作を終了して画面の情報を消去</button>
  </main>;
}
