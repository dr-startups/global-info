import { detectCaptchaSignals } from "./captcha-detect";
import { DEFAULT_SERP_CAPTURE_VIEWPORT, type PlaywrightCaptureInput, type PlaywrightCaptureResult } from "./types";

export type PlaywrightCaptureFn = (input: PlaywrightCaptureInput) => Promise<PlaywrightCaptureResult>;

/**
 * Default Playwright capture — headless Chromium, above-the-fold clip.
 * Injectable for unit tests (no network).
 */
export async function captureSerpWithPlaywright(
  input: PlaywrightCaptureInput
): Promise<PlaywrightCaptureResult> {
  const { chromium } = await import("playwright");
  const viewport = input.viewport ?? DEFAULT_SERP_CAPTURE_VIEWPORT;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport,
      proxy: input.proxyServer ? { server: input.proxyServer } : undefined,
      locale: "ru-RU",
    });
    const page = await context.newPage();
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);

    const pageTitle = await page.title();
    const finalUrl = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const html = await page.content();
    const captcha = detectCaptchaSignals({ pageTitle, pageUrl: finalUrl, bodyText, html });

    const png = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 860) },
    });

    await context.close();

    return {
      png: Buffer.from(png),
      finalUrl,
      pageTitle,
      captchaDetected: captcha.detected,
      diagnostics: {
        captchaReasons: captcha.reasons,
        viewport,
        proxyUsed: Boolean(input.proxyServer),
      },
    };
  } finally {
    await browser.close();
  }
}
