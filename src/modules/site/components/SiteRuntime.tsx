"use client";

/**
 * То, что сайт делает в браузере на каждой странице: подключает счётчик Метрики,
 * если он задан, и взводит появление блоков после каждого перехода.
 */

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { loadMetrika, metrikaHit } from "@/modules/site/analytics";
import { siteApi } from "@/modules/site/api";
import { armMotion } from "./motion";

export function SiteRuntime() {
  const pathname = usePathname();
  const firstPath = useRef(true);

  useEffect(() => {
    let alive = true;
    void siteApi.config().then((res) => {
      if (alive && res.ok && res.data.metrikaId) loadMetrika(res.data.metrikaId);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    metrikaHit(window.location.href);
  }, [pathname]);

  useEffect(() => armMotion(), [pathname]);

  return null;
}
