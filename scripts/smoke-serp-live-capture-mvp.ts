/**
 * Offline smoke tests for Stage S2 LIVE SERP capture MVP.
 * No network, no Playwright, no DB.
 *
 * Run: npm run smoke:serp-live-capture-mvp
 */

import {
  assertAllowlistedSerpUrl,
  buildAllowlistedSerpUrl,
  hashSerpQuery,
  SerpUrlBuilderError,
} from "../src/modules/digital-profile/serp-capture/url-builder";
import { detectCaptchaSignals } from "../src/modules/digital-profile/serp-capture/captcha-detect";
import {
  evaluateClientSerpPolicy,
  resolveLiveCaptureOutcome,
  buildDefaultLiveSerpSlots,
} from "../src/modules/digital-profile/orion-golden/classic/orion-classic-live-serp-assets";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-golden/assets/asset-builder";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function main() {
  console.log("Smoke: LIVE SERP capture MVP (offline)\n");

  // URL allowlist
  const ruY = buildAllowlistedSerpUrl({ query: "Глинка Сергей", engine: "YANDEX", region: "RU" });
  check("RU Yandex URL", ruY.url.includes("yandex.ru/search") && ruY.url.includes("text="));

  const uaeG = buildAllowlistedSerpUrl({ query: "Glinka Sergey", engine: "GOOGLE", region: "UAE" });
  check("UAE Google URL", uaeG.url.includes("google.ae/search") && uaeG.url.includes("gl=ae"));

  let uaeYandexRejected = false;
  try {
    buildAllowlistedSerpUrl({ query: "test", engine: "YANDEX", region: "UAE" });
  } catch (e) {
    uaeYandexRejected = e instanceof SerpUrlBuilderError;
  }
  check("UAE+YANDEX rejected", uaeYandexRejected);

  let arbitraryRejected = false;
  try {
    assertAllowlistedSerpUrl("https://evil.example/search?q=1");
  } catch (e) {
    arbitraryRejected = e instanceof SerpUrlBuilderError;
  }
  check("arbitrary URL rejected", arbitraryRejected);

  // query hash stability
  const h1 = hashSerpQuery("  Глинка   Сергей  ");
  const h2 = hashSerpQuery("глинка сергей");
  check("query hash normalized", h1 === h2, h1.slice(0, 12));

  // subject FIO always in report slots
  const slots = buildDefaultLiveSerpSlots({
    subjectName: "Глинка Сергей Михайлович",
    ruQueries: ["Глинка Сергей санкции"],
    uaeQueries: ["Glinka sanctions"],
  });
  check(
    "slots include subject FIO for RU Yandex",
    slots.some(
      (s) => s.query === "Глинка Сергей Михайлович" && s.engine === "YANDEX" && s.region === "RU"
    )
  );
  check(
    "slots include subject FIO for UAE Google",
    slots.some(
      (s) => s.query === "Глинка Сергей Михайлович" && s.engine === "GOOGLE" && s.region === "UAE"
    )
  );

  // CAPTCHA detect
  const cap = detectCaptchaSignals({
    pageTitle: "Sorry",
    pageUrl: "https://www.google.com/sorry/index",
    bodyText: "unusual traffic",
    html: "<div>recaptcha</div>",
  });
  check("CAPTCHA detected", cap.detected, cap.reasons.join(","));

  // status mapping
  const directOk = resolveLiveCaptureOutcome({ captchaDetected: false, proxyUsed: false, pngOk: true });
  check(
    "direct success READY+UNVERIFIED",
    directOk.captureStatus === "READY" &&
      directOk.geoStatus === "UNVERIFIED" &&
      directOk.connectionMode === "DIRECT"
  );

  const proxyOk = resolveLiveCaptureOutcome({ captchaDetected: false, proxyUsed: true, pngOk: true });
  check(
    "proxy success READY+VERIFIED",
    proxyOk.captureStatus === "READY" &&
      proxyOk.geoStatus === "VERIFIED" &&
      proxyOk.connectionMode === "PROXY"
  );

  const blocked = resolveLiveCaptureOutcome({ captchaDetected: true, proxyUsed: false, pngOk: false });
  check("CAPTCHA BLOCKED_CAPTCHA", blocked.captureStatus === "BLOCKED_CAPTCHA");

  // client policy — provider API synthetic OK; legacy-only synthetic blocked
  const legacyOnly: ReportAssetV1[] = [
    { assetRef: "syn", kind: "synthetic_serp", title: "syn", evidenceRefs: [], status: "ready", imageData: "x" },
  ];
  const clientPolicy = evaluateClientSerpPolicy(legacyOnly, true);
  check(
    "client blocks legacy-only synthetic",
    !clientPolicy.passed && clientPolicy.blockers.includes("legacy-synthetic-serp-not-allowed-for-client")
  );

  const providerAssets: ReportAssetV1[] = [
    {
      assetRef: "ru_provider_serp_google_1",
      kind: "synthetic_serp",
      title: "Google — test",
      caption: "Синтетический снимок на основе сохранённых результатов API",
      evidenceRefs: ["serp_observation:obs1"],
      status: "ready",
      imageData: "x",
    },
    {
      assetRef: "uae_provider_serp_google_2",
      kind: "synthetic_serp",
      title: "Google — test uae",
      caption: "Синтетический снимок на основе сохранённых результатов API",
      evidenceRefs: ["serp_observation:obs2"],
      status: "ready",
      imageData: "x",
    },
  ];
  const providerPolicy = evaluateClientSerpPolicy(providerAssets, true);
  check("client allows provider API synthetic", providerPolicy.passed, providerPolicy.blockers.join(","));

  const liveUnverified: ReportAssetV1[] = [
    {
      assetRef: "live",
      kind: "live_serp",
      title: "live",
      evidenceRefs: [],
      status: "ready",
      geoStatus: "UNVERIFIED",
      imageData: "x",
    },
  ];
  const geoPolicy = evaluateClientSerpPolicy(liveUnverified, true);
  check(
    "client blocks UNVERIFIED LIVE without provider cover",
    !geoPolicy.passed && geoPolicy.blockers.includes("live-serp-geo-unverified")
  );

  const liveVerified: ReportAssetV1[] = [
    {
      assetRef: "ru_live_serp",
      kind: "live_serp",
      title: "live ru",
      evidenceRefs: [],
      status: "ready",
      geoStatus: "VERIFIED",
      imageData: "x",
    },
    {
      assetRef: "uae_live_serp",
      kind: "live_serp",
      title: "live uae",
      evidenceRefs: [],
      status: "ready",
      geoStatus: "VERIFIED",
      imageData: "x",
    },
  ];
  const okPolicy = evaluateClientSerpPolicy(liveVerified, true);
  check("client passes verified LIVE both regions", okPolicy.passed, okPolicy.blockers.join(","));

  const internalPolicy = evaluateClientSerpPolicy(legacyOnly, false);
  check("internal preview allows synthetic", internalPolicy.passed);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
