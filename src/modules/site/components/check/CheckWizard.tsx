"use client";

/**
 * Мастер проверки на `/check/[publicId]`.
 *
 * Экран выводится из проекции статуса (`wizardScreen`), а данные приходят только
 * через `/api/self-check/*`: страница сама ничего не читает, cookie посетителя
 * живёт на пути API. Опрос — только у идущего прогона и по сроку сервера
 * (`createStatusPoller`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/modules/site/analytics";
import { siteApi, type ApiRefusal } from "@/modules/site/api";
import { createStatusPoller } from "@/modules/site/check/polling";
import type { PersonaCardJson, PersonaPanelJson, PublicStatusJson, RunJson } from "@/modules/site/check/types";
import { wizardScreen, wizardStep, type Refusal, type WizardScreen } from "@/modules/site/check/wizard-state";
import { RUN_STAGE_LABELS } from "@/modules/self-check/run-stages";
import { SERVICE_SCREENS } from "@/modules/site/content/check";
import { LeadScreen } from "./LeadScreen";
import { ServiceScreen, WizardBand, WizardFrame } from "./parts";
import { PersonaEmptyScreen, PersonaLoadingScreen, PersonaScreen, StartScreen } from "./PersonaScreens";
import { ResultScreen } from "./ResultScreen";
import { ThanksScreen } from "./ThanksScreen";
import { WaitingScreen } from "./WaitingScreen";

const PERSONA_RETRY_MS = 3000;
const NETWORK_RETRY_MS = 5000;

/** Идущий прогон без хода в ответе (не должен случаться) — первая стадия, а не пустой экран. */
const NO_RUN: RunJson = {
  stage: "collecting",
  stageLabel: RUN_STAGE_LABELS.collecting,
  progress: 0,
  nextPollMs: 7000,
  startedAt: null,
};

