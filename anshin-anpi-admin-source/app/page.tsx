"use client";

/**
 * 安心安否確認システム：利用者向け画面
 *
 * 対象端末：Android／13.3インチ・タッチ液晶（横向き基準）
 * 対象画面：SCR-00〜SCR-14
 *
 * 顔登録・本人照合は同一オリジンの端末プロキシから実APIを呼び出します。
 * 撮影時の同意後に写真を一時保存し、登録確定時に資料をまとめて送信します。
 */

import {
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  HeartHandshake,
  LockKeyhole,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
  Wifi,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { createFaceClient, type FaceMetrics, type UserSession, type MailResult } from "@/lib/face-client";
import { FaceApiError } from "@/lib/face-api";

const faceClient = createFaceClient();

type ScreenId =
  | "SCR-00"
  | "SCR-01"
  | "SCR-02"
  | "SCR-03"
  | "SCR-04"
  | "SCR-05"
  | "SCR-06"
  | "SCR-07"
  | "SCR-08"
  | "SCR-09"
  | "SCR-10"
  | "SCR-11"
  | "SCR-12"
  | "SCR-13"
  | "SCR-14";
type Recipient = { name: string; email: string };

// 進捗表示に使用する画面順。画面遷移仕様書の正常系と同じ順序です。
const INITIAL_STEPS: ScreenId[] = [
  "SCR-02",
  "SCR-03",
  "SCR-04",
  "SCR-05",
  "SCR-06",
  "SCR-07",
  "SCR-08",
  "SCR-09",
];
const REPEAT_STEPS: ScreenId[] = [
  "SCR-10",
  "SCR-11",
  "SCR-12",
  "SCR-13",
  "SCR-14",
];

// ── 導入先で変更しやすい設定値 ──────────────────────────────────
const INACTIVITY_WARNING_MS = 60_000;
const TIMEOUT_GRACE_SECONDS = 30;
const COMPLETION_SECONDS = 10;

// 個人情報保護のため、確認画面ではメールアドレスのローカル部をマスクします。
function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const safeLocal =
    local.length > 2
      ? `${local.slice(0, 2)}•••`
      : `${local.slice(0, 1)}•••`;
  return domain
    ? `${safeLocal}@${domain}`
    : "ta•••@example.jp";
}

