/**
 * Client copy completeness QA (spec §12).
 */

import assert from "node:assert/strict";
import {
  inspectClientCopySlides,
  inspectClientCopyText,
} from "../src/modules/digital-profile/orion-golden/classic/client-copy-completeness";

function main() {
  let pass = 0;
  const run = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`PASS ${name}`);
      pass += 1;
    } catch (e) {
      console.error(`FAIL ${name}`, e);
      process.exitCode = 1;
    }
  };

  run("blocks ru_related_*", () => {
    const issues = inspectClientCopyText("Набор ru_related_1 для визуализации");
    assert.ok(issues.some((i) => i.code === "CLIENT_COPY_INCOMPLETE"));
  });

  run("blocks «без копирования соседних слайдов»", () => {
    const issues = inspectClientCopyText("Анализ без копирования соседних слайдов");
    assert.ok(issues.length > 0);
  });

  run("blocks «сверить сверка личности»", () => {
    const issues = inspectClientCopyText("Требуется сверить сверка личности");
    assert.ok(issues.length > 0);
  });

  run("blocks dangling «по С.»", () => {
    const issues = inspectClientCopyText("Оценка профиля по С.");
    assert.ok(issues.length > 0);
  });

  run("allows NOT_COLLECTED label with 0/0 context", () => {
    const issues = inspectClientCopyText("Данные не собраны для этой поверхности");
    assert.equal(issues.filter((i) => /0\/0/.test(i.detail)).length, 0);
  });

  run("slide sweep catches internal labels", () => {
    const issues = inspectClientCopySlides([
      {
        pageNumber: 20,
        slotId: "p20_ru_related_1",
        narrative: "ru_related_2 показан на слайде",
      },
    ]);
    assert.ok(issues.length > 0);
  });

  console.log(`client-copy-completeness ${pass}/6`);
}

main();
