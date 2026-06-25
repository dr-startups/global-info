"use client";

import { useDpAuth } from "./auth-provider";
import { useDigitalProfileI18n } from "./i18n-provider";
import { authLabels, roleLabel } from "./auth-labels";
import { Badge } from "./components";

/** Shows the current user + role badge + sign-out button (when auth enabled). */
export function UserBadge() {
  const { authEnabled, user, signOut } = useDpAuth();
  const { locale } = useDigitalProfileI18n();
  const L = authLabels(locale);

  if (!authEnabled || !user) return null;

  return (
    <div className="dp-inline" style={{ gap: 8, alignItems: "center" }}>
      <span className="dp-muted" style={{ fontSize: 13 }}>
        {L.signedInAs} <strong>{user.name}</strong>
      </span>
      <Badge tone="info">{roleLabel(user.role, locale)}</Badge>
      <button className="dp-btn dp-btn-sm" onClick={() => void signOut()}>
        {L.signOut}
      </button>
    </div>
  );
}
