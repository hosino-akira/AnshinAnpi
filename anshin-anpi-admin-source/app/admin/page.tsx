"use client";

/**
 * 安心安否確認システム：管理者用UI
 *
 * PCブラウザから登録者・最大2件のメール送信先・個人情報取扱文面を
 * 管理するための画面デザインです。現在は画面確認用のサンプルデータを
 * Reactのメモリ上で編集します。本番運用では認証、権限制御、監査ログ、
 * API、データベースへ置き換えてください。
 */

import {
  Activity,
  Bell,
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock3,
  Database,
  Eye,
  EyeOff,
  FilePenLine,
  Gauge,
  KeyRound,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  MailOpen,
  MailWarning,
  MapPin,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCog,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import "./admin.css";

type AdminView =
  | "dashboard"
  | "users"
  | "recipients"
  | "mailTemplate"
  | "privacy"
  | "admin";
type UserStatus = "active" | "suspended";
type FaceStatus = "registered" | "renewal";
type Recipient = {
  id: string;
  name: string;
  email: string;
};
type AdminAccount = {
  name: string;
  email: string;
  password: string;
  lastLoginAt: string;
  lastLoginIp: string;
};
type RegisteredUser = {
  id: string;
  name: string;
  faceIndex: number;
  status: UserStatus;
  faceStatus: FaceStatus;
  registeredAt: string;
  updatedAt: string;
  lastCheckAt: string;
  consentVersion: string;
  recipients: Recipient[];
};
type DeleteTarget =
  | { kind: "user"; userId: string; label: string }
  | {
      kind: "recipient";
      userId: string;
      recipientId: string;
      label: string;
    }
  | null;
type FlashMessage = {
  tone: "success" | "info" | "error";
  text: string;
} | null;

const INITIAL_ADMIN: AdminAccount = {
  name: "安心施設 管理者",
  email: "admin@anshin-anpi.jp",
  password: "Anshin2026!",
  lastLoginAt: "2026/09/06 17:42",
  // RFC 5737で例示用に予約されたIPアドレスを使用しています。
  lastLoginIp: "203.0.113.24",
};

const INITIAL_USERS: RegisteredUser[] = [
  {
    id: "USR-00128",
    name: "山田 太郎",
    faceIndex: 0,
    status: "active",
    faceStatus: "registered",
    registeredAt: "2026/08/18",
    updatedAt: "2026/09/06 10:24",
    lastCheckAt: "2026/09/07 08:42",
    consentVersion: "v1.2",
    recipients: [
      {
        id: "REC-001",
        name: "山田 花子",
        email: "hanako@example.jp",
      },
      {
        id: "REC-002",
        name: "山田 一郎",
        email: "ichiro@example.jp",
      },
    ],
  },
  {
    id: "USR-00127",
    name: "佐藤 和子",
    faceIndex: 1,
    status: "active",
    faceStatus: "registered",
    registeredAt: "2026/08/16",
    updatedAt: "2026/09/05 15:10",
    lastCheckAt: "2026/09/06 17:55",
    consentVersion: "v1.2",
    recipients: [
      {
        id: "REC-003",
        name: "佐藤 美咲",
        email: "misaki@example.jp",
      },
    ],
  },
  {
    id: "USR-00126",
    name: "鈴木 正夫",
    faceIndex: 2,
    status: "suspended",
    faceStatus: "renewal",
    registeredAt: "2026/08/12",
    updatedAt: "2026/09/04 09:32",
    lastCheckAt: "2026/08/29 11:03",
    consentVersion: "v1.1",
    recipients: [
      {
        id: "REC-004",
        name: "鈴木 洋子",
        email: "yoko@example.jp",
      },
      {
        id: "REC-005",
        name: "鈴木 健",
        email: "ken@example.jp",
      },
    ],
  },
  {
    id: "USR-00125",
    name: "高橋 久美子",
    faceIndex: 3,
    status: "active",
    faceStatus: "registered",
    registeredAt: "2026/08/09",
    updatedAt: "2026/09/03 13:18",
    lastCheckAt: "2026/09/05 09:20",
    consentVersion: "v1.2",
    recipients: [
      {
        id: "REC-006",
        name: "高橋 健太",
        email: "kenta@example.jp",
      },
    ],
  },
  {
    id: "USR-00124",
    name: "田中 春江",
    faceIndex: 4,
    status: "active",
    faceStatus: "registered",
    registeredAt: "2026/08/03",
    updatedAt: "2026/09/02 16:40",
    lastCheckAt: "2026/09/07 07:58",
    consentVersion: "v1.2",
    recipients: [
      {
        id: "REC-007",
        name: "田中 一美",
        email: "kazumi@example.jp",
      },
      {
        id: "REC-008",
        name: "田中 誠",
        email: "makoto@example.jp",
      },
    ],
  },
];

const INITIAL_PRIVACY = `安心安否確認システムにおける個人情報の取扱い

1. 取得する情報
本システムでは、利用者の氏名、顔認証に必要な特徴情報、メール送信先の氏名およびメールアドレス、安否確認の送信結果を取得します。

2. 利用目的
取得した情報は、利用者本人の確認、登録された送信先への安否確認メール送信、本システムの安全な運用およびお問い合わせ対応のために利用します。

3. 第三者への提供
法令に基づく場合を除き、本人の同意なく取得した情報を第三者へ提供しません。

4. 安全管理
取得した情報へのアクセスを管理し、暗号化その他の適切な安全管理措置を講じます。

5. 保存期間と削除
個人情報は利用目的に必要な期間に限り保存します。利用者から削除の申出があった場合は、法令上必要な期間を除き速やかに削除します。

6. お問い合わせ
個人情報の確認、変更、削除に関するお問い合わせは、施設の個人情報管理責任者までお申し出ください。`;

// 家族へ送る安否確認メールの初期文面です。二重波括弧は送信時に実データへ置換します。
const INITIAL_MAIL_SUBJECT =
  "【安心安否確認】{{登録者名}}さんから安否確認のお知らせ";
const INITIAL_MAIL_BODY = `{{送信先名}} 様

{{登録者名}}さんが、{{確認日時}}に安心安否確認システムから安否確認を送信しました。

現在、{{施設名}}の端末でご本人の確認が完了しています。

※本メールは送信専用です。
※このサービスは緊急通報ではありません。緊急時は119番・110番をご利用ください。`;

const MAIL_TEMPLATE_VARIABLES = [
  "{{送信先名}}",
  "{{登録者名}}",
  "{{確認日時}}",
  "{{施設名}}",
] as const;

// 編集画面では架空データを差し込み、実際の配信イメージをその場で確認できます。
const renderMailSample = (text: string) =>
  text
    .replaceAll("{{送信先名}}", "山田 花子")
    .replaceAll("{{登録者名}}", "山田 太郎")
    .replaceAll("{{確認日時}}", "2026/09/07 10:30")
    .replaceAll("{{施設名}}", "安心施設");

const INITIAL_ACTIVITIES = [
  "山田 太郎さんの送信先を更新しました",
  "個人情報取扱文面 v1.2を公開しました",
  "鈴木 正夫さんを利用停止に変更しました",
];

const MAIL_ERRORS = [
  {
    id: "ERR-20260907-002",
    userName: "佐藤 和子",
    userId: "USR-00127",
    recipientName: "佐藤 美咲",
    email: "misaki@example.jp",
    occurredAt: "2026/09/07 09:14",
    code: "SMTP 550",
    reason: "宛先メールアドレスが存在しません",
  },
  {
    id: "ERR-20260907-001",
    userName: "高橋 久美子",
    userId: "USR-00125",
    recipientName: "高橋 健太",
    email: "kenta@example.jp",
    occurredAt: "2026/09/07 08:31",
    code: "TIMEOUT",
    reason:
      "送信先メールサーバーへの接続がタイムアウトしました",
  },
] as const;

// 編集中のオブジェクトが初期サンプルを書き換えないよう、毎回複製して利用します。
const createSampleUsers = (): RegisteredUser[] =>
  INITIAL_USERS.map((user) => ({
    ...user,
    recipients: user.recipients.map((recipient) => ({
      ...recipient,
    })),
  }));

const VIEW_COPY: Record<
  AdminView,
  { title: string; description: string }
> = {
  dashboard: {
    title: "管理状況",
    description: "登録状況と直近の変更を確認できます。",
  },
  users: {
    title: "登録者管理",
    description:
      "登録者情報の変更、利用停止、削除を行います。",
  },
  recipients: {
    title: "メール送信先管理",
    description:
      "登録者ごとに最大2件の送信先を管理します。",
  },
  mailTemplate: {
    title: "送信メール編集",
    description:
      "家族へ配信するメールのタイトルと本文を編集します。",
  },
  privacy: {
    title: "個人情報取扱文面",
    description:
      "利用者画面に表示する同意文面を編集します。",
  },
  admin: {
    title: "管理者情報",
    description:
      "管理者名、ログイン情報、最終ログイン状況を確認・変更します。",
  },
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function StatusBadge({ status }: { status: UserStatus }) {
  return (
    <span className={`admin-status ${status}`}>
      {status === "active" ? "利用中" : "利用停止"}
    </span>
  );
}

function FaceBadge({ status }: { status: FaceStatus }) {
  return (
    <span className={`face-status ${status}`}>
      {status === "registered" ? (
        <CheckCircle2 aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      {status === "registered" ? "登録済み" : "再登録待ち"}
    </span>
  );
}

function FacePhoto({
  user,
  size = "table",
}: {
  user: RegisteredUser;
  size?: "table" | "large";
}) {
  return (
    <span
      className={`face-photo ${size}`}
      style={
        { "--face-index": user.faceIndex } as CSSProperties
      }
      role="img"
      aria-label={`${user.name}さんの登録顔写真`}
    />
  );
}

function formatNow() {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] =
    useState(false);
  const [adminAccount, setAdminAccount] =
    useState<AdminAccount>(INITIAL_ADMIN);
  const [adminDraft, setAdminDraft] = useState({
    name: INITIAL_ADMIN.name,
    email: INITIAL_ADMIN.email,
  });
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] =
    useState(false);
  const [loginError, setLoginError] = useState("");
  const [currentPassword, setCurrentPassword] =
    useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] =
    useState("");
  const [adminFormError, setAdminFormError] = useState("");
  const [view, setView] = useState<AdminView>("dashboard");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [users, setUsers] = useState<RegisteredUser[]>(
    createSampleUsers,
  );
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | UserStatus
  >("all");
  const [editingUser, setEditingUser] =
    useState<RegisteredUser | null>(null);
  const [formError, setFormError] = useState("");
  const [deleteTarget, setDeleteTarget] =
    useState<DeleteTarget>(null);
  const [mailSubject, setMailSubject] = useState(
    INITIAL_MAIL_SUBJECT,
  );
  const [savedMailSubject, setSavedMailSubject] = useState(
    INITIAL_MAIL_SUBJECT,
  );
  const [mailBody, setMailBody] = useState(
    INITIAL_MAIL_BODY,
  );
  const [savedMailBody, setSavedMailBody] = useState(
    INITIAL_MAIL_BODY,
  );
  const [mailSavedAt, setMailSavedAt] = useState(
    "2026/09/07 09:45",
  );
  const [privacyText, setPrivacyText] =
    useState(INITIAL_PRIVACY);
  const [savedPrivacyText, setSavedPrivacyText] =
    useState(INITIAL_PRIVACY);
  const [privacyVersion, setPrivacyVersion] =
    useState("v1.3");
  const [privacyDate, setPrivacyDate] =
    useState("2026-09-07");
  const [privacyMode, setPrivacyMode] = useState<
    "edit" | "preview"
  >("edit");
  const [privacySavedAt, setPrivacySavedAt] = useState(
    "2026/09/06 16:20",
  );
  const [activities, setActivities] = useState(
    INITIAL_ACTIVITIES,
  );
  const [flash, setFlash] = useState<FlashMessage>(null);
  const [isInteractive, setIsInteractive] = useState(false);

  // クライアント側の操作機能が読み込まれたことを画面上でも確認できるようにします。
  useEffect(() => setIsInteractive(true), []);

  // 操作結果メッセージは一定時間後に自動で閉じます。
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(
      () => setFlash(null),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [flash]);

  const activeCount = users.filter(
    (user) => user.status === "active",
  ).length;
  const recipientCount = users.reduce(
    (sum, user) => sum + user.recipients.length,
    0,
  );
  const isMailTemplateDirty =
    mailSubject !== savedMailSubject ||
    mailBody !== savedMailBody;
  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return users.filter((user) => {
      const matchesStatus =
        statusFilter === "all" ||
        user.status === statusFilter;
      const matchesQuery =
        !keyword ||
        user.name.toLowerCase().includes(keyword) ||
        user.id.toLowerCase().includes(keyword) ||
        user.recipients.some(
          (recipient) =>
            recipient.name
              .toLowerCase()
              .includes(keyword) ||
            recipient.email.toLowerCase().includes(keyword),
        );
      return matchesStatus && matchesQuery;
    });
  }, [query, statusFilter, users]);

  const handleLogin = (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setLoginError("");
    if (
      loginEmail.trim().toLowerCase() !==
        adminAccount.email.toLowerCase() ||
      loginPassword !== adminAccount.password
    ) {
      setLoginError(
        "メールアドレスまたはパスワードが正しくありません。",
      );
      return;
    }
    const signedInAccount = {
      ...adminAccount,
      lastLoginAt: formatNow(),
    };
    setAdminAccount(signedInAccount);
    setAdminDraft({
      name: signedInAccount.name,
      email: signedInAccount.email,
    });
    setLoginPassword("");
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setView("dashboard");
    setMobileNavOpen(false);
    setLoginEmail("");
    setLoginPassword("");
    setShowLoginPassword(false);
    setFlash(null);
  };

  const selectView = (nextView: AdminView) => {
    setView(nextView);
    setMobileNavOpen(false);
  };

  const addActivity = (message: string) =>
    setActivities((current) =>
      [message, ...current].slice(0, 5),
    );

  const showFlash = (
    tone: NonNullable<FlashMessage>["tone"],
    text: string,
  ) => {
    setFlash({ tone, text });
  };

  const saveAdminAccount = (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const name = adminDraft.name.trim();
    const email = adminDraft.email.trim();
    const passwordChangeRequested = Boolean(
      currentPassword || newPassword || confirmPassword,
    );

    if (!name || !emailPattern.test(email)) {
      setAdminFormError(
        "管理者名と正しいメールアドレスを入力してください。",
      );
      return;
    }
    if (
      passwordChangeRequested &&
      currentPassword !== adminAccount.password
    ) {
      setAdminFormError(
        "現在のパスワードが正しくありません。",
      );
      return;
    }
    if (passwordChangeRequested && newPassword.length < 8) {
      setAdminFormError(
        "新しいパスワードは8文字以上で入力してください。",
      );
      return;
    }
    if (
      passwordChangeRequested &&
      newPassword !== confirmPassword
    ) {
      setAdminFormError(
        "新しいパスワードと確認用パスワードが一致しません。",
      );
      return;
    }

    setAdminAccount((current) => ({
      ...current,
      name,
      email,
      password: passwordChangeRequested
        ? newPassword
        : current.password,
    }));
    setAdminDraft({ name, email });
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setAdminFormError("");
    addActivity(`${name}さんの管理者情報を更新しました`);
    showFlash("success", "管理者情報を保存しました");
  };

  // 削除・変更後でも、確認用の5件をワンクリックで初期状態へ戻せます。
  const resetSampleData = () => {
    setUsers(createSampleUsers());
    setQuery("");
    setStatusFilter("all");
    setEditingUser(null);
    setDeleteTarget(null);
    setMailSubject(INITIAL_MAIL_SUBJECT);
    setSavedMailSubject(INITIAL_MAIL_SUBJECT);
    setMailBody(INITIAL_MAIL_BODY);
    setSavedMailBody(INITIAL_MAIL_BODY);
    setMailSavedAt("2026/09/07 09:45");
    setPrivacyText(INITIAL_PRIVACY);
    setSavedPrivacyText(INITIAL_PRIVACY);
    setPrivacyVersion("v1.3");
    setPrivacyDate("2026-09-07");
    setPrivacyMode("edit");
    setPrivacySavedAt("2026/09/06 16:20");
    setActivities(INITIAL_ACTIVITIES);
    showFlash(
      "success",
      "サンプルデータ5件を初期状態に戻しました",
    );
  };

  const openUserEditor = (user: RegisteredUser) => {
    setFormError("");
    setEditingUser({
      ...user,
      recipients: user.recipients.map((recipient) => ({
        ...recipient,
      })),
    });
  };

  const updateRecipientDraft = (
    recipientId: string,
    field: "name" | "email",
    value: string,
  ) => {
    setEditingUser((current) =>
      current
        ? {
            ...current,
            recipients: current.recipients.map(
              (recipient) =>
                recipient.id === recipientId
                  ? { ...recipient, [field]: value }
                  : recipient,
            ),
          }
        : current,
    );
  };

  const addRecipientDraft = () => {
    setEditingUser((current) => {
      if (!current || current.recipients.length >= 2)
        return current;
      return {
        ...current,
        recipients: [
          ...current.recipients,
          { id: `REC-${Date.now()}`, name: "", email: "" },
        ],
      };
    });
  };

  const saveUser = () => {
    if (!editingUser) return;
    const trimmedName = editingUser.name.trim();
    const recipients = editingUser.recipients.map(
      (recipient) => ({
        ...recipient,
        name: recipient.name.trim(),
        email: recipient.email.trim(),
      }),
    );
    if (!trimmedName) {
      setFormError("登録者名を入力してください。");
      return;
    }
    if (recipients.length === 0) {
      setFormError(
        "メール送信先を1件以上登録してください。",
      );
      return;
    }
    if (
      recipients.some(
        (recipient) =>
          !recipient.name ||
          !emailPattern.test(recipient.email),
      )
    ) {
      setFormError(
        "送信先の氏名と正しいメールアドレスを入力してください。",
      );
      return;
    }
    if (
      new Set(
        recipients.map((recipient) =>
          recipient.email.toLowerCase(),
        ),
      ).size !== recipients.length
    ) {
      setFormError(
        "同じメールアドレスを2件登録することはできません。",
      );
      return;
    }
    const updated = {
      ...editingUser,
      name: trimmedName,
      recipients,
      updatedAt: formatNow(),
    };
    setUsers((current) =>
      current.map((user) =>
        user.id === updated.id ? updated : user,
      ),
    );
    addActivity(
      `${updated.name}さんの登録情報を更新しました`,
    );
    setEditingUser(null);
    showFlash("success", "登録者情報を保存しました");
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "user") {
      setUsers((current) =>
        current.filter(
          (user) => user.id !== deleteTarget.userId,
        ),
      );
      addActivity(
        `${deleteTarget.label}さんの登録情報を削除しました`,
      );
      setEditingUser(null);
      showFlash("success", "登録者情報を削除しました");
    } else {
      setUsers((current) =>
        current.map((user) => {
          if (user.id !== deleteTarget.userId) return user;
          const recipients = user.recipients.filter(
            (recipient) =>
              recipient.id !== deleteTarget.recipientId,
          );
          // 送信先が0件になった登録者は、誤送信を防ぐため利用停止へ切り替えます。
          return {
            ...user,
            status:
              recipients.length === 0
                ? "suspended"
                : user.status,
            updatedAt: formatNow(),
            recipients,
          };
        }),
      );
      setEditingUser((current) => {
        if (current?.id !== deleteTarget.userId)
          return current;
        const recipients = current.recipients.filter(
          (recipient) =>
            recipient.id !== deleteTarget.recipientId,
        );
        return {
          ...current,
          status:
            recipients.length === 0
              ? "suspended"
              : current.status,
          recipients,
        };
      });
      addActivity(
        `${deleteTarget.label}さんをメール送信先から削除しました`,
      );
      showFlash("success", "メール送信先を削除しました");
    }
    setDeleteTarget(null);
  };

  const savePrivacy = () => {
    if (!privacyText.trim()) {
      showFlash(
        "error",
        "個人情報取扱文面を入力してください",
      );
      return;
    }
    if (!privacyVersion.trim() || !privacyDate) {
      showFlash(
        "error",
        "版番号と適用開始日を入力してください",
      );
      return;
    }
    setSavedPrivacyText(privacyText);
    setPrivacySavedAt(formatNow());
    addActivity(
      `個人情報取扱文面 ${privacyVersion}を保存しました`,
    );
    showFlash("success", "個人情報取扱文面を保存しました");
  };

  const saveMailTemplate = () => {
    const subject = mailSubject.trim();
    const body = mailBody.trim();
    if (!subject) {
      showFlash(
        "error",
        "メールタイトルを入力してください",
      );
      return;
    }
    if (!body) {
      showFlash("error", "メール本文を入力してください");
      return;
    }
    setMailSubject(subject);
    setSavedMailSubject(subject);
    setMailBody(body);
    setSavedMailBody(body);
    setMailSavedAt(formatNow());
    addActivity(
      "家族向け送信メールのタイトルと本文を保存しました",
    );
    showFlash("success", "送信メールの内容を保存しました");
  };

  const restoreMailTemplate = () => {
    setMailSubject(savedMailSubject);
    setMailBody(savedMailBody);
    showFlash("info", "未保存の変更を取り消しました");
  };

  const navItems = [
    {
      id: "dashboard" as const,
      label: "管理状況",
      icon: Gauge,
    },
    {
      id: "users" as const,
      label: "登録者管理",
      icon: UsersRound,
    },
    {
      id: "recipients" as const,
      label: "メール送信先",
      icon: Mail,
    },
    {
      id: "mailTemplate" as const,
      label: "送信メール編集",
      icon: MailOpen,
    },
    {
      id: "privacy" as const,
      label: "個人情報取扱文面",
      icon: BookOpenText,
    },
    {
      id: "admin" as const,
      label: "管理者情報",
      icon: UserCog,
    },
  ];

  if (!isAuthenticated) {
    return (
      <main
        className="admin-login-page"
        data-app-ready={isInteractive ? "true" : "false"}
      >
        <noscript>
          <div className="admin-noscript" role="alert">
            ログインするには、ブラウザのJavaScriptを有効にして再読み込みしてください。
          </div>
        </noscript>
        <section className="login-brand-panel">
          <div className="login-brand">
            <span>
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <strong>安心安否確認</strong>
              <small>管理コンソール</small>
            </div>
          </div>
          <div className="login-message">
            <p>ADMIN CONSOLE</p>
            <h1>管理者ログイン</h1>
            <span>
              登録者情報と安否確認の送信状況を安全に管理します。
            </span>
          </div>
          <ul>
            <li>
              <CheckCircle2 aria-hidden="true" />
              登録者と送信先を一元管理
            </li>
            <li>
              <CheckCircle2 aria-hidden="true" />
              メール送信エラーを確認
            </li>
            <li>
              <CheckCircle2 aria-hidden="true" />
              個人情報取扱文面を編集
            </li>
          </ul>
        </section>
        <section className="login-form-panel">
          <form
            className="login-card"
            onSubmit={handleLogin}
          >
            <div className="login-card-head">
              <span>
                <LockKeyhole aria-hidden="true" />
              </span>
              <div>
                <h2>ログイン</h2>
                <p>
                  管理者のメールアドレスとパスワードを入力してください。
                </p>
              </div>
            </div>
            <div className="login-field">
              <Label htmlFor="login-email">
                メールアドレス
              </Label>
              <div>
                <Mail aria-hidden="true" />
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  value={loginEmail}
                  onChange={(event) =>
                    setLoginEmail(event.target.value)
                  }
                  placeholder="admin@example.jp"
                  required
                />
              </div>
            </div>
            <div className="login-field">
              <Label htmlFor="login-password">
                パスワード
              </Label>
              <div>
                <KeyRound aria-hidden="true" />
                <Input
                  id="login-password"
                  type={
                    showLoginPassword ? "text" : "password"
                  }
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(event) =>
                    setLoginPassword(event.target.value)
                  }
                  placeholder="パスワードを入力"
                  required
                />
                <button
                  type="button"
                  className="password-visibility"
                  aria-label={
                    showLoginPassword
                      ? "パスワードを隠す"
                      : "パスワードを表示"
                  }
                  onClick={() =>
                    setShowLoginPassword(
                      (current) => !current,
                    )
                  }
                >
                  {showLoginPassword ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            {loginError && (
              <div className="login-error" role="alert">
                <CircleAlert aria-hidden="true" />
                {loginError}
              </div>
            )}
            <Button type="submit" className="login-submit">
              <LogIn aria-hidden="true" />
              ログイン
            </Button>
            <div className="login-demo">
              <div>
                <strong>デモ用ログイン情報</strong>
                <span>
                  {adminAccount.email}
                  <br />
                  {adminAccount.password}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLoginEmail(adminAccount.email);
                  setLoginPassword(adminAccount.password);
                  setLoginError("");
                }}
              >
                入力欄にセット
              </button>
            </div>
            <p className="login-security-note">
              <ShieldCheck aria-hidden="true" />
              この画面はデザイン確認用です。本番ではサーバー認証とアクセス制御へ接続してください。
            </p>
          </form>
        </section>
      </main>
    );
  }

  const userTable = (
    items: RegisteredUser[],
    compact = false,
  ) => (
    <div className="admin-table-wrap">
      <Table className="admin-table">
        <TableHeader>
          <TableRow>
            <TableHead>登録者</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>顔登録</TableHead>
            <TableHead>送信先</TableHead>
            <TableHead>
              {compact
                ? "最終確認"
                : "登録日 / 最終安否確認"}
            </TableHead>
            <TableHead className="action-column">
              操作
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <div className="user-cell">
                  <FacePhoto user={user} />
                  <div>
                    <strong>{user.name}</strong>
                    <small>{user.id}</small>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={user.status} />
              </TableCell>
              <TableCell>
                <FaceBadge status={user.faceStatus} />
              </TableCell>
              <TableCell>
                <strong className="recipient-number">
                  {user.recipients.length}
                </strong>
                <span className="muted-copy"> / 2件</span>
              </TableCell>
              <TableCell>
                <div className="date-cell">
                  {!compact && (
                    <small>登録 {user.registeredAt}</small>
                  )}
                  <span>{user.lastCheckAt}</span>
                </div>
              </TableCell>
              <TableCell className="action-column">
                <div className="row-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openUserEditor(user)}
                  >
                    <Pencil aria-hidden="true" />
                    変更
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="danger-icon"
                    aria-label={`${user.name}さんを削除`}
                    onClick={() =>
                      setDeleteTarget({
                        kind: "user",
                        userId: user.id,
                        label: user.name,
                      })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {items.length === 0 && (
        <div className="empty-state">
          <Search aria-hidden="true" />
          <strong>該当する登録者がいません</strong>
          <span>検索条件を変更してください。</span>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="admin-page"
      data-app-ready={isInteractive ? "true" : "false"}
    >
      {flash && (
        <div
          className={`admin-flash ${flash.tone}`}
          role={flash.tone === "error" ? "alert" : "status"}
        >
          {flash.tone === "success" ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          <span>{flash.text}</span>
          <button
            type="button"
            aria-label="メッセージを閉じる"
            onClick={() => setFlash(null)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      <noscript>
        <div className="admin-noscript" role="alert">
          管理機能を利用するには、ブラウザのJavaScriptを有効にして再読み込みしてください。
        </div>
      </noscript>

      <aside
        className={`admin-sidebar ${mobileNavOpen ? "is-open" : ""}`}
      >
        <div className="admin-brand">
          <span>
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <strong>安心安否確認</strong>
            <small>管理コンソール</small>
          </div>
        </div>
        <nav aria-label="管理メニュー">
          <p>管理メニュー</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  view === item.id ? "is-active" : ""
                }
                aria-current={
                  view === item.id ? "page" : undefined
                }
                onClick={() => selectView(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {view === item.id && (
                  <ChevronRight aria-hidden="true" />
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="environment-note">
            <Database aria-hidden="true" />
            <div>
              <strong>デザイン確認用</strong>
              <span>サンプルデータを表示中</span>
            </div>
          </div>
          <button type="button" onClick={handleLogout}>
            <LogOut aria-hidden="true" />
            ログアウト
          </button>
        </div>
      </aside>

      {mobileNavOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="メニューを閉じる"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <div className="admin-workspace">
        <header className="admin-topbar">
          <button
            type="button"
            className="mobile-menu"
            aria-label="管理メニューを開く"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="breadcrumb">
            <span>管理コンソール</span>
            <ChevronRight aria-hidden="true" />
            <strong>{VIEW_COPY[view].title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="notification-button"
              aria-label="通知"
              onClick={() => {
                selectView("dashboard");
                showFlash(
                  "info",
                  `最近の変更を${activities.length}件、メール送信エラーを${MAIL_ERRORS.length}件表示しています`,
                );
              }}
            >
              <Bell aria-hidden="true" />
              <span />
            </button>
            <button
              type="button"
              className="admin-account"
              onClick={() => selectView("admin")}
            >
              <span>{adminAccount.name.slice(0, 1)}</span>
              <div>
                <strong>{adminAccount.name}</strong>
                <small>管理者情報を開く</small>
              </div>
            </button>
          </div>
        </header>

        <main className="admin-content">
          <div className="admin-page-head">
            <div>
              <p>ADMINISTRATION</p>
              <h1>{VIEW_COPY[view].title}</h1>
              <span>{VIEW_COPY[view].description}</span>
            </div>
            <div className="head-security">
              <ShieldCheck aria-hidden="true" />
              <span>
                <strong>管理者専用</strong>
                通信は暗号化されています
              </span>
            </div>
          </div>

          {view === "dashboard" && (
            <>
              <section
                className="metric-grid"
                aria-label="登録状況"
              >
                <article>
                  <span className="metric-icon navy">
                    <UsersRound aria-hidden="true" />
                  </span>
                  <div>
                    <small>登録者数</small>
                    <strong>
                      {users.length}
                      <em>名</em>
                    </strong>
                    <p>
                      <b>{activeCount}名</b>が利用中
                    </p>
                  </div>
                </article>
                <article>
                  <span className="metric-icon teal">
                    <Mail aria-hidden="true" />
                  </span>
                  <div>
                    <small>メール送信先</small>
                    <strong>
                      {recipientCount}
                      <em>件</em>
                    </strong>
                    <p>
                      最大 {users.length * 2}件まで登録可能
                    </p>
                  </div>
                </article>
                <article>
                  <span className="metric-icon green">
                    <CheckCircle2 aria-hidden="true" />
                  </span>
                  <div>
                    <small>本日の安否確認</small>
                    <strong>
                      14<em>件</em>
                    </strong>
                    <p>
                      <b>12件</b>送信済み
                    </p>
                  </div>
                </article>
                <article className="error-metric">
                  <span className="metric-icon red">
                    <MailWarning aria-hidden="true" />
                  </span>
                  <div>
                    <small>メール送信エラー</small>
                    <strong>
                      {MAIL_ERRORS.length}
                      <em>件</em>
                    </strong>
                    <p>詳細確認が必要です</p>
                  </div>
                </article>
                <article>
                  <span className="metric-icon amber">
                    <FilePenLine aria-hidden="true" />
                  </span>
                  <div>
                    <small>個人情報取扱文面</small>
                    <strong>{privacyVersion}</strong>
                    <p>
                      {privacyDate.replaceAll("-", "/")}{" "}
                      適用予定
                    </p>
                  </div>
                </article>
              </section>

              <section className="admin-notice">
                <CircleAlert aria-hidden="true" />
                <div>
                  <strong>
                    サンプルデータ5件で全管理機能を確認できます
                  </strong>
                  <span>
                    変更・削除後は右のボタンでいつでも初期状態へ戻せます。
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="sample-reset-button"
                  onClick={resetSampleData}
                >
                  <RefreshCw aria-hidden="true" />
                  サンプル5件を再読込
                </Button>
              </section>

              <section
                className="admin-card mail-error-card"
                aria-labelledby="mail-error-heading"
              >
                <div className="card-head">
                  <div>
                    <p>DELIVERY ERRORS</p>
                    <h2 id="mail-error-heading">
                      メール送信エラー
                    </h2>
                  </div>
                  <span className="error-count">
                    <CircleX aria-hidden="true" />
                    未解決 {MAIL_ERRORS.length}件
                  </span>
                </div>
                <div className="mail-error-table-wrap">
                  <Table className="mail-error-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>発生時刻</TableHead>
                        <TableHead>登録者</TableHead>
                        <TableHead>送信先</TableHead>
                        <TableHead>エラー内容</TableHead>
                        <TableHead>状態</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {MAIL_ERRORS.map((error) => (
                        <TableRow key={error.id}>
                          <TableCell>
                            <div className="error-time">
                              <strong>
                                {
                                  error.occurredAt.split(
                                    " ",
                                  )[1]
                                }
                              </strong>
                              <small>
                                {
                                  error.occurredAt.split(
                                    " ",
                                  )[0]
                                }
                              </small>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="error-user">
                              <strong>
                                {error.userName}
                              </strong>
                              <small>{error.userId}</small>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="error-recipient">
                              <strong>
                                {error.recipientName}
                              </strong>
                              <span>{error.email}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="error-detail">
                              <code>{error.code}</code>
                              <span>{error.reason}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="error-status">
                              要確認
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <div className="dashboard-grid">
                <section className="admin-card recent-users">
                  <div className="card-head">
                    <div>
                      <p>REGISTERED USERS</p>
                      <h2>サンプル登録者 5件</h2>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => selectView("users")}
                    >
                      一覧を開く
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                  {userTable(users.slice(0, 5), true)}
                </section>
                <aside className="side-stack">
                  <section className="admin-card activity-card">
                    <div className="card-head">
                      <div>
                        <p>ACTIVITY</p>
                        <h2>最近の変更</h2>
                      </div>
                      <Activity aria-hidden="true" />
                    </div>
                    <ol>
                      {activities.map((activity, index) => (
                        <li key={`${activity}-${index}`}>
                          <span />
                          <div>
                            <strong>{activity}</strong>
                            <small>
                              {index === 0
                                ? "たった今"
                                : index === 1
                                  ? "昨日 16:20"
                                  : "3日前"}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                  <section className="quick-actions">
                    <button
                      type="button"
                      onClick={() => selectView("users")}
                    >
                      <span>
                        <UsersRound aria-hidden="true" />
                      </span>
                      <div>
                        <strong>登録者を管理</strong>
                        <small>情報の変更・削除</small>
                      </div>
                      <ChevronRight aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => selectView("privacy")}
                    >
                      <span>
                        <BookOpenText aria-hidden="true" />
                      </span>
                      <div>
                        <strong>文面を編集</strong>
                        <small>同意文面と版番号</small>
                      </div>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </section>
                </aside>
              </div>
            </>
          )}

          {view === "users" && (
            <section className="admin-card management-card">
              <div className="management-toolbar">
                <div className="admin-search">
                  <Search aria-hidden="true" />
                  <Input
                    value={query}
                    onChange={(event) =>
                      setQuery(event.target.value)
                    }
                    placeholder="氏名・登録者ID・メールで検索"
                    aria-label="登録者を検索"
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label="検索条件を消去"
                      onClick={() => setQuery("")}
                    >
                      <X aria-hidden="true" />
                    </button>
                  )}
                </div>
                <Select
                  value={statusFilter}
                  onValueChange={(value) =>
                    setStatusFilter(
                      value as "all" | UserStatus,
                    )
                  }
                >
                  <SelectTrigger
                    className="status-select"
                    aria-label="利用状態で絞り込み"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      すべての状態
                    </SelectItem>
                    <SelectItem value="active">
                      利用中
                    </SelectItem>
                    <SelectItem value="suspended">
                      利用停止
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span className="result-count">
                  {filteredUsers.length}名を表示
                </span>
              </div>
              {userTable(filteredUsers)}
            </section>
          )}

          {view === "recipients" && (
            <section className="recipient-management">
              <div className="recipient-summary">
                <div>
                  <Mail aria-hidden="true" />
                  <span>
                    <strong>{recipientCount}件</strong>
                    の送信先を登録中
                  </span>
                </div>
                <p>
                  登録者1名につき2件まで。氏名とメールアドレスは安否確認送信時に使用します。
                </p>
              </div>
              <div className="recipient-admin-grid">
                {users.map((user) => (
                  <article
                    key={user.id}
                    className="admin-card recipient-admin-card"
                  >
                    <div className="recipient-owner">
                      <span>
                        <UserRound aria-hidden="true" />
                      </span>
                      <div>
                        <strong>{user.name}</strong>
                        <small>{user.id}</small>
                      </div>
                      <StatusBadge status={user.status} />
                    </div>
                    <div className="recipient-slots">
                      {[0, 1].map((slot) => {
                        const recipient =
                          user.recipients[slot];
                        return recipient ? (
                          <div
                            className="recipient-slot"
                            key={recipient.id}
                          >
                            <span>{slot + 1}</span>
                            <div>
                              <strong>
                                {recipient.name}
                              </strong>
                              <small>
                                {recipient.email}
                              </small>
                            </div>
                            <div>
                              <button
                                type="button"
                                aria-label={`${recipient.name}さんを変更`}
                                onClick={() =>
                                  openUserEditor(user)
                                }
                              >
                                <Pencil aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="danger-icon"
                                aria-label={`${recipient.name}さんを削除`}
                                onClick={() =>
                                  setDeleteTarget({
                                    kind: "recipient",
                                    userId: user.id,
                                    recipientId:
                                      recipient.id,
                                    label: recipient.name,
                                  })
                                }
                              >
                                <Trash2 aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="empty-recipient-slot"
                            key={`empty-${slot}`}
                            onClick={() =>
                              openUserEditor({
                                ...user,
                                recipients: [
                                  ...user.recipients,
                                  {
                                    id: `REC-${Date.now()}`,
                                    name: "",
                                    email: "",
                                  },
                                ],
                              })
                            }
                          >
                            <Plus aria-hidden="true" />
                            <span>
                              送信先{slot + 1}を登録
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {view === "mailTemplate" && (
            <section className="mail-template-workspace">
              <div className="mail-template-toolbar admin-card">
                <div className="mail-template-meta">
                  <Clock3 aria-hidden="true" />
                  <span>
                    最終保存
                    <br />
                    <strong>{mailSavedAt}</strong>
                  </span>
                </div>
                <div className="mail-template-actions">
                  <Button
                    variant="outline"
                    disabled={!isMailTemplateDirty}
                    onClick={restoreMailTemplate}
                  >
                    保存前に戻す
                  </Button>
                  <Button
                    className="admin-primary"
                    onClick={saveMailTemplate}
                  >
                    <ShieldCheck aria-hidden="true" />
                    メール文面を保存
                  </Button>
                </div>
              </div>
              <div className="mail-template-grid">
                <section className="admin-card mail-template-editor">
                  <div className="editor-head">
                    <div>
                      <p>DELIVERY MESSAGE</p>
                      <h2>家族へ配信するメール</h2>
                    </div>
                    <span
                      className={`template-save-state ${isMailTemplateDirty ? "unsaved" : "saved"}`}
                    >
                      {isMailTemplateDirty ? (
                        <>
                          <CircleAlert aria-hidden="true" />
                          未保存の変更あり
                        </>
                      ) : (
                        <>
                          <CheckCircle2 aria-hidden="true" />
                          保存済み
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mail-template-field">
                    <div>
                      <Label htmlFor="mail-subject">
                        メールタイトル
                      </Label>
                      <small>
                        {mailSubject.length} / 100文字
                      </small>
                    </div>
                    <Input
                      id="mail-subject"
                      className="mail-template-subject"
                      value={mailSubject}
                      onChange={(event) =>
                        setMailSubject(event.target.value)
                      }
                      maxLength={100}
                      placeholder="安否確認メールのタイトル"
                    />
                  </div>
                  <div className="mail-template-field">
                    <div>
                      <Label htmlFor="mail-body">
                        メール本文
                      </Label>
                      <small>
                        {mailBody.length.toLocaleString(
                          "ja-JP",
                        )}{" "}
                        / 3,000文字
                      </small>
                    </div>
                    <Textarea
                      id="mail-body"
                      className="mail-template-body"
                      value={mailBody}
                      onChange={(event) =>
                        setMailBody(event.target.value)
                      }
                      maxLength={3000}
                      placeholder="家族へ送信する本文を入力してください"
                    />
                  </div>
                  <div className="template-variable-guide">
                    <div>
                      <strong>
                        利用できる差し込み項目
                      </strong>
                      <span>
                        メール送信時に登録情報へ自動で置き換わります。
                      </span>
                    </div>
                    <div className="template-variable-list">
                      {MAIL_TEMPLATE_VARIABLES.map(
                        (variable) => (
                          <code key={variable}>
                            {variable}
                          </code>
                        ),
                      )}
                    </div>
                  </div>
                </section>
                <aside className="admin-card mail-template-preview-card">
                  <div className="mail-preview-heading">
                    <span>
                      <MailOpen aria-hidden="true" />
                    </span>
                    <div>
                      <p>LIVE PREVIEW</p>
                      <h2>配信メールプレビュー</h2>
                    </div>
                  </div>
                  <div className="mail-preview-window">
                    <div className="mail-preview-address">
                      <span>宛先</span>
                      <strong>
                        山田 花子 &lt;hanako@example.jp&gt;
                      </strong>
                    </div>
                    <div className="mail-preview-subject">
                      <span>件名</span>
                      <strong>
                        {renderMailSample(mailSubject) ||
                          "メールタイトルを入力してください"}
                      </strong>
                    </div>
                    <div className="mail-preview-body">
                      {renderMailSample(mailBody) ||
                        "メール本文を入力してください"}
                    </div>
                  </div>
                  <div className="mail-preview-note">
                    <CircleAlert aria-hidden="true" />
                    <span>
                      これはサンプル情報を使用した表示確認です。保存しても、この画面から実際のメールは送信されません。
                    </span>
                  </div>
                </aside>
              </div>
            </section>
          )}

          {view === "privacy" && (
            <section className="privacy-workspace">
              <div className="privacy-toolbar admin-card">
                <div className="privacy-fields">
                  <div>
                    <Label htmlFor="privacy-version">
                      版番号
                    </Label>
                    <Input
                      id="privacy-version"
                      value={privacyVersion}
                      onChange={(event) =>
                        setPrivacyVersion(
                          event.target.value,
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="privacy-date">
                      適用開始日
                    </Label>
                    <Input
                      id="privacy-date"
                      type="date"
                      value={privacyDate}
                      onChange={(event) =>
                        setPrivacyDate(event.target.value)
                      }
                    />
                  </div>
                  <div className="privacy-meta">
                    <Clock3 aria-hidden="true" />
                    <span>
                      最終保存
                      <br />
                      <strong>{privacySavedAt}</strong>
                    </span>
                  </div>
                </div>
                <div className="privacy-actions">
                  <Button
                    variant="outline"
                    disabled={
                      privacyText === savedPrivacyText
                    }
                    onClick={() =>
                      setPrivacyText(savedPrivacyText)
                    }
                  >
                    保存前に戻す
                  </Button>
                  <Button
                    className="admin-primary"
                    onClick={savePrivacy}
                  >
                    <ShieldCheck aria-hidden="true" />
                    文面を保存
                  </Button>
                </div>
              </div>
              <div className="privacy-grid">
                <section className="admin-card privacy-editor">
                  <div className="editor-head">
                    <div>
                      <p>PRIVACY POLICY</p>
                      <h2>利用者に表示する文面</h2>
                    </div>
                    <div
                      className="mode-switch"
                      role="group"
                      aria-label="表示モード"
                    >
                      <button
                        type="button"
                        className={
                          privacyMode === "edit"
                            ? "is-active"
                            : ""
                        }
                        onClick={() =>
                          setPrivacyMode("edit")
                        }
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        className={
                          privacyMode === "preview"
                            ? "is-active"
                            : ""
                        }
                        onClick={() =>
                          setPrivacyMode("preview")
                        }
                      >
                        プレビュー
                      </button>
                    </div>
                  </div>
                  {privacyMode === "edit" ? (
                    <>
                      <Textarea
                        value={privacyText}
                        onChange={(event) =>
                          setPrivacyText(event.target.value)
                        }
                        aria-label="個人情報取扱文面"
                        className="privacy-textarea"
                      />
                      <div className="editor-foot">
                        <span
                          className={
                            privacyText === savedPrivacyText
                              ? "saved"
                              : "unsaved"
                          }
                        >
                          {privacyText ===
                          savedPrivacyText ? (
                            <>
                              <CheckCircle2 aria-hidden="true" />
                              保存済み
                            </>
                          ) : (
                            <>
                              <CircleAlert aria-hidden="true" />
                              未保存の変更があります
                            </>
                          )}
                        </span>
                        <small>
                          {privacyText.length.toLocaleString(
                            "ja-JP",
                          )}
                          文字
                        </small>
                      </div>
                    </>
                  ) : (
                    <div className="privacy-preview">
                      <span className="preview-label">
                        利用者画面プレビュー
                      </span>
                      <h3>
                        {privacyText.split("\n")[0] ||
                          "個人情報の取扱い"}
                      </h3>
                      {privacyText
                        .split("\n")
                        .slice(1)
                        .map((line, index) =>
                          line ? (
                            <p key={`${line}-${index}`}>
                              {line}
                            </p>
                          ) : (
                            <br key={`break-${index}`} />
                          ),
                        )}
                    </div>
                  )}
                </section>
                <aside className="privacy-side">
                  <section className="admin-card publish-card">
                    <div className="publish-icon">
                      <FilePenLine aria-hidden="true" />
                    </div>
                    <p>次回適用する文面</p>
                    <strong>{privacyVersion}</strong>
                    <span>
                      {privacyDate.replaceAll("-", "/")}
                      から利用者の同意画面へ表示
                    </span>
                    <hr />
                    <small>
                      文面を変更した場合は、法務確認と版番号の更新を行ってください。
                    </small>
                  </section>
                  <section className="privacy-checks">
                    <strong>保存前の確認</strong>
                    <ul>
                      <li>
                        <CheckCircle2 aria-hidden="true" />
                        取得する情報と利用目的
                      </li>
                      <li>
                        <CheckCircle2 aria-hidden="true" />
                        保存期間と削除方法
                      </li>
                      <li>
                        <CheckCircle2 aria-hidden="true" />
                        問い合わせ窓口
                      </li>
                    </ul>
                  </section>
                </aside>
              </div>
            </section>
          )}

          {view === "admin" && (
            <section className="admin-profile-grid">
              <aside className="admin-card admin-profile-summary">
                <div className="profile-avatar">
                  <UserCog aria-hidden="true" />
                </div>
                <p>ADMINISTRATOR</p>
                <h2>{adminAccount.name}</h2>
                <span>{adminAccount.email}</span>
                <dl>
                  <div>
                    <dt>
                      <Clock3 aria-hidden="true" />
                      最終ログイン時刻
                    </dt>
                    <dd>{adminAccount.lastLoginAt}</dd>
                  </div>
                  <div>
                    <dt>
                      <MapPin aria-hidden="true" />
                      ログイン場所（IPアドレス）
                    </dt>
                    <dd>{adminAccount.lastLoginIp}</dd>
                  </div>
                </dl>
                <div className="admin-demo-note">
                  <CircleAlert aria-hidden="true" />
                  <span>
                    IPアドレスはデモ用のサンプル値です。本番ではサーバー側で取得・監査してください。
                  </span>
                </div>
              </aside>
              <form
                className="admin-card admin-account-form"
                onSubmit={saveAdminAccount}
              >
                <div className="account-form-head">
                  <div>
                    <p>ACCOUNT SETTINGS</p>
                    <h2>管理者情報を変更</h2>
                  </div>
                  <ShieldCheck aria-hidden="true" />
                </div>
                <section>
                  <h3>基本情報</h3>
                  <div className="account-fields">
                    <div>
                      <Label htmlFor="admin-name">
                        名前
                      </Label>
                      <Input
                        id="admin-name"
                        value={adminDraft.name}
                        onChange={(event) =>
                          setAdminDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        autoComplete="name"
                      />
                    </div>
                    <div>
                      <Label htmlFor="admin-email">
                        メールアドレス
                      </Label>
                      <Input
                        id="admin-email"
                        type="email"
                        value={adminDraft.email}
                        onChange={(event) =>
                          setAdminDraft((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        autoComplete="email"
                      />
                    </div>
                  </div>
                </section>
                <section>
                  <div className="password-section-head">
                    <div>
                      <h3>パスワード変更</h3>
                      <p>
                        変更しない場合は空欄のまま保存してください。
                      </p>
                    </div>
                    <KeyRound aria-hidden="true" />
                  </div>
                  <div className="account-fields password-fields">
                    <div>
                      <Label htmlFor="current-password">
                        現在のパスワード
                      </Label>
                      <Input
                        id="current-password"
                        type="password"
                        value={currentPassword}
                        onChange={(event) =>
                          setCurrentPassword(
                            event.target.value,
                          )
                        }
                        autoComplete="current-password"
                      />
                    </div>
                    <div>
                      <Label htmlFor="new-password">
                        新しいパスワード
                      </Label>
                      <Input
                        id="new-password"
                        type="password"
                        value={newPassword}
                        onChange={(event) =>
                          setNewPassword(event.target.value)
                        }
                        autoComplete="new-password"
                      />
                    </div>
                    <div>
                      <Label htmlFor="confirm-password">
                        新しいパスワード（確認）
                      </Label>
                      <Input
                        id="confirm-password"
                        type="password"
                        value={confirmPassword}
                        onChange={(event) =>
                          setConfirmPassword(
                            event.target.value,
                          )
                        }
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                </section>
                {adminFormError && (
                  <div
                    className="account-form-error"
                    role="alert"
                  >
                    <CircleAlert aria-hidden="true" />
                    {adminFormError}
                  </div>
                )}
                <div className="account-form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAdminDraft({
                        name: adminAccount.name,
                        email: adminAccount.email,
                      });
                      setCurrentPassword("");
                      setNewPassword("");
                      setConfirmPassword("");
                      setAdminFormError("");
                    }}
                  >
                    変更を取り消す
                  </Button>
                  <Button
                    type="submit"
                    className="admin-primary"
                  >
                    <ShieldCheck aria-hidden="true" />
                    管理者情報を保存
                  </Button>
                </div>
              </form>
            </section>
          )}
        </main>
      </div>

      <Sheet
        open={Boolean(editingUser)}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null);
        }}
      >
        <SheetContent className="admin-sheet" side="right">
          <SheetHeader>
            <div className="sheet-title-row">
              <span>
                <UserRound aria-hidden="true" />
              </span>
              <div>
                <SheetTitle>登録者情報を変更</SheetTitle>
                <SheetDescription>
                  {editingUser?.id} の登録内容を編集します。
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          {editingUser && (
            <div className="sheet-body">
              <section>
                <h3>登録者情報</h3>
                <div className="sheet-grid">
                  <div className="full-field">
                    <Label htmlFor="user-name">
                      登録者名
                    </Label>
                    <Input
                      id="user-name"
                      value={editingUser.name}
                      onChange={(event) =>
                        setEditingUser({
                          ...editingUser,
                          name: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label>利用状態</Label>
                    <Select
                      value={editingUser.status}
                      onValueChange={(value) =>
                        setEditingUser({
                          ...editingUser,
                          status: value as UserStatus,
                        })
                      }
                    >
                      <SelectTrigger className="sheet-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">
                          利用中
                        </SelectItem>
                        <SelectItem value="suspended">
                          利用停止
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>顔登録状態</Label>
                    <Select
                      value={editingUser.faceStatus}
                      onValueChange={(value) =>
                        setEditingUser({
                          ...editingUser,
                          faceStatus: value as FaceStatus,
                        })
                      }
                    >
                      <SelectTrigger className="sheet-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="registered">
                          登録済み
                        </SelectItem>
                        <SelectItem value="renewal">
                          再登録待ち
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <dl className="registration-meta">
                  <div>
                    <dt>登録日</dt>
                    <dd>{editingUser.registeredAt}</dd>
                  </div>
                  <div>
                    <dt>同意文面</dt>
                    <dd>{editingUser.consentVersion}</dd>
                  </div>
                  <div>
                    <dt>最終安否確認</dt>
                    <dd>{editingUser.lastCheckAt}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <div className="section-title-row">
                  <div>
                    <h3>メール送信先</h3>
                    <p>
                      1件必須、最大2件まで登録できます。
                    </p>
                  </div>
                  <span>
                    {editingUser.recipients.length} / 2件
                  </span>
                </div>
                <div className="sheet-recipients">
                  {editingUser.recipients.map(
                    (recipient, index) => (
                      <div
                        className="sheet-recipient"
                        key={recipient.id}
                      >
                        <div className="sheet-recipient-head">
                          <span>{index + 1}</span>
                          <strong>送信先{index + 1}</strong>
                          <button
                            type="button"
                            aria-label={`送信先${index + 1}を削除`}
                            onClick={() =>
                              setDeleteTarget({
                                kind: "recipient",
                                userId: editingUser.id,
                                recipientId: recipient.id,
                                label:
                                  recipient.name ||
                                  `送信先${index + 1}`,
                              })
                            }
                          >
                            <Trash2 aria-hidden="true" />
                            削除
                          </button>
                        </div>
                        <div className="sheet-grid">
                          <div>
                            <Label
                              htmlFor={`recipient-name-${recipient.id}`}
                            >
                              氏名
                            </Label>
                            <Input
                              id={`recipient-name-${recipient.id}`}
                              value={recipient.name}
                              onChange={(event) =>
                                updateRecipientDraft(
                                  recipient.id,
                                  "name",
                                  event.target.value,
                                )
                              }
                            />
                          </div>
                          <div>
                            <Label
                              htmlFor={`recipient-email-${recipient.id}`}
                            >
                              メールアドレス
                            </Label>
                            <Input
                              id={`recipient-email-${recipient.id}`}
                              type="email"
                              value={recipient.email}
                              onChange={(event) =>
                                updateRecipientDraft(
                                  recipient.id,
                                  "email",
                                  event.target.value,
                                )
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ),
                  )}
                  {editingUser.recipients.length < 2 && (
                    <button
                      type="button"
                      className="add-recipient-button"
                      onClick={addRecipientDraft}
                    >
                      <Plus aria-hidden="true" />
                      <span>
                        <strong>
                          {editingUser.recipients.length ===
                          0
                            ? "送信先を登録"
                            : "2件目の送信先を追加"}
                        </strong>
                        <small>
                          1件必須、最大2件まで登録できます
                        </small>
                      </span>
                    </button>
                  )}
                </div>
              </section>
              {formError && (
                <div className="sheet-error" role="alert">
                  <CircleAlert aria-hidden="true" />
                  {formError}
                </div>
              )}
              <button
                type="button"
                className="delete-user-link"
                onClick={() =>
                  setDeleteTarget({
                    kind: "user",
                    userId: editingUser.id,
                    label: editingUser.name,
                  })
                }
              >
                <Trash2 aria-hidden="true" />
                この登録者を削除する
              </button>
            </div>
          )}
          <SheetFooter>
            <Button
              variant="outline"
              onClick={() => setEditingUser(null)}
            >
              キャンセル
            </Button>
            <Button
              className="admin-primary"
              onClick={saveUser}
            >
              変更を保存
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="admin-delete-dialog">
          <AlertDialogMedia>
            <Trash2 aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "user"
                ? "登録者情報を削除しますか？"
                : "メール送信先を削除しますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "user"
                ? `${deleteTarget.label}さんの登録者情報、顔登録情報、送信先、同意履歴が削除対象になります。`
                : `${deleteTarget?.label}さんをメール送信先から削除します。登録者情報は削除されません。`}{" "}
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