/** 端末共通ヘッダー：接続状態、時刻、仕様書上の画面IDを表示します。 */
function StatusHeader({ screen }: { screen: ScreenId }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () =>
      setTime(
        new Intl.DateTimeFormat("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
      );
    update();
    const id = window.setInterval(update, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <header className="status-header">
      <div
        className="brand-lockup"
        aria-label="安心安否確認システム"
      >
        <span className="brand-mark">
          <ShieldCheck aria-hidden="true" />
        </span>
        <span>
          <strong>安心安否確認</strong>
          <small>見守りメールサービス</small>
        </span>
      </div>
      <div
        className="terminal-status"
        aria-label="端末の状態"
      >
        <span>
          <LockKeyhole aria-hidden="true" />
          安全な接続
        </span>
        <span>
          <Wifi aria-hidden="true" />
          通信正常
        </span>
        <span>
          <Clock3 aria-hidden="true" />
          {time || "--:--"}
        </span>
        <span
          className="screen-code"
          aria-label={`画面番号 ${screen}`}
        >
          {screen}
        </span>
      </div>
    </header>
  );
}

/** 初回登録／安否確認の進捗を、色だけでなく番号とチェックでも伝えます。 */
function StepRail({ screen }: { screen: ScreenId }) {
  const isInitial = INITIAL_STEPS.includes(screen);
  const steps = isInitial ? INITIAL_STEPS : REPEAT_STEPS;
  const labels = isInitial
    ? [
        "顔登録",
        "お名前",
        "同意",
        "連絡先",
        "内容確認",
        "顔確認",
        "メール",
        "完了",
      ]
    : ["顔確認", "本人確認", "送信先", "送信同意", "完了"];
  const current = Math.max(0, steps.indexOf(screen));
  if (screen === "SCR-00" || screen === "SCR-01")
    return null;
  return (
    <nav
      className="step-rail"
      aria-label="手続きの進み具合"
    >
      <div className="step-meta">
        <span>{isInitial ? "初回登録" : "安否確認"}</span>
        <strong>
          {current + 1} / {steps.length}
        </strong>
      </div>
      <Progress
        value={((current + 1) / steps.length) * 100}
        className="step-progress"
      />
      <ol>
        {labels.map((label, index) => (
          <li
            key={label}
            className={
              index === current
                ? "is-current"
                : index < current
                  ? "is-done"
                  : ""
            }
          >
            <span>
              {index < current ? (
                <Check aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
            <small>{label}</small>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** 全画面で見出しの位置と読み上げ順を統一するための共通部品です。 */
function ScreenTitle({
  kicker,
  title,
  description,
}: {
  kicker: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="screen-title">
      <p>{kicker}</p>
      <h1>{title}</h1>
      {description && (
        <div className="screen-description">
          {description}
        </div>
      )}
    </div>
  );
}

/** 注意・警告・成功をアイコン、文言、色の3要素で表現します。 */
function Notice({
  tone = "info",
  icon,
  children,
}: {
  tone?: "info" | "warning" | "success";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`notice notice-${tone}`}
      role={tone === "warning" ? "alert" : "status"}
    >
      <span className="notice-icon">
        {icon ?? <CircleAlert aria-hidden="true" />}
      </span>
      <div>{children}</div>
    </div>
  );
}

/** 主要操作を画面下部へ固定し、高齢者が操作位置を覚えやすくします。 */
function ActionBar({
  onBack,
  onCancel,
  primary,
  secondary,
}: {
  onBack?: () => void;
  onCancel?: () => void;
  primary?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <footer className="action-bar">
      <div className="action-left">
        {onBack && (
          <Button
            variant="outline"
            className="touch-button quiet-button"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" />
            戻る
          </Button>
        )}
        {onCancel && (
          <Button
            variant="ghost"
            className="touch-button cancel-button"
            onClick={onCancel}
          >
            <X aria-hidden="true" />
            中止する
          </Button>
        )}
      </div>
      <div className="action-right">
        {secondary}
        {primary}
      </div>
    </footer>
  );
}

/**
 * 顔登録・顔照合画面の共通カメラ部品。
 * 画面表示中だけ前面カメラを取得し、アンマウント時に全トラックを停止します。
 * 実運用では onSuccess の前に、品質判定・生体判定・顔特徴生成を実行します。
 */
function CameraPanel({
  title,
  actionLabel,
  onSuccess,
}: {
  title: string;
  actionLabel: string;
  onSuccess: (imageBase64: string) => void | Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraState, setCameraState] = useState<
    "starting" | "ready" | "blocked"
  >("starting");
  const [retryKey, setRetryKey] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [photoConsent, setPhotoConsent] = useState(false);
  const captureLock = useRef(false);
  const capture = async () => {
    if (captureLock.current || !photoConsent) return;
    captureLock.current = true; setCapturing(true); setCaptureError('');
    try {
      const video = videoRef.current;
      if (!video?.videoWidth || !video.videoHeight || video.readyState < 2) throw new Error('カメラ映像の準備をお待ちください。');
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
      canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('写真を作成できません。');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      let imageBase64 = '';
      for (const quality of [0.85, 0.7, 0.5]) {
        const candidate = canvas.toDataURL('image/jpeg', quality).split(',')[1];
        if (candidate.length <= 690000) { imageBase64 = candidate; break; }
      }
      if (!imageBase64) throw new Error('写真が大きすぎます。もう一度撮影してください。');
      await onSuccess(imageBase64);
    } catch (cause) { setCaptureError(cause instanceof Error ? cause.message : '撮影できませんでした。'); }
    finally { captureLock.current = false; setCapturing(false); }
  };
  useEffect(() => {
    let active = true;
    // Android端末の前面カメラを優先して取得します。
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("camera unavailable");
        const stream =
          await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        if (!active) {
          stream
            .getTracks()
            .forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraState("ready");
      } catch {
        if (active) setCameraState("blocked");
      }
    };
    void start();
    // カメラ画面から離れたら必ずストリームを解放します（FR-002）。
    return () => {
      active = false;
      streamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [retryKey]);
  return (
    <div className="camera-layout">
      <section
        className="camera-card"
        aria-label="カメラ映像"
      >
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="前面カメラの映像"
        />
        <div className="face-guide" aria-hidden="true">
          <span className="guide-top" />
          <span className="guide-right" />
          <span className="guide-bottom" />
          <span className="guide-left" />
        </div>
        <div className={`camera-badge ${cameraState}`}>
          {cameraState === "ready" && (
            <>
              <CheckCircle2 aria-hidden="true" />
              顔を枠の中央に入れてください
            </>
          )}
          {cameraState === "starting" && (
            <>
              <RefreshCw
                className="spin"
                aria-hidden="true"
              />
              カメラを準備しています
            </>
          )}
          {cameraState === "blocked" && (
            <>
              <CircleAlert aria-hidden="true" />
              カメラを利用できません
            </>
          )}
        </div>
      </section>
      <aside className="camera-help">
        <div className="camera-help-head">
          <span>
            <Camera aria-hidden="true" />
          </span>
          <div>
            <small>撮影のポイント</small>
            <h2>{title}</h2>
          </div>
        </div>
        <ul className="check-list">
          <li>
            <Check aria-hidden="true" />
            お一人で映ってください
          </li>
          <li>
            <Check aria-hidden="true" />
            眼鏡やマスクを外してください
          </li>
          <li>
            <Check aria-hidden="true" />
            顔をまっすぐ向けてください
          </li>
        </ul>
        {cameraState === "blocked" ? (
          <div className="camera-error">
            <p>
              端末のカメラ許可をご確認ください。解決しない場合はスタッフへお声がけください。
            </p>
            <Button
              variant="outline"
              className="touch-button"
              onClick={() => {
                setCameraState("starting");
                setRetryKey((key) => key + 1);
              }}
            >
              <RefreshCw aria-hidden="true" />
              もう一度確認する
            </Button>
          </div>
        ) : (
          <Button
            className="touch-button primary-button camera-action"
            disabled={cameraState !== "ready" || capturing || !photoConsent}
            onClick={() => void capture()}
          >
            <Camera aria-hidden="true" />
            {actionLabel}
            <ChevronRight aria-hidden="true" />
          </Button>
        )}
        <label className="large-checkbox">
          <input type="checkbox" checked={photoConsent} disabled={capturing}
            onChange={event => setPhotoConsent(event.target.checked)}/>
          この写真をAWSで顔認識に使用することに同意します。初回登録では登録内容の確認後に送信します。
        </label>
        {captureError && <p role="alert" className="field-error">{captureError}</p>}
        <p className="privacy-note">
          <LockKeyhole aria-hidden="true" />
          カメラ映像はこの確認中だけ使用します
        </p>
      </aside>
    </div>
  );
}

/** 送信先名・マスク済みメール・宛先別結果を表示する共通カードです。 */
function RecipientCard({
  name,
  email,
  status,
}: {
  name: string;
  email: string;
  status?: "success" | "failed";
}) {
  return (
    <div
      className={`recipient-card ${status ? `result-${status}` : ""}`}
    >
      <span className="recipient-avatar">
        <UserRound aria-hidden="true" />
      </span>
      <div className="recipient-copy">
        <small>送信相手</small>
        <strong>{name}</strong>
        <span>{maskEmail(email)}</span>
      </div>
      {status === "success" && (
        <span className="result-pill">
          <CheckCircle2 aria-hidden="true" />
          送信受付済み
        </span>
      )}
      {status === "failed" && (
        <span className="result-pill failed">
          <CircleAlert aria-hidden="true" />
          未送信
        </span>
      )}
    </div>
  );
}

export default function Home() {
  // 現在画面。URLやブラウザ履歴へ個人情報を残さないため、画面状態はメモリ内だけで管理します。
  const [screen, setScreen] = useState<ScreenId>("SCR-00");

  // 初回登録で入力する一時データ。取消・完了・タイムアウト時に clearPrivateState で消去します。
  const [name, setName] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>(
    [
      { name: "", email: "" },
      { name: "", email: "" },
    ],
  );
  const [useSecondRecipient, setUseSecondRecipient] =
    useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [sendAgreed, setSendAgreed] = useState(false);
  const [processingLabel, setProcessingLabel] = useState<
    string | null
  >(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    TIMEOUT_GRACE_SECONDS,
  );
  const [completeSeconds, setCompleteSeconds] = useState(
    COMPLETION_SECONDS,
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [contactsTouched, setContactsTouched] =
    useState(false);
  const [faceReady, setFaceReady] = useState(false);
  const [registrationPolicy, setRegistrationPolicy] = useState<{ policy_version: string; body: string }>();
  const [faceError, setFaceError] = useState('');
  const [faceMessage, setFaceMessage] = useState('正在连接人脸接口…');
  const [faceMetrics, setFaceMetrics] = useState<Partial<FaceMetrics>>();
  const [verifiedName, setVerifiedName] = useState('');
  const [mailCheckId, setMailCheckId] = useState<string>();
  const [mailResult, setMailResult] = useState<MailResult>();
  const [safetyContacts, setSafetyContacts] = useState<Awaited<ReturnType<typeof faceClient.confirmRecipients>>>();
  const faceDraft = useRef<string | undefined>(undefined);
  const faceSession = useRef<UserSession | undefined>(undefined);
  const operationVersion = useRef(0);
  const apiBusy = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.all([faceClient.terminal(), faceClient.registrationPolicy()]).then(([terminal, policy]) => {
      if (!active) return;
      if (!terminal.capabilities.face) throw new Error('人脸服务未配置');
      setFaceReady(true); setRegistrationPolicy(policy); setFaceMessage('真实人脸接口已连接；图片模式不检测活体。');
    }).catch(() => { if (active) { setFaceReady(false); setFaceError('人脸接口未连接，请确认前端代理和本地后端已启动。'); } });
    return () => {
      active = false; operationVersion.current++;
      if (faceDraft.current) void faceClient.cancelRegistration(faceDraft.current).catch(() => {});
      if (faceSession.current) void faceClient.endSession(faceSession.current.user_token).catch(() => {});
    };
  }, []);

  // 連絡先は仕様書どおり1名必須・最大2名です。
  const activeRecipients = useMemo(
    () => recipients.slice(0, useSecondRecipient ? 2 : 1),
    [recipients, useSecondRecipient],
  );
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const nameValid =
    name.trim().length >= 1 && name.trim().length <= 50;
  const contactsValid =
    activeRecipients.every(
      (recipient) =>
        recipient.name.trim().length > 0 &&
        emailPattern.test(recipient.email.trim()),
    ) &&
    (activeRecipients.length < 2 ||
      activeRecipients[0].email.trim().toLowerCase() !==
        activeRecipients[1].email.trim().toLowerCase());

  /** 端末メモリ上の氏名・連絡先・同意状態をまとめて破棄します。 */
  const clearPrivateState = useCallback(() => {
    operationVersion.current++;
    setMailCheckId(undefined); setMailResult(undefined); setSafetyContacts(undefined);
    if (faceDraft.current) void faceClient.cancelRegistration(faceDraft.current).catch(() => {});
    if (faceSession.current) void faceClient.endSession(faceSession.current.user_token).catch(() => {});
    faceDraft.current = undefined; faceSession.current = undefined;
    setFaceError(''); setFaceMetrics(undefined); setVerifiedName('');
    setFaceMessage('本次操作已结束。');
    setName("");
    setRecipients([
      { name: "", email: "" },
      { name: "", email: "" },
    ]);
    setUseSecondRecipient(false);
    setPrivacyAgreed(false);
    setSendAgreed(false);
    setNameTouched(false);
    setContactsTouched(false);
  }, []);
  /** 共通終了処理：個人情報を消去してSCR-00へ戻します。 */
  const goHome = useCallback(() => {
    clearPrivateState();
    setCancelOpen(false);
    setTimeoutOpen(false);
    setProcessingLabel(null);
    setCompleteSeconds(COMPLETION_SECONDS);
    setScreen("SCR-00");
  }, [clearPrivateState]);
  const runFaceApi = async (label: string, action: (checkActive: () => void) => Promise<void>) => {
    if (apiBusy.current) return;
    if (!faceReady) { setFaceError('人脸接口未连接。'); return; }
    apiBusy.current = true;
    const version = operationVersion.current;
    const checkActive = () => { if (version !== operationVersion.current) throw new Error('OPERATION_CANCELLED'); };
    setFaceError(''); setProcessingLabel(label);
    try { await action(checkActive); }
    catch (cause) {
      if (version !== operationVersion.current) return;
      if (cause instanceof FaceApiError) {
        const messages: Record<string, string> = {
          'FACE-001': '照片中没有检测到人脸。', 'FACE-002': '请确保照片中只有一人。',
          FACE_QUALITY_FAILED: '照片质量未通过，请调整光线、清晰度和脸部角度。',
          USER_SESSION_EXPIRED: '验证会话已过期，请返回首页重新开始。',
          FACE_AUTH_EXPIRED: '本机 AWS 登录已过期。', FACE_ACCESS_DENIED: 'AWS 权限不足。',
          POLICY_VERSION_CHANGED: '同意文案已更新，请返回首页后刷新页面。',
        };
        setFaceError(cause.status === 429 ? `操作受限，请${cause.retryAfterSeconds ? `等待 ${cause.retryAfterSeconds} 秒后` : '稍后'}重试。`
          : `${messages[cause.code] ?? '人脸接口操作未完成。'}（${cause.code}）`
            + (typeof cause.details?.aws_error === 'string' ? ` ${cause.details.aws_error}` : ''));
        setFaceMetrics(cause.details as Partial<FaceMetrics> | undefined);
      } else setFaceError(cause instanceof Error ? cause.message : '人脸处理失败。');
    } finally { apiBusy.current = false; if (version === operationVersion.current) setProcessingLabel(null); }
  };

  const captureFirstFace = (photo: string) => runFaceApi('写真を確認しています', async checkActive => {
    if (faceDraft.current) await faceClient.cancelRegistration(faceDraft.current);
    const draft = await faceClient.captureRegistration(photo);
    faceDraft.current = draft.temp_id;
    try { checkActive(); } catch (cause) { void faceClient.cancelRegistration(draft.temp_id).catch(() => {}); faceDraft.current = undefined; throw cause; }
    setFaceMetrics(draft.metrics); setFaceMessage('照片已通过检查并暂存，请填写登记资料。'); setScreen('SCR-03');
  });

  const registerCapturedFace = () => runFaceApi('登録情報を保存しています', async checkActive => {
    if (!faceDraft.current || !privacyAgreed || !registrationPolicy || !nameValid || !contactsValid) throw new Error('请完成拍照、姓名、联系人和登记同意。');
    const completed = await faceClient.register({temp_id: faceDraft.current, display_name: name, recipients: activeRecipients,
      policy_version: registrationPolicy.policy_version, consent_result: 'granted'});
    if (!completed.user_id || !completed.user_token || !completed.expires_at) throw new Error('登记未完成。');
    faceDraft.current = undefined;
    faceSession.current = {user_id: completed.user_id, user_token: completed.user_token, expires_at: completed.expires_at};
    try { checkActive(); } catch (cause) { void faceClient.endSession(completed.user_token).catch(() => {}); faceSession.current = undefined; throw cause; }
    setFaceMessage('资料已保存，请再次拍照。比对通过后将自动发送登记通知。'); setScreen('SCR-07');
  });

  const recognizeCapturedFace = (photo: string, registration: boolean) => runFaceApi('写真を照合しています', async checkActive => {
    if (registration && !faceSession.current?.user_id) throw new Error('请先完成登记。');
    const result = registration
      ? await faceClient.verifyAndNotify(photo, faceSession.current!.user_id!, faceSession.current!.user_token)
      : await faceClient.identify(photo);
    if (result.user_token && result.expires_at) faceSession.current = {user_id: result.user_id, user_token: result.user_token, expires_at: result.expires_at};
    try { checkActive(); } catch (cause) { if (result.user_token) void faceClient.endSession(result.user_token).catch(() => {}); faceSession.current = undefined; throw cause; }
    setFaceMetrics(result.metrics);
    if (result.result !== 'matched') { setFaceError(result.result === 'ambiguous' ? '候选人脸相近，无法确认本人。' : '未匹配到用户。日常识别只匹配已激活用户。'); return; }
    setVerifiedName(result.display_name ?? ''); setMailCheckId(result.check_id); setMailResult(undefined);
    setFaceMessage(registration ? '比对通过，登记通知已入队。请查询邮件结果。' : '人脸匹配成功，请确认本人。');
    setScreen(registration ? 'SCR-08' : 'SCR-11');
  });

  const confirmPerson = (confirmed: boolean) => runFaceApi('本人を確認しています', async checkActive => {
    const current = faceSession.current;
    if (!current?.user_id) throw new Error('请重新识别本人。');
    const result = await faceClient.confirmRecipients(current.user_id, confirmed, current.user_token); checkActive();
    if (!confirmed) { goHome(); return; }
    setSafetyContacts(result); setScreen('SCR-12');
  });

  const sendSafetyMail = () => runFaceApi('安否通知を受け付けています', async checkActive => {
    const current = faceSession.current;
    if (!current?.user_id || !sendAgreed || !safetyContacts?.policy_version) throw new Error('请确认本人并同意发送。');
    const result = await faceClient.notifySafety(current.user_id, true, safetyContacts.policy_version, current.user_token); checkActive();
    if (!result.check_id) throw new Error('邮件请求未受理。');
    setMailCheckId(result.check_id); setMailResult(undefined); setScreen('SCR-14');
  });

  const queryMail = () => runFaceApi('メール結果を確認しています', async checkActive => {
    if (!faceSession.current || !mailCheckId) throw new Error('没有可查询的邮件记录。');
    const result = await faceClient.mailResult(mailCheckId, faceSession.current.user_token); checkActive(); setMailResult(result);
    setFaceMessage(`邮件状态：${result.mail_status}；用户状态：${result.user_status}。`);
    if (result.registration_completed) setScreen('SCR-09');
  });

  // SCR-09／SCR-14は10秒後にホームへ戻します（C-006）。
  useEffect(() => {
    if (screen !== "SCR-09" && !(screen === "SCR-14" && mailResult?.mail_status === "accepted")) return;
    const interval = window.setInterval(
      () =>
        setCompleteSeconds((seconds) => {
          if (seconds <= 1) {
            window.clearInterval(interval);
            window.setTimeout(goHome, 0);
            return 0;
          }
          return seconds - 1;
        }),
      1000,
    );
    return () => window.clearInterval(interval);
  }, [screen, goHome, mailResult?.mail_status]);

  // 60秒無操作でDLG-03を表示。ポインター操作・キー入力で計測をリセットします。
  useEffect(() => {
    if (
      screen === "SCR-00" ||
      screen === "SCR-09" ||
      screen === "SCR-14" ||
      processingLabel
    )
      return;
    let warningTimer = window.setTimeout(() => {
      setTimeoutSeconds(TIMEOUT_GRACE_SECONDS);
      setTimeoutOpen(true);
    }, INACTIVITY_WARNING_MS);
    const reset = () => {
      if (timeoutOpen) return;
      window.clearTimeout(warningTimer);
      warningTimer = window.setTimeout(() => {
        setTimeoutSeconds(TIMEOUT_GRACE_SECONDS);
        setTimeoutOpen(true);
      }, INACTIVITY_WARNING_MS);
    };
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.clearTimeout(warningTimer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [screen, processingLabel, timeoutOpen]);

  // 警告表示後さらに30秒無操作なら、個人情報を消去して自動終了します。
  useEffect(() => {
    if (!timeoutOpen) return;
    const interval = window.setInterval(
      () =>
        setTimeoutSeconds((seconds) => {
          if (seconds <= 1) {
            window.clearInterval(interval);
            window.setTimeout(goHome, 0);
            return 0;
          }
          return seconds - 1;
        }),
      1000,
    );
    return () => window.clearInterval(interval);
  }, [timeoutOpen, goHome]);

  // 連絡先配列を破壊せず更新します。バックエンド送信前にも同じ検証を必ず実施してください。
  const updateRecipient = (
    index: number,
    field: keyof Recipient,
    value: string,
  ) =>
    setRecipients((current) =>
      current.map((recipient, i) =>
        i === index
          ? { ...recipient, [field]: value }
          : recipient,
      ),
    );

  /** 画面IDごとの表示。仕様書との対応を追いやすくするため switch で明示しています。 */
  const renderScreen = () => {
    switch (screen) {
      // ── 共通入口 ──────────────────────────────────────────────
      case "SCR-00":
        return (
          <div className="home-screen">
            <div className="home-copy">
              <div className="home-symbol">
                <HeartHandshake aria-hidden="true" />
              </div>
              <p className="home-kicker">
                ご家族へ、今の安心をお知らせします
              </p>
              <h1>安心安否確認</h1>
              <p>
                顔を確認して、登録した方へ
                <br />
                かんたんにメールを送れます。
              </p>
              <Button
                className="home-button"
                onClick={() => setScreen("SCR-01")}
              >
                <span>安心安否確認をはじめる</span>
                <ChevronRight aria-hidden="true" />
              </Button>
              <div className="home-assist">
                <CircleAlert aria-hidden="true" />
                <span>
                  このサービスは緊急通報ではありません。緊急時は119番・110番をご利用ください。
                </span>
              </div>
            </div>
            <div className="home-visual" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="home-mail">
                <Mail />
                <span>
                  <Check />
                </span>
              </div>
              <div className="home-person person-one">
                <UserRound />
              </div>
              <div className="home-person person-two">
                <UserRound />
              </div>
            </div>
          </div>
        );
      case "SCR-01":
        return (
          <div className="content-screen">
            <ScreenTitle
              kicker="利用方法を選んでください"
              title="安心安否確認を始めます"
              description="顔の登録をする方と、すでに登録済みの方で入口が分かれています。"
            />
            <div className="choice-grid">
              <button
                className="choice-card initial-choice"
                onClick={() => setScreen("SCR-02")}
              >
                <span className="choice-number">
                  初めての方
                </span>
                <span className="choice-icon">
                  <UserRound aria-hidden="true" />
                  <span>
                    <Check />
                  </span>
                </span>
                <strong>初回登録をする</strong>
                <small>
                  顔・お名前・送信相手を登録します
                </small>
                <span className="choice-arrow">
                  <ChevronRight />
                </span>
              </button>
              <button
                className="choice-card repeat-choice"
                onClick={() => setScreen("SCR-10")}
              >
                <span className="choice-number">
                  登録済みの方
                </span>
                <span className="choice-icon">
                  <Mail aria-hidden="true" />
                </span>
                <strong>安否確認を送る</strong>
                <small>
                  顔を確認して、登録先へ送信します
                </small>
                <span className="choice-arrow">
                  <ChevronRight />
                </span>
              </button>
            </div>
            <Notice tone="warning">
              <strong>緊急通報ではありません</strong>
              <span>
                メールの受信・閲覧を保証するサービスではありません。
              </span>
            </Notice>
            <ActionBar onBack={() => setScreen("SCR-00")} />
          </div>
        );
      // ── 初回登録：SCR-02〜SCR-09 ─────────────────────────────
      case "SCR-02":
        return (
          <div className="content-screen camera-screen">
            <ScreenTitle
              kicker="初回登録 1 / 8"
              title="顔を登録します"
              description="画面の枠に顔を合わせて、撮影ボタンを押してください。"
            />
            <CameraPanel
              title="明るい場所で、正面を向きます"
              actionLabel="顔を撮影する"
              onSuccess={captureFirstFace}
            />
            <ActionBar
              onBack={() => setScreen("SCR-01")}
              onCancel={() => setCancelOpen(true)}
            />
          </div>
        );
      case "SCR-03":
        return (
          <div className="content-screen narrow-screen">
            <ScreenTitle
              kicker="初回登録 2 / 8"
              title="お名前を入力してください"
              description="ご家族に分かるお名前、または普段呼ばれているお名前を入力します。"
            />
            <section className="form-card">
              <div className="field-group">
                <Label htmlFor="user-name">
                  お名前{" "}
                  <span className="required-chip">
                    必須
                  </span>
                </Label>
                <Input
                  id="user-name"
                  value={name}
                  maxLength={50}
                  autoComplete="off"
                  placeholder="例：山田 太郎"
                  className="kiosk-input"
                  onBlur={() => setNameTouched(true)}
                  onChange={(event) =>
                    setName(event.target.value)
                  }
                  aria-invalid={nameTouched && !nameValid}
                />
                {nameTouched && !nameValid ? (
                  <p className="field-error">
                    <CircleAlert />
                    1文字以上50文字以内で入力してください。
                  </p>
                ) : (
                  <p className="field-hint">
                    ひらがな・カタカナ・漢字で入力できます。
                  </p>
                )}
              </div>
              <div className="input-preview">
                <small>表示の確認</small>
                <strong>
                  {name.trim() ||
                    "入力したお名前がここに表示されます"}
                </strong>
              </div>
            </section>
            <ActionBar
              onBack={() => setScreen("SCR-02")}
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  disabled={!nameValid}
                  onClick={() => {
                    setNameTouched(true);
                    setScreen("SCR-04");
                  }}
                >
                  次へ
                  <ChevronRight />
                </Button>
              }
            />
          </div>
        );
      case "SCR-04":
        return (
          <div className="content-screen consent-screen">
            <ScreenTitle
              kicker="初回登録 3 / 8"
              title="個人情報の取扱いについて"
              description="内容をお読みいただき、同意できる場合はチェックを入れてください。"
            />
            <section
              className="consent-card"
              tabIndex={0}
              aria-label="個人情報の取扱い本文"
            >
              {registrationPolicy ? <p style={{ whiteSpace: 'pre-wrap' }}>{registrationPolicy.body}</p> : <p>同意文面を読み込んでいます。接続状態をご確認ください。</p>}
            </section>
            <label
              className={`large-checkbox ${privacyAgreed ? "is-checked" : ""}`}
            >
              <Checkbox
                checked={privacyAgreed}
                onCheckedChange={(checked) =>
                  setPrivacyAgreed(checked === true)
                }
                className="kiosk-checkbox"
              />
              <span>
                上記の内容を読み、個人情報の取扱いと顔特徴データを用いた本人確認に同意します。
              </span>
            </label>
            <ActionBar
              onBack={() => setScreen("SCR-03")}
              primary={
                <>
                  <Button
                    variant="outline"
                    className="touch-button quiet-button"
                    onClick={() => setCancelOpen(true)}
                  >
                    同意しない
                  </Button>
                  <Button
                    className="touch-button primary-button"
                    disabled={!privacyAgreed || !registrationPolicy}
                    onClick={() => setScreen("SCR-05")}
                  >
                    同意して次へ
                    <ChevronRight />
                  </Button>
                </>
              }
            />
          </div>
        );
      case "SCR-05":
        return (
          <div className="content-screen contacts-screen">
            <ScreenTitle
              kicker="初回登録 4 / 8"
              title="メールを送る相手を登録します"
              description="1名は必須、2名まで登録できます。現在は顔登録のテストです。確認メールはまだ送信しません。"
            />
            <div className="contacts-grid">
              {[0, ...(useSecondRecipient ? [1] : [])].map(
                (index) => {
                  const recipient = recipients[index];
                  const invalid =
                    contactsTouched &&
                    (!recipient.name.trim() ||
                      !emailPattern.test(
                        recipient.email.trim(),
                      ));
                  return (
                    <section
                      className="contact-card"
                      key={index}
                    >
                      <div className="contact-heading">
                        <span>{index + 1}</span>
                        <h2>送信相手 {index + 1}</h2>
                        <em>
                          {index === 0 ? "必須" : "任意"}
                        </em>
                      </div>
                      <div className="field-group compact">
                        <Label
                          htmlFor={`contact-name-${index}`}
                        >
                          お名前
                        </Label>
                        <Input
                          id={`contact-name-${index}`}
                          value={recipient.name}
                          placeholder="例：山田 花子"
                          className="kiosk-input"
                          onChange={(event) =>
                            updateRecipient(
                              index,
                              "name",
                              event.target.value,
                            )
                          }
                        />
                      </div>
                      <div className="field-group compact">
                        <Label
                          htmlFor={`contact-email-${index}`}
                        >
                          メールアドレス
                        </Label>
                        <Input
                          id={`contact-email-${index}`}
                          value={recipient.email}
                          inputMode="email"
                          autoCapitalize="none"
                          placeholder="例：hanako@example.jp"
                          className="kiosk-input"
                          onChange={(event) =>
                            updateRecipient(
                              index,
                              "email",
                              event.target.value,
                            )
                          }
                        />
                      </div>
                      {invalid && (
                        <p className="field-error">
                          <CircleAlert />
                          お名前と正しいメールアドレスを入力してください。
                        </p>
                      )}
                    </section>
                  );
                },
              )}
              {!useSecondRecipient && (
                <button
                  className="add-contact"
                  onClick={() =>
                    setUseSecondRecipient(true)
                  }
                >
                  <span>＋</span>
                  <strong>2人目を登録する</strong>
                  <small>送信相手は最大2名まで</small>
                </button>
              )}
              {useSecondRecipient && (
                <button
                  className="remove-contact"
                  onClick={() => {
                    setUseSecondRecipient(false);
                    updateRecipient(1, "name", "");
                    updateRecipient(1, "email", "");
                  }}
                >
                  <X />
                  2人目を削除する
                </button>
              )}
            </div>
            {contactsTouched &&
              activeRecipients.length === 2 &&
              activeRecipients[0].email
                .trim()
                .toLowerCase() ===
                activeRecipients[1].email
                  .trim()
                  .toLowerCase() && (
                <p className="form-wide-error">
                  <CircleAlert />
                  同じメールアドレスを重複して登録することはできません。
                </p>
              )}
            <ActionBar
              onBack={() => setScreen("SCR-04")}
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  disabled={!contactsValid}
                  onClick={() => {
                    setContactsTouched(true);
                    setScreen("SCR-06");
                  }}
                >
                  登録内容を確認する
                  <ChevronRight />
                </Button>
              }
            />
          </div>
        );
      case "SCR-06":
        return (
          <div className="content-screen review-screen">
            <ScreenTitle
              kicker="初回登録 5 / 8"
              title="登録内容をご確認ください"
              description="間違いがなければ「この内容で登録する」を押してください。"
            />
            <div className="review-grid">
              <section className="review-card identity-review">
                <div className="review-heading">
                  <UserRound />
                  <span>
                    <small>ご本人</small>
                    <h2>{name}</h2>
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="edit-button"
                  onClick={() => setScreen("SCR-03")}
                >
                  修正する
                </Button>
              </section>
              <section className="review-card recipients-review">
                <div className="review-heading">
                  <UsersRound />
                  <span>
                    <small>メールを送る相手</small>
                    <h2>{activeRecipients.length}名</h2>
                  </span>
                </div>
                <div className="review-recipient-list">
                  {activeRecipients.map((recipient) => (
                    <RecipientCard
                      key={recipient.email}
                      name={recipient.name}
                      email={recipient.email}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  className="edit-button"
                  onClick={() => setScreen("SCR-05")}
                >
                  修正する
                </Button>
              </section>
            </div>
            <Notice icon={<ShieldCheck />}>
              <strong>
                登録後に、もう一度顔の確認を行います
              </strong>
              <span>
                顔画像は画面に表示せず、確認に必要な特徴データのみを使用します。
              </span>
            </Notice>
            <ActionBar
              onBack={() => setScreen("SCR-05")}
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  disabled={!faceReady || !!processingLabel}
                  onClick={() => void registerCapturedFace()}
                >
                  この内容で登録する
                  <ChevronRight />
                </Button>
              }
            />
          </div>
        );
      case "SCR-07":
        return (
          <div className="content-screen camera-screen">
            <ScreenTitle
              kicker="初回登録 6 / 8"
              title="顔の登録を確認します"
              description="登録が正しくできたか確認するため、もう一度カメラに顔を向けてください。"
            />
            <CameraPanel
              title="登録時と同じように、正面を向きます"
              actionLabel="登録を確認する"
              onSuccess={imageBase64 => recognizeCapturedFace(imageBase64, true)}
            />
            <ActionBar
              onCancel={() => setCancelOpen(true)}
            />
          </div>
        );
      case "SCR-08":
        return (
          <div className="content-screen result-screen">
            <ScreenTitle
              kicker="初回登録 7 / 8"
              title="顔の登録と本人照合が成功しました"
              description="写真を実際に後端へ送信し、AWSの顔照合が完了しました。"
            />
            <div className="success-banner">
              <span>
                <CheckCircle2 />
              </span>
              <div>
                <h2>顔の登録を確認できました</h2>
                <p>{verifiedName}さんの顔を確認しました。</p>
              </div>
            </div>
            <Notice tone="info" icon={<Mail />}>
              <strong>
                {mailResult ? `邮件状态：${mailResult.mail_status}` : '登记通知正在处理'}
              </strong>
              <span>
                登记通知已自动提交后台。全部联系人的邮件受理成功后，登记才完成。
              </span>
            </Notice>
            {mailResult && <div className="result-list">{mailResult.recipient_results.map((item, index) =>
              <p key={item.delivery_id}>連絡先 {index + 1}：{item.status}{item.error_code ? `（${item.error_code}）` : ''}</p>)}</div>}
            <ActionBar
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  onClick={() => void queryMail()}
                >
                  メール結果を確認する
                  <ChevronRight />
                </Button>
              }
            />
          </div>
        );
      case "SCR-09":
        return (
          <div className="completion-screen">
            <div className="completion-icon">
              <CheckCircle2 />
            </div>
            <p>初回登録が完了しました</p>
            <h1>ご登録ありがとうございます</h1>
            <div className="completion-summary">
              <ShieldCheck />
              <span>
                <strong>{name}さん</strong>
                <small>
                  次回からは顔を確認して安否メールを送れます
                </small>
              </span>
            </div>
            <Button
              className="touch-button primary-button complete-button"
              onClick={goHome}
            >
              終了してホームへ戻る
            </Button>
            <p className="countdown">
              何もしない場合は{" "}
              <strong>{completeSeconds}秒後</strong>{" "}
              に自動で終了します
            </p>
          </div>
        );
      // ── 2回目以降：SCR-10〜SCR-14 ────────────────────────────
      case "SCR-10":
        return (
          <div className="content-screen camera-screen">
            <ScreenTitle
              kicker="安否確認 1 / 5"
              title="顔をカメラに向けてください"
              description="登録されているご本人か確認します。お名前は確認できた場合だけ表示します。"
            />
            <CameraPanel
              title="明るい場所で、正面を向きます"
              actionLabel="顔を確認する"
              onSuccess={imageBase64 => recognizeCapturedFace(imageBase64, false)}
            />
            <ActionBar
              onCancel={() => setCancelOpen(true)}
            />
          </div>
        );
      case "SCR-11":
        return (
          <div className="identity-screen">
            <ScreenTitle
              kicker="安否確認 2 / 5"
              title="ご本人に間違いありませんか？"
            />
            <div className="identity-card">
              <div className="identity-avatar">
                <UserRound />
              </div>
              <p>確認できたお名前</p>
              <h2>{verifiedName}さん</h2>
              <span>このお名前で登録されています</span>
            </div>
            <div className="identity-actions">
              <Button
                variant="outline"
                className="identity-no"
                onClick={() => void confirmPerson(false)}
              >
                <X />
                ちがいます
              </Button>
              <Button
                className="identity-yes"
                onClick={() => void confirmPerson(true)}
              >
                <Check />
                はい、本人です
                <ChevronRight />
              </Button>
            </div>
            <p className="privacy-note centered">
              <LockKeyhole />
              「ちがいます」を押すと、お名前と確認情報をすぐに消去します
            </p>
          </div>
        );
      case "SCR-12":
        return (
          <div className="content-screen recipient-screen">
            <ScreenTitle
              kicker="安否確認 3 / 5"
              title="安否確認メールを送信します"
              description={`下記の登録済みの方へ、${verifiedName}さんが操作したことをメールでお知らせします。`}
            />
            <div className="recipient-intro">
              <span>
                <Mail />
              </span>
              <div>
                <small>今回の送信先</small>
                <strong>
                  {(safetyContacts?.recipients.length ?? 0)}名へ送信します
                </strong>
              </div>
            </div>
            <div className="result-list">
              {(safetyContacts?.recipients ?? []).map((recipient) => (
                <RecipientCard
                  key={recipient.recipient_id}
                  name={recipient.name}
                  email={recipient.masked_email}
                />
              ))}
            </div>
            <Notice tone="warning">
              <strong>
                このサービスは緊急通報ではありません
              </strong>
              <span>
                送信先と内容を確認してから次へ進んでください。
              </span>
            </Notice>
            <ActionBar
              onBack={() => setScreen("SCR-11")}
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  onClick={() => setScreen("SCR-13")}
                >
                  安否確認メールを送る
                  <ChevronRight />
                </Button>
              }
            />
          </div>
        );
      case "SCR-13":
        return (
          <div className="content-screen send-consent-screen">
            <ScreenTitle
              kicker="安否確認 4 / 5"
              title="送信内容をご確認ください"
              description={`同意して送信ボタンを押すと、登録済みの${(safetyContacts?.recipients.length ?? 0)}名へそれぞれ1通ずつ送信します。`}
            />
            <section className="mail-preview">
              <div className="mail-preview-head">
                <Mail />
                <span>
                  <small>送信されるメール</small>
                  <strong>
                    【安心安否確認】{verifiedName}
                    さんからのお知らせ
                  </strong>
                </span>
              </div>
              <div className="mail-body">
                <p>
                  {verifiedName}
                  さんが、安否確認操作を行いました。
                </p>
                <p>
                  本人の操作により送信された自動メールです。
                </p>
                <small>
                  顔画像や顔特徴データはメールに含まれません。
                </small>
              </div>
            </section>
            <Notice tone="info"><span>{safetyContacts?.consent_body}</span></Notice>
            <label
              className={`large-checkbox send-checkbox ${sendAgreed ? "is-checked" : ""}`}
            >
              <Checkbox
                checked={sendAgreed}
                onCheckedChange={(checked) =>
                  setSendAgreed(checked === true)
                }
                className="kiosk-checkbox"
              />
              <span>
                上記の送信内容と送信先を確認し、安否確認メールの送信に同意します。
              </span>
            </label>
            <ActionBar
              onBack={() => setScreen("SCR-12")}
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button send-button"
                  disabled={!sendAgreed}
                  onClick={() => void sendSafetyMail()}
                >
                  <ShieldCheck />
                  同意して送信する
                </Button>
              }
            />
          </div>
        );
      case "SCR-14":
        return (
          <div className="content-screen result-screen final-result">
            <div className="final-hero">
              <div className="completion-icon small">
                <CheckCircle2 />
              </div>
              <div>
                <p>安否確認 5 / 5</p>
                <h1>{mailResult?.mail_status === "accepted" ? "送信が受け付けられました" : "メール処理結果"}</h1>
                <span>
                  {new Intl.DateTimeFormat("ja-JP", {
                    dateStyle: "long",
                    timeStyle: "short",
                  }).format(new Date())}
                </span>
              </div>
            </div>
            <div className="result-list">
              {(safetyContacts?.recipients ?? []).map((recipient) => (
                <RecipientCard
                  key={recipient.recipient_id}
                  name={recipient.name}
                  email={recipient.masked_email}
                  status={mailResult?.recipient_results.find(item => item.recipient_id === recipient.recipient_id)?.status === 'accepted' ? 'success' : undefined}
                />
              ))}
            </div>
            <Notice tone={mailResult?.mail_status === 'accepted' ? 'success' : 'info'} icon={<ShieldCheck />}>
              <strong>
                {mailResult ? `処理状態：${mailResult.mail_status}` : 'メール処理中です。結果を確認してください。'}
              </strong>
              <span>
                同じ操作によるメールは重複して送信されません。
              </span>
            </Notice>
            {mailResult && <div className="result-list">{mailResult.recipient_results.map((item, index) =>
              <p key={item.delivery_id}>連絡先 {index + 1}：{item.status}{item.error_code ? `（${item.error_code}）` : ''}</p>)}</div>}
            <ActionBar
              primary={
                <>
                  <Button className="touch-button" onClick={() => void queryMail()}>メール結果を確認する</Button>
                  {mailResult?.mail_status === 'accepted' && <p className="bar-countdown">
                    自動終了まで{" "}
                    <strong>{completeSeconds}秒</strong>
                  </p>}
                  <Button
                    className="touch-button primary-button"
                    onClick={goHome}
                  >
                    終了してホームへ戻る
                  </Button>
                </>
              }
            />
          </div>
        );
    }
  };

  return (
    <main
      className="kiosk-shell"
      onContextMenu={(event) => { if (!import.meta.env.DEV) event.preventDefault(); }}
    >
      {/* 全画面共通：端末状態、手続き進捗、現在画面 */}
      <StatusHeader screen={screen} />
      <section aria-label="真实人脸接口状态" style={{ padding: '8px 24px', background: '#f1f5f9' }}>
        <p role="status">{faceMessage}</p>
        {faceError && <p role="alert" style={{ color: '#b91c1c' }}>{faceError}</p>}
        {faceMetrics && <p>
          人脸相似度：{typeof faceMetrics.similarity_score === 'number' ? faceMetrics.similarity_score.toFixed(2) : '无可用分数'}
          {typeof faceMetrics.match_threshold === 'number' && `；匹配门槛：${faceMetrics.match_threshold.toFixed(2)}`}
          ；人脸检测置信度：{typeof faceMetrics.face_confidence === 'number' ? faceMetrics.face_confidence.toFixed(2) : '无可用分数'}
          ；亮度：{typeof faceMetrics.brightness === 'number' ? faceMetrics.brightness.toFixed(2) : '无可用分数'}
          ；清晰度：{typeof faceMetrics.sharpness === 'number' ? faceMetrics.sharpness.toFixed(2) : '无可用分数'}
          。图片模式不检测活体。
        </p>}
      </section>
      {import.meta.env.DEV && <nav aria-label="真实接口测试" style={{ padding: '8px 24px', textAlign: 'right' }}>
        <a href="/dev/face">真实人脸接口测试：图片登记 / 识别 / 评分</a>
      </nav>}
      <StepRail screen={screen} />
      <div className="screen-stage">{renderScreen()}</div>

      {/* OVL-01：API処理中の多重操作を防止する全画面オーバーレイ */}
      {processingLabel && (
        <div
          className="processing-overlay"
          role="alert"
          aria-live="assertive"
        >
          <div className="processing-card">
            <span className="processing-spinner">
              <ShieldCheck />
            </span>
            <h2>{processingLabel}</h2>
            <p>
              そのままお待ちください。ボタンを何度も押す必要はありません。
            </p>
            <Progress
              value={68}
              className="processing-progress"
            />
          </div>
        </div>
      )}

      {/* DLG-01／DLG-02：中止・不同意時の確認 */}
      <AlertDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      >
        <AlertDialogContent className="kiosk-dialog">
          <AlertDialogHeader>
            <AlertDialogMedia className="dialog-warning">
              <CircleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>
              手続きを中止しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              入力した内容と、この画面で確認した情報は消去されます。あとから自動で送信されることはありません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="dialog-button">
              手続きを続ける
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="dialog-button"
              onClick={goHome}
            >
              中止してホームへ戻る
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* DLG-03：60秒無操作後のタイムアウト予告 */}
      <AlertDialog
        open={timeoutOpen}
        onOpenChange={() => undefined}
      >
        <AlertDialogContent className="kiosk-dialog">
          <AlertDialogHeader>
            <AlertDialogMedia className="dialog-clock">
              <Clock3 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              操作を続けますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              安全のため、あと{timeoutSeconds}
              秒で手続きを終了し、画面の個人情報を消去します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Progress
            value={
              (timeoutSeconds / TIMEOUT_GRACE_SECONDS) * 100
            }
            className="timeout-progress"
          />
          <AlertDialogFooter>
            <AlertDialogAction
              variant="outline"
              className="dialog-button"
              onClick={goHome}
            >
              今すぐ終了する
            </AlertDialogAction>
            <AlertDialogAction
              className="dialog-button"
              onClick={() => setTimeoutOpen(false)}
            >
              続ける
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
