"use client";

/**
 * 安心安否確認システム：管理者用UI
 *
 * PCブラウザから登録者・最大2件のメール送信先・個人情報取扱文面を
 * 管理します。単一管理者のメールアドレスとパスワードによる認証と管理APIを使用します。
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
  useRef,
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
import {
  adminApi,
  type AdminSession,
  type AdminSettings,
  type Dashboard,
  type Policy,
} from "@/lib/admin-api";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ADMIN_LOGIN_PATH,
  ADMIN_PAGE_PATHS,
  getAdminLoginPath,
  getAdminView,
  getLoginReturnPath,
  type AdminView,
} from "@/lib/admin-navigation";
type UserStatus =
  | "active"
  | "suspended"
  | "pending_registration";
type FaceStatus = "registered" | "renewal";
type Recipient = {
  id: string;
  name: string;
  email: string;
};
type AdminAccount = {
  name: string;
  email: string;
  lastLoginAt: string;
  lastLoginIp: string;
};
type RegisteredUser = {
  id: string;
  name: string;
  revision: string;
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
  name: "",
  email: "",
  lastLoginAt: "—",
  lastLoginIp: "—",
};
const INITIAL_PRIVACY = "",
  INITIAL_MAIL_SUBJECT = "",
  INITIAL_MAIL_BODY = "";
const MAIL_TEMPLATE_VARIABLES = [
  "{{送信先名}}",
  "{{登録者名}}",
  "{{確認日時}}",
  "{{施設名}}",
] as const;
const renderMailSample = (text: string) =>
  text.replace(
    /\{\{(送信先名|登録者名|確認日時|施設名)\}\}/g,
    (_, key: string) =>
      (
        ({
          送信先名: "山田 花子",
          登録者名: "山田 太郎",
          確認日時: "2026/10/06 10:30",
          施設名: "安心施設",
        }) as Record<string, string>
      )[key],
  );
const formatDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "処理を完了できません。";

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
      {status === "active"
        ? "利用中"
        : status === "pending_registration"
          ? "登録確認中"
          : "利用停止"}
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
}: {
  user: RegisteredUser;
  size?: "table" | "large";
}) {
  return (
    <span
      className="face-placeholder"
      aria-label={`${user.name}さん`}
    >
      <UserRound aria-hidden="true" />
    </span>
  );
}

export default function AdminConsole() {
  const pathname = usePathname();
  const router = useRouter();
  const view = getAdminView(pathname) ?? "dashboard";
  const isLoginPage = pathname.replace(/\/$/, "") === ADMIN_LOGIN_PATH;
  const isKnownPage = isLoginPage || pathname === "/admin" || getAdminView(pathname) !== undefined;
  const [authChecking, setAuthChecking] = useState(true);
  const explicitLogout = useRef(false);
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
  const loginErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loginError) loginErrorRef.current?.focus();
  }, [loginError]);
  const [currentPassword, setCurrentPassword] =
    useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] =
    useState("");
  const [adminFormError, setAdminFormError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [users, setUsers] = useState<RegisteredUser[]>([]);
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
  const [mailSavedAt, setMailSavedAt] = useState("—");
  const [privacyText, setPrivacyText] =
    useState(INITIAL_PRIVACY);
  const [savedPrivacyText, setSavedPrivacyText] =
    useState(INITIAL_PRIVACY);
  const [privacyVersion, setPrivacyVersion] = useState("");
  const [privacyDate, setPrivacyDate] = useState(
    new Date().toLocaleDateString("en-CA"),
  );
  const [privacyMode, setPrivacyMode] = useState<
    "edit" | "preview"
  >("edit");
  const [privacySavedAt, setPrivacySavedAt] = useState("—");
  const [activities, setActivities] = useState(
    [] as string[],
  );
  const [flash, setFlash] = useState<FlashMessage>(null);
  const [isInteractive, setIsInteractive] = useState(false);

  const [busy, setBusy] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] =
    useState(false);
  const [ownerPresent, setOwnerPresent] = useState(false);
  const [faceConsent, setFaceConsent] = useState(false);
  const [faceImage, setFaceImage] = useState("");
  const [settings, setSettings] =
    useState<AdminSettings | null>(null);
  const [dashboard, setDashboard] =
    useState<Dashboard | null>(null);
  const [mailRevision, setMailRevision] = useState("");
  const MAIL_ERRORS = (dashboard?.errors ?? []).map(
    (error) => ({
      ...error,
      occurredAt: formatDate(error.occurredAt),
      reason:
        error.status === "unknown"
          ? "受理結果が不明です。重複送信を避け、送信記録を確認してください。"
          : error.status === "bounced"
            ? "配信できませんでした。送信先を確認してください。"
            : "メール送信に失敗しました。",
    }),
  );
  const setProfile = (profile: AdminSession["admin"]) => {
    setAdminAccount({
      name: profile.name,
      email: profile.email,
      lastLoginAt: formatDate(profile.last_login_at),
      lastLoginIp: profile.last_login_ip ?? "—",
    });
    setAdminDraft({
      name: profile.name,
      email: profile.email,
    });
  };
  const applyPolicy = (policy: Policy) => {
    setPrivacyText(policy.body);
    setSavedPrivacyText(policy.body);
    setPrivacyVersion(policy.policy_version);
    setPrivacyDate(
      policy.effective_date === "1970-01-01"
        ? new Date().toLocaleDateString("en-CA")
        : policy.effective_date,
    );
  };
  const loadData = async () => {
    const [list, summary, configuration] =
      await Promise.all([
        adminApi<{
          users: RegisteredUser[];
          total: number;
        }>("/users?limit=200"),
        adminApi<Dashboard>("/dashboard"),
        adminApi<AdminSettings>("/settings"),
      ]);
    setUsers(list.users);
    setDashboard(summary);
    setSettings(configuration);
    setMailSubject(configuration.mail.subject);
    setSavedMailSubject(configuration.mail.subject);
    setMailBody(configuration.mail.body);
    setSavedMailBody(configuration.mail.body);
    setMailRevision(configuration.mail.revision);
    setMailSavedAt(
      formatDate(configuration.mail.updated_at),
    );
    const policy = configuration.policies.find(
      (x) => x.consent_type === "registration",
    );
    if (policy) applyPolicy(policy);
    setPrivacySavedAt("データベースから取得");
    setActivities(
      summary.activities.map(
        (x) => `${formatDate(x.occurred_at)} ${x.action}`,
      ),
    );
  };
  const photoEpoch = useRef(0);
  const closeEditor = () => {
    photoEpoch.current++;
    setEditingUser(null);
    setFaceImage("");
    setOwnerPresent(false);
    setFaceConsent(false);
  };
  const clearSession = () => {
    setIsAuthenticated(false);
    setUsers([]);
    closeEditor();
    setDeleteTarget(null);
    setDashboard(null);
    setSettings(null);
    setActivities([]);
    setFaceImage("");
    setMailBody("");
    setSavedMailBody("");
    setPrivacyText("");
    setSavedPrivacyText("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };
  useEffect(() => {
    let cancelled = false;
    const expired = () => {
      clearSession();
      setLoginError(
        "有効期限が切れました。再ログインしてください。",
      );
    };
    window.addEventListener(
      "admin-session-expired",
      expired,
    );
    void adminApi<AdminSession>("/session")
      .then(async (session) => {
        if (cancelled) return;
        setProfile(session.admin);
        await loadData();
        if (!cancelled) setIsAuthenticated(true);
      })
      .catch((error) => {
        if (!cancelled && error.status !== 401)
          setLoginError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false);
      });
    return () => {
      cancelled = true;
      window.removeEventListener(
        "admin-session-expired",
        expired,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authChecking || !isKnownPage) return;
    if (isAuthenticated && isLoginPage) {
      router.replace(getLoginReturnPath(window.location.search));
    } else if (!isAuthenticated && isLoginPage) {
      explicitLogout.current = false;
    } else if (!isAuthenticated && !explicitLogout.current) {
      router.replace(getAdminLoginPath(pathname));
    }
  }, [authChecking, isAuthenticated, isKnownPage, isLoginPage, pathname, router]);
  const searchUsers = async () => {
    try {
      if (!query.trim()) {
        await loadData();
        return;
      }
      const result = await adminApi<{
        users: RegisteredUser[];
      }>("/users/search", "POST", {
        name: query.trim(),
        reason: "support",
      });
      setUsers(result.users);
    } catch (error) {
      setFlash({ tone: "error", text: errorText(error) });
    }
  };
  const loadMoreUsers = async () => {
    try {
      const result = await adminApi<{
        users: RegisteredUser[];
      }>(`/users?limit=200&offset=${users.length}`);
      setUsers((current) => [...current, ...result.users]);
    } catch (error) {
      setFlash({ tone: "error", text: errorText(error) });
    }
  };

  // クライアント側の操作機能が読み込まれたことを画面上でも確認できるようにします。
  useEffect(() => {
    queueMicrotask(() => setIsInteractive(true));
  }, []);

  // 操作結果メッセージは一定時間後に自動で閉じます。
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(
      () => setFlash(null),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [flash]);

  const activeCount = dashboard?.counts.active ?? 0;
  const recipientCount = dashboard?.counts.recipients ?? 0;
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
        !keyword || user.name.toLowerCase() === keyword;
      return matchesStatus && matchesQuery;
    });
  }, [query, statusFilter, users]);

  const handleLogin = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setLoginError("");
    try {
      const session = await adminApi<AdminSession>(
        "/login",
        "POST",
        {
          email: loginEmail.trim().toLowerCase(),
          password: loginPassword,
        },
      );
      setProfile(session.admin);
      setLoginPassword("");
      await loadData();
      setIsAuthenticated(true);
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const handleLogout = async () => {
    try {
      await adminApi("/logout", "POST");
      explicitLogout.current = true;
      clearSession();
      router.replace(ADMIN_LOGIN_PATH);
      setFlash(null);
    } catch (error) {
      showFlash("error", errorText(error));
    }
  };

  const selectView = (nextView: AdminView) => {
    router.push(ADMIN_PAGE_PATHS[nextView]);
    setMobileNavOpen(false);
  };

  const showFlash = (
    tone: NonNullable<FlashMessage>["tone"],
    text: string,
  ) => {
    setFlash({ tone, text });
  };

  const saveAdminAccount = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (busy) return;
    if (
      newPassword &&
      (newPassword.length < 12 ||
        newPassword !== confirmPassword)
    ) {
      setAdminFormError(
        "新しいパスワードは12文字以上で、確認欄と一致させてください。",
      );
      return;
    }
    setBusy(true);
    setAdminFormError("");
    try {
      await adminApi("/profile", "PUT", {
        name: adminDraft.name.trim(),
        email: adminDraft.email.trim(),
        current_password: currentPassword,
        ...(newPassword
          ? { new_password: newPassword }
          : {}),
      });
      clearSession();
      setLoginError(
        "管理者情報を保存しました。メールアドレスとパスワードで再ログインしてください。",
      );
    } catch (error) {
      setAdminFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const refreshData = async () => {
    try {
      await loadData();
      showFlash("success", "最新のデータを読み込みました");
    } catch (error) {
      showFlash("error", errorText(error));
    }
  };

  const openUserEditor = (user: RegisteredUser) => {
    setFormError("");
    setIdentityConfirmed(false);
    photoEpoch.current++;
    setFaceImage("");
    setOwnerPresent(false);
    setFaceConsent(false);
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

  const saveUser = async () => {
    if (busy) return;
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
    if (!identityConfirmed) {
      setFormError(
        "本人確認を実施したことを確認してください。",
      );
      return;
    }
    setBusy(true);
    try {
      const resetFace =
        editingUser.faceStatus === "renewal" &&
        users.find((x) => x.id === editingUser.id)
          ?.faceStatus === "registered";
      const result = await adminApi<{
        user: RegisteredUser;
      }>(`/users/${editingUser.id}`, "PUT", {
        name: trimmedName,
        status: editingUser.status,
        recipients: recipients.map((x) => ({
          name: x.name,
          email: x.email,
          ...(/^[0-9a-f-]{36}$/i.test(x.id)
            ? { id: x.id }
            : {}),
        })),
        expected_revision: editingUser.revision,
        identity_confirmed: true,
        reset_face: resetFace,
        reason:
          resetFace || editingUser.status === "suspended"
            ? "suspension"
            : "correction",
      });
      await loadData();
      setEditingUser(resetFace ? result.user : null);
      setIdentityConfirmed(false);
      showFlash(
        "success",
        resetFace
          ? "旧顔データを無効化しました。本人立会いで顔を再登録してください。"
          : "登録者情報を保存しました",
      );
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const confirmDelete = async () => {
    if (!deleteTarget || busy) return;
    const user = users.find(
      (x) => x.id === deleteTarget.userId,
    );
    if (!user) return;
    setBusy(true);
    try {
      await adminApi(
        `/users/${user.id}${deleteTarget.kind === "recipient" ? `/recipients/${deleteTarget.recipientId}` : ""}`,
        "DELETE",
        {
          expected_revision: user.revision,
          reason: "deletion",
        },
      );
      setDeleteTarget(null);
      closeEditor();
      await loadData();
      showFlash(
        "success",
        "削除を記録し、対象データを消去しました",
      );
    } catch (error) {
      showFlash("error", errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const savePrivacy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi("/policies/registration", "POST", {
        policy_version: privacyVersion.trim(),
        body: privacyText.trim(),
        effective_date: privacyDate,
      });
      await loadData();
      showFlash(
        "success",
        "新しい文面を保存しました。指定日から適用されます。",
      );
    } catch (error) {
      showFlash("error", errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const saveMailTemplate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi("/mail-template", "PUT", {
        subject: mailSubject.trim(),
        body: mailBody.trim(),
        expected_revision: mailRevision,
      });
      await loadData();
      showFlash(
        "success",
        "送信メールの内容を保存しました",
      );
    } catch (error) {
      showFlash("error", errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const reenrollFace = async () => {
    if (
      !editingUser ||
      !faceImage ||
      !ownerPresent ||
      !faceConsent ||
      busy
    )
      return;
    const policy = settings?.policies.find(
      (x) => x.consent_type === "registration",
    );
    if (!policy) return;
    setBusy(true);
    try {
      await adminApi(
        `/users/${editingUser.id}/face`,
        "POST",
        {
          image_base64: faceImage,
          expected_revision: editingUser.revision,
          owner_present: true,
          consent_granted: true,
          policy_version: policy.policy_version,
        },
      );
      setFaceImage("");
      closeEditor();
      await loadData();
      showFlash(
        "success",
        "顔を再登録し、利用を再開しました",
      );
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const renewConsent = async () => {
    const policy = settings?.policies.find(
      (x) => x.consent_type === "registration",
    );
    if (
      !editingUser ||
      !policy ||
      !ownerPresent ||
      !faceConsent ||
      busy
    )
      return;
    setBusy(true);
    try {
      const result = await adminApi<{
        user: RegisteredUser;
      }>(`/users/${editingUser.id}/consent`, "POST", {
        expected_revision: editingUser.revision,
        owner_present: true,
        consent_granted: true,
        policy_version: policy.policy_version,
      });
      await loadData();
      setEditingUser(result.user);
      setOwnerPresent(false);
      setFaceConsent(false);
      showFlash(
        "success",
        "新しい文面への同意を記録しました",
      );
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
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

  // 未知のURLはルート側の404画面に任せます。
  if (!isKnownPage) return null;

  if (authChecking || (isAuthenticated && isLoginPage) || (!isAuthenticated && !isLoginPage)) {
    return (
      <main className="admin-auth-loading" aria-busy="true">
        <p role="status">管理画面を読み込んでいます…</p>
        <noscript>ブラウザのJavaScriptを有効にして再読み込みしてください。</noscript>
      </main>
    );
  }

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
            aria-busy={busy}
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
              <div
                className="login-error"
                role="alert"
                id="login-error"
                ref={loginErrorRef}
                tabIndex={-1}
              >
                <CircleAlert aria-hidden="true" />
                <div>
                  <strong>ログインできませんでした</strong>
                  <p>{loginError}</p>
                </div>
              </div>
            )}
            <Button
              type="submit"
              className="login-submit"
              disabled={busy}
            >
              <LogIn aria-hidden="true" />
              {busy ? "ログイン中…" : "ログイン"}
            </Button>
            <p className="login-security-note">
              <ShieldCheck aria-hidden="true" />
              メールアドレスとパスワードでログインします。
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
                    <small>
                      登録 {formatDate(user.registeredAt)}
                    </small>
                  )}
                  <span>
                    {formatDate(user.lastCheckAt)}
                  </span>
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
              <Link
                key={item.id}
                href={ADMIN_PAGE_PATHS[item.id]}
                className={
                  view === item.id ? "is-active" : ""
                }
                aria-current={
                  view === item.id ? "page" : undefined
                }
                onClick={() => setMobileNavOpen(false)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {view === item.id && (
                  <ChevronRight aria-hidden="true" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="environment-note">
            <Database aria-hidden="true" />
            <div>
              <strong>管理者接続</strong>
              <span>共有データベースを表示中</span>
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
                  `最近の変更を${activities.length}件、メール送信エラーを${dashboard?.counts.errors ?? 0}件表示しています`,
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
                      {dashboard?.counts.users ?? 0}
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
                      最大{" "}
                      {(dashboard?.counts.users ?? 0) * 2}
                      件まで登録可能
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
                      {dashboard?.counts.today ?? 0}
                      <em>件</em>
                    </strong>
                    <p>
                      <b>
                        {dashboard?.counts.accepted ?? 0}件
                      </b>
                      受理済み
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
                      {dashboard?.counts.errors ?? 0}
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
                    登録・送信状況を共有データベースから表示しています
                  </strong>
                  <span>
                    最新の変更を確認するには再読み込みしてください。
                  </span>
                </div>
                <Button
                  variant="outline"
                  className="sample-reset-button"
                  onClick={refreshData}
                >
                  <RefreshCw aria-hidden="true" />
                  最新データを再読込
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
                    未解決 {dashboard?.counts.errors ?? 0}件
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
                      <h2>最近の登録者</h2>
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

          {(view === "users" || view === "recipients") && (
            <div className="admin-data-controls">
              <Button
                variant="outline"
                onClick={() => void searchUsers()}
              >
                氏名完全一致で検索
              </Button>
              <span>
                {users.length}件を表示 / 全
                {dashboard?.counts.users ?? 0}件
              </span>
              {!query &&
                users.length <
                  (dashboard?.counts.users ?? 0) && (
                  <Button
                    variant="outline"
                    onClick={() => void loadMoreUsers()}
                  >
                    次の200件
                  </Button>
                )}
            </div>
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
                    placeholder="氏名（完全一致）で検索"
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
                    disabled={busy}
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
                    disabled={busy}
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
                    最終ログインの接続元をサーバー側で記録しています。
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
                        現在のパスワードは必須です。新しいパスワードは変更時のみ入力してください。
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
                    disabled={busy}
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
          if (!open) closeEditor();
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
                        {editingUser.status ===
                          "pending_registration" && (
                          <SelectItem value="pending_registration">
                            登録確認中
                          </SelectItem>
                        )}
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
                        <SelectItem
                          value="registered"
                          disabled={
                            users.find(
                              (x) =>
                                x.id === editingUser.id,
                            )?.faceStatus !== "registered"
                          }
                        >
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
                    <dd>
                      {formatDate(editingUser.registeredAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>同意文面</dt>
                    <dd>{editingUser.consentVersion}</dd>
                  </div>
                  <div>
                    <dt>最終安否確認</dt>
                    <dd>
                      {formatDate(editingUser.lastCheckAt)}
                    </dd>
                  </div>
                </dl>
              </section>
              <label className="admin-confirm">
                <input
                  type="checkbox"
                  checked={identityConfirmed}
                  onChange={(event) =>
                    setIdentityConfirmed(
                      event.target.checked,
                    )
                  }
                />
                本人確認を実施し、変更内容を確認しました。
              </label>
              {settings?.policies.some(
                (x) =>
                  x.consent_type === "registration" &&
                  x.requires_reconsent &&
                  x.policy_version !==
                    editingUser.consentVersion,
              ) && (
                <section>
                  <h3>最新文面への再同意</h3>
                  <p>
                    {
                      settings.policies.find(
                        (x) =>
                          x.consent_type === "registration",
                      )?.body
                    }
                  </p>
                  <label className="admin-confirm">
                    <input
                      type="checkbox"
                      checked={ownerPresent}
                      onChange={(event) =>
                        setOwnerPresent(
                          event.target.checked,
                        )
                      }
                    />
                    ご本人が立ち会っています。
                  </label>
                  <label className="admin-confirm">
                    <input
                      type="checkbox"
                      checked={faceConsent}
                      onChange={(event) =>
                        setFaceConsent(event.target.checked)
                      }
                    />
                    ご本人が文面を確認し、同意しました。
                  </label>
                  <Button
                    disabled={
                      busy || !ownerPresent || !faceConsent
                    }
                    onClick={renewConsent}
                  >
                    再同意を記録
                  </Button>
                </section>
              )}
              {editingUser.status === "suspended" &&
                users.find((x) => x.id === editingUser.id)
                  ?.faceStatus === "renewal" && (
                  <section className="face-reenroll">
                    <h3>本人立会いで顔を再登録</h3>
                    <p>
                      顔写真は一時的に処理し、原画像を保存しません。
                    </p>
                    <Input
                      type="file"
                      accept="image/jpeg,image/png"
                      onChange={(event) => {
                        const file =
                          event.target.files?.[0];
                        setFaceImage("");
                        if (!file) return;
                        if (file.size > 512 * 1024) {
                          setFormError(
                            "写真は512 KiB以下にしてください。",
                          );
                          return;
                        }
                        const reader = new FileReader();
                        const epoch = photoEpoch.current;
                        reader.onload = () => {
                          if (photoEpoch.current === epoch)
                            setFaceImage(
                              String(reader.result).split(
                                ",",
                              )[1] ?? "",
                            );
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                    <label className="admin-confirm">
                      <input
                        type="checkbox"
                        checked={ownerPresent}
                        onChange={(event) =>
                          setOwnerPresent(
                            event.target.checked,
                          )
                        }
                      />
                      ご本人が立ち会っています。
                    </label>
                    <details>
                      <summary>
                        現在の個人情報取扱文面
                      </summary>
                      <p>
                        {
                          settings?.policies.find(
                            (x) =>
                              x.consent_type ===
                              "registration",
                          )?.body
                        }
                      </p>
                    </details>
                    <label className="admin-confirm">
                      <input
                        type="checkbox"
                        checked={faceConsent}
                        onChange={(event) =>
                          setFaceConsent(
                            event.target.checked,
                          )
                        }
                      />
                      ご本人が現在の文面に同意しました。
                    </label>
                    <Button
                      disabled={
                        busy ||
                        !faceImage ||
                        !ownerPresent ||
                        !faceConsent
                      }
                      onClick={reenrollFace}
                    >
                      顔を登録して利用再開
                    </Button>
                  </section>
                )}
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
              onClick={() => closeEditor()}
            >
              キャンセル
            </Button>
            <Button
              className="admin-primary"
              onClick={saveUser}
              disabled={busy}
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
              disabled={busy}
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
