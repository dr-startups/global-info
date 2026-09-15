"use client";

/**
 * Невидимая Yandex SmartCaptcha на форме проверки.
 *
 * Скрипт подключается только при заданном ключе виджета: на стенде ключа нет, и
 * сервер пропускает форму без токена с предупреждением в лог. Уведомление об
 * обработке данных SmartCaptcha не скрывается — сообщить посетителю о нём
 * обязан оператор (документация Yandex Cloud).
 *
 * Ветка с ключом вживую не гонялась: ключей на стенде нет.
 */

import { useCallback, useEffect, useRef } from "react";

interface SmartCaptchaApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => number;
  execute: (widgetId?: number) => void;
  reset?: (widgetId?: number) => void;
  destroy?: (widgetId?: number) => void;
  subscribe?: (widgetId: number, event: string, callback: () => void) => void;
}

declare global {
  interface Window {
    smartCaptcha?: SmartCaptchaApi;
    __siteSmartCaptchaReady?: () => void;
  }
}

const SCRIPT_SRC = "https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload&onload=__siteSmartCaptchaReady";
/** Посетитель закрыл задание и ушёл — форма не должна висеть в «отправляется» вечно. */
const EXECUTE_TIMEOUT_MS = 120_000;

let scriptLoad: Promise<SmartCaptchaApi> | null = null;

function loadScript(): Promise<SmartCaptchaApi> {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  scriptLoad ??= new Promise<SmartCaptchaApi>((resolve, reject) => {
    window.__siteSmartCaptchaReady = () => (window.smartCaptcha ? resolve(window.smartCaptcha) : reject());
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.defer = true;
    script.onerror = () => {
      scriptLoad = null;
      reject(new Error("captcha-script-failed"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export function useSmartCaptcha(sitekey: string | null) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<number | null>(null);
  const pending = useRef<{ resolve: (token: string) => void; reject: (err: Error) => void } | null>(null);

  useEffect(() => {
    if (!sitekey || !container.current) return;
    let alive = true;
    void loadScript()
      .then((api) => {
        if (!alive || !container.current) return;
        const id = api.render(container.current, {
          sitekey,
          invisible: true,
          hl: "ru",
          callback: (token: string) => {
            pending.current?.resolve(token);
            pending.current = null;
          },
        });
        widget.current = id;
        api.subscribe?.(id, "challenge-hidden", () => {
          pending.current?.reject(new Error("captcha-closed"));
          pending.current = null;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (widget.current !== null) window.smartCaptcha?.destroy?.(widget.current);
      widget.current = null;
    };
  }, [sitekey]);

  const execute = useCallback(
    () =>
      new Promise<string>((resolve, reject) => {
        const api = window.smartCaptcha;
        if (!api || widget.current === null) {
          reject(new Error("captcha-not-ready"));
          return;
        }
        pending.current = { resolve, reject };
        window.setTimeout(() => {
          if (pending.current?.resolve !== resolve) return;
          pending.current = null;
          reject(new Error("captcha-timeout"));
        }, EXECUTE_TIMEOUT_MS);
        api.execute(widget.current);
      }),
    []
  );

  /** Токен одноразовый: следующая отправка формы просит новый. */
  const reset = useCallback(() => {
    if (widget.current !== null) window.smartCaptcha?.reset?.(widget.current);
  }, []);

  return { container, execute, reset };
}
