/**
 * Купленный разбор статьи переживает пересборку.
 *
 * Разбор — вызов модели по тексту статьи, и восстановить его неоткуда: базы у
 * него нет, как и у вердиктов. Значит, пересборка отчёта его переиспользует, и
 * ровно поэтому переиспользование узкое — чужой кейс, чужая схема и
 * неразобранный файл покупкой не считаются. Зеркало правил `link-verdicts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReusableWikipediaArticleReview } from "@/modules/digital-profile/orion-golden/analytics/run-wikipedia-article-review";
import { WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/contracts/wikipedia-article-review";

const CASE = "case-golden-holmstrom";
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function review(over: Record<string, unknown> = {}) {
  return {
    checkRef: "inventory:wiki-1",
    language: "ru",
    title: "Anders Holmström",
    url: "https://ru.wikipedia.org/wiki/Anders_Holmstrom",
    lead: "Андерс Хольмстрём — шведский предприниматель.",
    sections: ["Биография"],
    articleTextChars: 420,
    reviewedChars: 420,
    truncated: false,
    subjectMatch: "subject",
    fragments: [
      {
        quote: "В 2019 году в отношении компании начата налоговая проверка.",
        category: "negative",
        gloss: "налоговая проверка 2019 года",
        section: "Биография",
      },
    ],
    audit: { dropped: 0, reasons: [] },
    status: "REVIEWED",
    ...over,
  };
}

function artifact(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION,
    caseId: CASE,
    datasetId: "composite-previous",
    reviews: [review()],
    ...over,
  };
}

function dirWith(body: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-review-reuse-"));
  dirs.push(dir);
  if (body !== null) {
    writeFileSync(
      join(dir, "wikipedia-article-review.json"),
      typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`,
      "utf8"
    );
  }
  return dir;
}

describe("переиспользование купленного разбора статьи", () => {
  it("артефакт своего кейса переиспользуется целиком", () => {
    const reuse = loadReusableWikipediaArticleReview(dirWith(artifact()), { caseId: CASE });
    expect(reuse.status).toBe("reuse");
    if (reuse.status !== "reuse") return;
    expect(reuse.result.reviews[0]!.fragments[0]!.gloss).toBe("налоговая проверка 2019 года");
    expect(reuse.previousDatasetId).toBe("composite-previous");
  });

  it("артефакта нет — переиспользовать нечего и терять нечего", () => {
    expect(loadReusableWikipediaArticleReview(dirWith(null), { caseId: CASE }).status).toBe("none");
  });

  it("пустой артефакт покупкой не был", () => {
    const reuse = loadReusableWikipediaArticleReview(dirWith(artifact({ reviews: [] })), {
      caseId: CASE,
    });
    expect(reuse.status).toBe("none");
  });

  it("чужой кейс — потеря с названной причиной, а не тихая подмена", () => {
    const reuse = loadReusableWikipediaArticleReview(dirWith(artifact()), { caseId: "case-other" });
    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("foreign-case");
    expect(reuse.previousReviewCount).toBe(1);
  });

  it("чужая схема — потеря, а не пустота", () => {
    const reuse = loadReusableWikipediaArticleReview(
      dirWith(artifact({ schemaVersion: "wikipedia-article-review-v0" })),
      { caseId: CASE }
    );
    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("schema-mismatch");
  });

  it("нечитаемый файл — потеря без выдуманного числа", () => {
    const reuse = loadReusableWikipediaArticleReview(dirWith("{не json"), { caseId: CASE });
    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("unreadable");
    expect(reuse.previousReviewCount).toBe(0);
  });

  it("запись, не прошедшая схему, реюзом не считается", () => {
    const broken = artifact({ reviews: [review({ status: "ДА" })] });
    const reuse = loadReusableWikipediaArticleReview(dirWith(broken), { caseId: CASE });
    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("invalid");
  });
});

describe("неудавшийся разбор не замораживается как купленный", () => {
  it("артефакт из одних NOT_REVIEWED покупкой не является", () => {
    // У вердиктов неудача даёт пустой массив и решается заново. У разбора
    // неудача даёт непустой массив честных «не разобрано» — и без этого условия
    // один транзиентный отказ модели навсегда фиксировал бы его в отчёте.
    const artifact_ = artifact({
      reviews: [review({ status: "NOT_REVIEWED", notReviewedReason: "offline", fragments: [] })],
    });
    expect(loadReusableWikipediaArticleReview(dirWith(artifact_), { caseId: CASE }).status).toBe(
      "none"
    );
  });

  it("смешанный артефакт покупкой является: разобранное куплено", () => {
    const artifact_ = artifact({
      reviews: [
        review({ status: "NOT_REVIEWED", notReviewedReason: "offline", fragments: [] }),
        review({ checkRef: "inventory:wiki-2" }),
      ],
    });
    const reuse = loadReusableWikipediaArticleReview(dirWith(artifact_), { caseId: CASE });
    expect(reuse.status).toBe("reuse");
  });
});
