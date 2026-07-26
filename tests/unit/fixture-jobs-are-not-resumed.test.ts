import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Фикстурные кейсы не возобновляются.
 *
 * Поймано на живом стенде при проверке переноса возобновления в воркер. Смоки
 * оставляют после себя джобы в `ARSENKIN_ENRICHMENT/WAITING` — это их нормальный
 * след. Подборка после деплоя принимала их за работу, которую надо доделать, и
 * на стенде с настоящими ключами воркер молча отправлял **платные** задачи
 * Arsenkin по данным смока: две задачи за пять минут, `arsenkin_set_ok` в логе.
 *
 * Признак `isFixture` в базе уже был — на него просто никто не смотрел в этом
 * месте. Дефект не новый: до переноса ту же подборку каждые пять секунд делал
 * веб-процесс, и там это было так же незаметно.
 */

const source = readFileSync(
  join(process.cwd(), "src/modules/digital-profile/services/unified-collection-job-store.ts"),
  "utf8"
);

const between = (from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `не найдено: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("подборка после деплоя не трогает фикстуры", () => {
  it("запрос в БД отсекает фикстурные кейсы", () => {
    const fn = between("async function dbListResumable", "async function dbDelete");
    expect(fn).toMatch(/case:\s*\{\s*isFixture:\s*false\s*\}/u);
    // Отбор по-прежнему ограничен активными стадиями и живыми статусами.
    expect(fn).toMatch(/status:\s*\{\s*in:\s*\["WAITING",\s*"RUNNING"\]\s*\}/u);
  });

  it("файловый режим отсекает их тоже", () => {
    // Джоба лежит в файле, а признак кейса — в базе: пропустить одно из двух
    // означало бы починить половину.
    const fn = between("async function fileListResumable", "async function fileDelete");
    expect(fn).toMatch(/fixtures\.has\(caseId\)/u);
  });

  it("правило одно на оба пути возобновления", () => {
    // Путей два: unified-джобы и исполнения CaseAgent. Починить один — починить
    // половину, поэтому правило вынесено в общий модуль.
    const shared = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/workflow/fixture-cases.ts"),
      "utf8"
    );
    expect(shared).toMatch(/isFixture:\s*true/u);
    // При недоступности базы — пустое множество: список работы тоже строится из
    // базы, значит возобновлять всё равно нечего.
    expect(shared).toMatch(/catch\s*\{\s*return new Set\(\);/u);

    const agents = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/arsenkin-case-agent-execution/submit.ts"
      ),
      "utf8"
    );
    expect(agents).toMatch(/fixtures\.has\(job\.caseId\)/u);
    expect(agents).toMatch(/workflow\/fixture-cases/u);
  });
});
