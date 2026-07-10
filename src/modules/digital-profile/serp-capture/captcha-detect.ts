/**
 * CAPTCHA heuristics — detect only, never bypass.
 */
export function detectCaptchaSignals(input: {
  pageTitle: string;
  pageUrl: string;
  bodyText: string;
  html: string;
}): { detected: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const blob = `${input.pageTitle}\n${input.pageUrl}\n${input.bodyText}\n${input.html}`.toLowerCase();

  if (/captcha|recaptcha|hcaptcha|unusual traffic|подтвердите, что вы не робот|не робот|smartcaptcha/i.test(blob)) {
    reasons.push("captcha-text");
  }
  if (/google\.com\/sorry|yandex\.[a-z]+\/showcaptcha|challenge/i.test(blob)) {
    reasons.push("challenge-url");
  }
  if (/<iframe[^>]+recaptcha/i.test(input.html)) {
    reasons.push("recaptcha-frame");
  }

  return { detected: reasons.length > 0, reasons };
}