export function CheckWizard({ publicId }: { publicId: string }) {
  const [status, setStatus] = useState<PublicStatusJson | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [panel, setPanel] = useState<PersonaPanelJson | null>(null);
  const [view, setView] = useState<"lead" | "thanks" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const seen = useRef(new Set<string>());

  const refuse = useCallback((res: ApiRefusal) => setRefusal({ status: res.status, reason: res.reason }), []);

  const loadStatus = useCallback(async (): Promise<PublicStatusJson | "retry" | null> => {
    const res = await siteApi.status(publicId);
    if (res.ok) {
      setRefusal(null);
      setStatus(res.data);
      return res.data;
    }
    if (res.status === 0) return "retry";
    refuse(res);
    return null;
  }, [publicId, refuse]);

  const reload = useCallback(async () => {
    const answer = await loadStatus();
    if (answer === "retry") setRefusal({ status: 0, reason: "NETWORK_ERROR" });
  }, [loadStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const statusCode = status?.status;

  // Панель «Это вы?» собирается один раз; повторный вызов отдаёт собранную.
  useEffect(() => {
    if ((statusCode !== "CREATED" && statusCode !== "PERSONA_PENDING") || panel) return;
    let alive = true;
    let timer = 0;
    const build = async () => {
      const res = await siteApi.persona(publicId);
      if (!alive) return;
      if (res.ok) {
        setPanel(res.data);
        if (statusCode === "CREATED") void loadStatus();
        return;
      }
      if (res.status === 409 && res.reason === "PERSONA_BUILD_IN_PROGRESS") {
        timer = window.setTimeout(build, PERSONA_RETRY_MS);
        return;
      }
      if (res.status === 0) {
        timer = window.setTimeout(build, NETWORK_RETRY_MS);
        return;
      }
      // Уже решено или запись ловушки — что дальше, скажет статус.
      if (res.status === 409) {
        void loadStatus();
        return;
      }
      refuse(res);
    };
    void build();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [statusCode, panel, publicId, loadStatus, refuse]);

  // Опрос — пока идёт прогон. Поллер создаётся при входе в RUNNING и дальше ведёт
  // статус сам; следующие ответы с тем же статусом эффект не пересоздают.
  useEffect(() => {
    if (statusCode !== "RUNNING" || !status) return;
    const poller = createStatusPoller<PublicStatusJson>({
      load: async () => {
        const res = await siteApi.status(publicId);
        if (res.ok) return res.data;
        if (res.status === 0) return "retry";
        refuse(res);
        return null;
      },
      onStatus: (next) => {
        setRefusal(null);
        setStatus(next);
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      isVisible: () => document.visibilityState === "visible",
    });
    poller.start(status);
    const onVisibility = () => poller.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
    };
    // `status` намеренно не в зависимостях: иначе каждый ответ опроса пересоздавал бы поллер.
  }, [statusCode, publicId, refuse]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRun = useCallback(async () => {
    const res = await siteApi.run(publicId);
    if (res.ok || (res.status === 409 && res.reason === "RUN_ALREADY_STARTED")) {
      if (res.ok) track("run_started");
      await reload();
      return;
    }
    if (res.status === 409) {
      setNotice("Сначала подтвердите, о ком проверка.");
      await reload();
      return;
    }
    if (res.status === 0) {
      setNotice("Не удалось связаться с сервисом. Попробуйте ещё раз.");
      return;
    }
    refuse(res);
  }, [publicId, reload, refuse]);

  const decide = useCallback(
    async (card: PersonaCardJson | null) => {
      if (busy) return;
      const decision = card ? "PERSONA_SELECTED" : "APPROVED_WITHOUT_PERSONA";
      setBusy(card?.cardId ?? "none");
      setNotice(null);
      track("persona_decided", { decision });
      const res = await siteApi.decide(publicId, card ? { decision, selectedCardId: card.cardId } : { decision });
      // Другое решение уже записано (второй браузер, двойной клик) — идём по записанному.
      if (!res.ok && !(res.status === 409 && res.reason === "PERSONA_DECISION_ALREADY_RECORDED")) {
        setBusy(null);
        if (res.status === 0) {
          setNotice("Не удалось связаться с сервисом. Попробуйте ещё раз.");
          return;
        }
        if (res.status === 400 || res.status === 409) {
          setNotice("Не удалось записать выбор. Обновите страницу.");
          await reload();
          return;
        }
        refuse(res);
        return;
      }
      await startRun();
      setBusy(null);
    },
    [busy, publicId, reload, refuse, startRun]
  );

  const start = useCallback(async () => {
    setBusy("start");
    setNotice(null);
    await startRun();
    setBusy(null);
  }, [startRun]);

  const screen: WizardScreen = wizardScreen({ status, refusal, panel, view });
  const step = wizardStep(screen);
  const isResult = screen.startsWith("result-");
  // Появление результата — один раз за визит: вернувшийся с заявки видит его сразу.
  const reveal = isResult && !seen.current.has(`reveal:${screen}`);

  useEffect(() => {
    if ((screen === "persona" || screen === "persona-empty") && !seen.current.has("persona_shown")) {
      seen.current.add("persona_shown");
      track("persona_shown", { cards: panel?.cards.length ?? 0 });
    }
    if (isResult && !seen.current.has(`reveal:${screen}`)) {
      seen.current.add(`reveal:${screen}`);
      track("verdict_shown", { verdict: status?.result?.verdict ?? "INSUFFICIENT_DATA" });
    }
  }, [screen, isResult, panel, status]);

  // Смена экрана: заголовок получает фокус, чтобы скринридер прочёл новый экран.
  const lastScreen = useRef<WizardScreen | null>(null);
  useEffect(() => {
    if (lastScreen.current === screen) return;
    const first = lastScreen.current === null;
    lastScreen.current = screen;
    if (screen === "loading") return;
    if (!first) window.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [screen]);

  const onServiceAction = (action: "lead" | "retry") => {
    if (action === "lead") setView("lead");
    else {
      setRefusal(null);
      void reload();
    }
  };

  function body() {
    switch (screen) {
      case "loading":
        return (
          <section className="site-screen is-active" aria-busy="true">
            <p className="site-visually-hidden" role="status">
              Загружаем проверку
            </p>
          </section>
        );
      case "persona-loading":
        return <PersonaLoadingScreen fullName={status?.subject?.fullName ?? ""} headingRef={heading} />;
      case "persona":
        return (
          <PersonaScreen
            panel={panel!}
            fullName={status?.subject?.fullName ?? ""}
            busy={busy}
            onPick={(card) => void decide(card)}
            onNone={() => void decide(null)}
            headingRef={heading}
          />
        );
      case "persona-empty":
        return (
          <PersonaEmptyScreen
            panel={panel!}
            fullName={status?.subject?.fullName ?? ""}
            busy={busy}
            onNone={() => void decide(null)}
            headingRef={heading}
          />
        );
      case "start":
        return <StartScreen panel={panel} busy={busy !== null} onStart={() => void start()} headingRef={heading} />;
      case "waiting":
        return <WaitingScreen run={status?.run ?? NO_RUN} publicId={publicId} headingRef={heading} />;
      case "result-negative":
      case "result-clean":
      case "result-insufficient":
        return <ResultScreen status={status!} reveal={reveal} onLead={() => setView("lead")} headingRef={heading} />;
      case "lead":
        return (
          <LeadScreen
            publicId={publicId}
            status={status!}
            onSent={() => {
              track("lead_sent");
              setView("thanks");
              void reload();
            }}
            onStale={() => {
              setView(null);
              void reload();
            }}
            onRefusal={refuse}
            onBack={() => setView(null)}
            headingRef={heading}
          />
        );
      case "thanks":
        return <ThanksScreen status={status!} onBack={() => setView(null)} headingRef={heading} />;
      case "failed":
        return <ServiceScreen content={SERVICE_SCREENS.failed} onAction={onServiceAction} headingRef={heading} />;
      case "blocked":
        return (
          <ServiceScreen
            content={{ ...SERVICE_SCREENS.blocked, lead: status?.blocked?.message ?? SERVICE_SCREENS.blocked.lead }}
            headingRef={heading}
          />
        );
      case "disabled":
        return <ServiceScreen content={SERVICE_SCREENS.disabled} headingRef={heading} />;
      case "limit":
        return <ServiceScreen content={SERVICE_SCREENS.limit} headingRef={heading} />;
      case "expired":
        return <ServiceScreen content={SERVICE_SCREENS.expired} headingRef={heading} />;
      case "no-cookie":
        return <ServiceScreen content={SERVICE_SCREENS.noCookie} headingRef={heading} />;
      case "not-found":
        return <ServiceScreen content={SERVICE_SCREENS.notFound} headingRef={heading} />;
      case "offline":
        return <ServiceScreen content={SERVICE_SCREENS.offline} onAction={onServiceAction} headingRef={heading} />;
    }
  }

  const editable = screen === "persona" || screen === "persona-empty" || screen === "persona-loading";

  return (
    <WizardFrame band={<WizardBand subject={status?.subject ?? null} step={step} editable={editable} />}>
      {notice ? (
        <div className="site-form-summary" role="alert">
          {notice}
        </div>
      ) : null}
      <div key={screen}>{body()}</div>
    </WizardFrame>
  );
}
