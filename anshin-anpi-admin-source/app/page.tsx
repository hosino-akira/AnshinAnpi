"use client";

/**
 * 安心安否確認システム：利用者向け画面
 *
 * 対象端末：Android／13.3インチ・タッチ液晶（横向き基準）
 * 対象画面：SCR-00〜SCR-14
 *
 * このファイルは、画面遷移とUI状態を確認するフロントエンド実装です。
 * 実運用時は、`runProcessing` の疑似処理を各バックエンドAPIへ置き換え、
 * 顔画像そのものは保存せず、カメラ画面を離れた時点でストリームを停止してください。
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
// 本番では MOCK_* を顔認証API／登録情報APIのレスポンスに置き換えてください。
const INACTIVITY_WARNING_MS = 60_000;
const TIMEOUT_GRACE_SECONDS = 30;
const COMPLETION_SECONDS = 10;
const MOCK_USER_NAME = "山田 太郎";
const MOCK_RECIPIENTS: Recipient[] = [
  { name: "山田 花子", email: "hanako@example.jp" },
  { name: "山田 一郎", email: "ichiro@example.jp" },
];

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
  onSuccess: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraState, setCameraState] = useState<
    "starting" | "ready" | "blocked"
  >("starting");
  const [retryKey, setRetryKey] = useState(0);
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
            disabled={cameraState !== "ready"}
            onClick={onSuccess}
          >
            <Camera aria-hidden="true" />
            {actionLabel}
            <ChevronRight aria-hidden="true" />
          </Button>
        )}
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
  /**
   * OVL-01（処理中）の疑似処理です。
   * 実運用時はここをAPI呼び出しへ置き換え、成功・部分失敗・全件失敗を分岐してください。
   */
  const runProcessing = (
    label: string,
    next: ScreenId,
    delay = 1200,
  ) => {
    if (processingLabel) return;
    setProcessingLabel(label);
    window.setTimeout(() => {
      setProcessingLabel(null);
      setScreen(next);
    }, delay);
  };

  // SCR-09／SCR-14は10秒後にホームへ戻します（C-006）。
  useEffect(() => {
    if (screen !== "SCR-09" && screen !== "SCR-14") return;
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
  }, [screen, goHome]);

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
              onSuccess={() =>
                runProcessing(
                  "顔の状態を確認しています",
                  "SCR-03",
                )
              }
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
              <h2>安心安否確認サービスの個人情報取扱い</h2>
              <p>
                本サービスでは、ご本人を確認し、登録した連絡先へ安否確認メールを送るため、氏名、顔画像から作成する顔特徴データ、連絡先の氏名・メールアドレス、利用日時、送信結果を取り扱います。
              </p>
              <h3>利用目的と保存について</h3>
              <p>
                取得した情報は、安否確認サービスの提供、本人確認、障害対応および不正利用防止のためにのみ使用します。顔画像は原則保存せず、顔特徴データは暗号化して保管します。
              </p>
              <h3>委託・開示・削除について</h3>
              <p>
                サービス運営に必要な範囲で、顔認識またはメール配信を行う委託先に情報を取り扱わせる場合があります。開示・訂正・削除・同意撤回は、施設の問い合わせ窓口へお申し出ください。
              </p>
              <h3>ご同意いただけない場合</h3>
              <p>
                同意しない場合は登録できません。同意前に撮影・入力した情報は直ちに破棄します。本サービスは緊急通報ではなく、メールの受信・閲覧を保証するものではありません。
              </p>
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
                    disabled={!privacyAgreed}
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
              description="1名は必須、2名まで登録できます。入力したメールアドレスへ確認メールを送ります。"
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
                  onClick={() =>
                    runProcessing(
                      "登録内容を安全に保存しています",
                      "SCR-07",
                      1500,
                    )
                  }
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
              onSuccess={() =>
                runProcessing(
                  "登録した顔と照合しています",
                  "SCR-08",
                  1600,
                )
              }
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
              title="確認メールを送信しました"
              description="登録した送信相手ごとに、メールの受付結果をご確認ください。"
            />
            <div className="success-banner">
              <span>
                <CheckCircle2 />
              </span>
              <div>
                <h2>顔の登録を確認できました</h2>
                <p>{name}さんの登録情報を利用できます。</p>
              </div>
            </div>
            <div className="result-list">
              {activeRecipients.map((recipient) => (
                <RecipientCard
                  key={recipient.email}
                  name={recipient.name}
                  email={recipient.email}
                  status="success"
                />
              ))}
            </div>
            <Notice tone="info" icon={<Mail />}>
              <strong>
                「送信受付済み」は、メール配信サービスが受け付けた状態です
              </strong>
              <span>
                受信箱への到着・閲覧を保証するものではありません。
              </span>
            </Notice>
            <ActionBar
              onCancel={() => setCancelOpen(true)}
              primary={
                <Button
                  className="touch-button primary-button"
                  onClick={() => setScreen("SCR-09")}
                >
                  登録を完了する
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
              onSuccess={() =>
                runProcessing(
                  "登録情報と照合しています",
                  "SCR-11",
                  1600,
                )
              }
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
              <h2>{MOCK_USER_NAME}さん</h2>
              <span>このお名前で登録されています</span>
            </div>
            <div className="identity-actions">
              <Button
                variant="outline"
                className="identity-no"
                onClick={goHome}
              >
                <X />
                ちがいます
              </Button>
              <Button
                className="identity-yes"
                onClick={() => setScreen("SCR-12")}
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
              description={`下記の登録済みの方へ、${MOCK_USER_NAME}さんが操作したことをメールでお知らせします。`}
            />
            <div className="recipient-intro">
              <span>
                <Mail />
              </span>
              <div>
                <small>今回の送信先</small>
                <strong>
                  {MOCK_RECIPIENTS.length}名へ送信します
                </strong>
              </div>
            </div>
            <div className="result-list">
              {MOCK_RECIPIENTS.map((recipient) => (
                <RecipientCard
                  key={recipient.email}
                  name={recipient.name}
                  email={recipient.email}
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
              description={`同意して送信ボタンを押すと、登録済みの${MOCK_RECIPIENTS.length}名へそれぞれ1通ずつ送信します。`}
            />
            <section className="mail-preview">
              <div className="mail-preview-head">
                <Mail />
                <span>
                  <small>送信されるメール</small>
                  <strong>
                    【安心安否確認】{MOCK_USER_NAME}
                    さんからのお知らせ
                  </strong>
                </span>
              </div>
              <div className="mail-body">
                <p>
                  {MOCK_USER_NAME}
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
                  onClick={() =>
                    runProcessing(
                      "メールを安全に送信しています",
                      "SCR-14",
                      1800,
                    )
                  }
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
                <h1>送信が完了しました</h1>
                <span>
                  {new Intl.DateTimeFormat("ja-JP", {
                    dateStyle: "long",
                    timeStyle: "short",
                  }).format(new Date())}
                </span>
              </div>
            </div>
            <div className="result-list">
              {MOCK_RECIPIENTS.map((recipient) => (
                <RecipientCard
                  key={recipient.email}
                  name={recipient.name}
                  email={recipient.email}
                  status="success"
                />
              ))}
            </div>
            <Notice tone="success" icon={<ShieldCheck />}>
              <strong>
                {MOCK_RECIPIENTS.length}
                名への送信が受け付けられました
              </strong>
              <span>
                同じ操作によるメールは重複して送信されません。
              </span>
            </Notice>
            <ActionBar
              primary={
                <>
                  <p className="bar-countdown">
                    自動終了まで{" "}
                    <strong>{completeSeconds}秒</strong>
                  </p>
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
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* 全画面共通：端末状態、手続き進捗、現在画面 */}
      <StatusHeader screen={screen} />
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
