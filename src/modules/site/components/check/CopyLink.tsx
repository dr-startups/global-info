"use client";

/**
 * «Скопировать ссылку» — на ожидании, результате и «спасибо»: результат
 * открывается по ссылке. Отказ буфера обмена — не тупик: подпись говорит, откуда
 * взять адрес.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { COPY_TEXT } from "@/modules/site/content/check";

export function useCopyLink() {
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(window.location.href);
      ok = true;
    } catch {
      ok = false;
    }
    setCopied(ok);
    setStatus(ok ? COPY_TEXT.copied : COPY_TEXT.failed);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      if (ok) setStatus("");
    }, 2400);
  }, []);

  return { copied, status, copy };
}

export function CopyButton({
  state,
  variant,
  block,
}: {
  state: ReturnType<typeof useCopyLink>;
  variant: "secondary" | "ghost";
  block?: boolean;
}) {
  return (
    <button
      className={`site-btn site-btn--${variant}${block ? " site-btn--block" : ""} site-copy${state.copied ? " is-copied" : ""}`}
      type="button"
      onClick={() => void state.copy()}
    >
      <span className="site-copy__icons" aria-hidden="true">
        <svg className="site-copy__idle" viewBox="0 0 16 16">
          <use href="#ic-copy" />
        </svg>
        <svg className="site-copy__done" viewBox="0 0 16 16">
          <use href="#ic-check" />
        </svg>
      </span>
      {/* Две подписи в одной ячейке прячутся visibility, а не aria-hidden: иначе у кнопки пропадёт имя */}
      <span className="site-copy__label">
        <span className="site-copy__text">{COPY_TEXT.idle}</span>
        <span className="site-copy__text site-copy__text--done">{COPY_TEXT.done}</span>
      </span>
    </button>
  );
}

export function CopyStatus({ state }: { state: ReturnType<typeof useCopyLink> }) {
  return (
    <p className="site-caption site-copy__status" role="status">
      {state.status}
    </p>
  );
}
