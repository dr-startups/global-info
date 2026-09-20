"use client";

/**
 * Прошедшее время — текст раз в секунду, без анимации: это показание, а не
 * украшение. Один хук на панель поиска и на экран ожидания, чтобы «0:07» в двух
 * местах считалось одинаково.
 */

import { useEffect, useState } from "react";
import { formatElapsed } from "@/modules/site/check/waiting-view";

export function useElapsed(startedAtMs: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return formatElapsed(startedAtMs === null ? 0 : now - startedAtMs);
}
