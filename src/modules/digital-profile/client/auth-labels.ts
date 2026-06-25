/**
 * Small RU/EN label map for the auth UI (Stage M1). Kept separate from the main
 * typed dictionary to avoid widening it; auth strings are few and self-contained.
 */

import type { Locale } from "../i18n";
import type { DpRole } from "../auth/roles";

type AuthLabels = {
  signInTitle: string;
  signInSubtitle: string;
  email: string;
  password: string;
  signIn: string;
  signingIn: string;
  invalidCredentials: string;
  signOut: string;
  signedInAs: string;
  accessDeniedTitle: string;
  accessDeniedHint: string;
  role: string;
  demoHint: string;
};

const EN: AuthLabels = {
  signInTitle: "Sign in",
  signInSubtitle: "Digital Profile Audit — authorized access only.",
  email: "Email",
  password: "Password",
  signIn: "Sign in",
  signingIn: "Signing in…",
  invalidCredentials: "Invalid email or password.",
  signOut: "Sign out",
  signedInAs: "Signed in as",
  accessDeniedTitle: "Access denied",
  accessDeniedHint: "Your role does not allow this action.",
  role: "Role",
  demoHint: "Demo credentials are listed in the project docs (demo-only).",
};

const RU: AuthLabels = {
  signInTitle: "Вход",
  signInSubtitle: "Digital Profile Audit — только авторизованный доступ.",
  email: "Эл. почта",
  password: "Пароль",
  signIn: "Войти",
  signingIn: "Вход…",
  invalidCredentials: "Неверная почта или пароль.",
  signOut: "Выйти",
  signedInAs: "Вы вошли как",
  accessDeniedTitle: "Доступ запрещён",
  accessDeniedHint: "Ваша роль не позволяет выполнить это действие.",
  role: "Роль",
  demoHint: "Демо-учётные данные указаны в документации проекта (только для демо).",
};

export function authLabels(locale: Locale): AuthLabels {
  return locale === "en" ? EN : RU;
}

const ROLE_LABELS: Record<DpRole, { ru: string; en: string }> = {
  SUPER_ADMIN: { ru: "Супер-админ", en: "Super admin" },
  ADMIN: { ru: "Администратор", en: "Admin" },
  ANALYST: { ru: "Аналитик", en: "Analyst" },
  REVIEWER: { ru: "Ревьюер", en: "Reviewer" },
  CLIENT_VIEWER: { ru: "Клиент (просмотр)", en: "Client viewer" },
};

export function roleLabel(role: DpRole, locale: Locale): string {
  return ROLE_LABELS[role]?.[locale] ?? role;
}
