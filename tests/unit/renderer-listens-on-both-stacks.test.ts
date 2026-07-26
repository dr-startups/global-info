import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Рендерер обязан отвечать по обоим протоколам.
 *
 * Railway показывал Healthcheck failure при исправном сервисе. Замер в
 * собранном образе: слушатель есть в `/proc/net/tcp6` и отсутствует в
 * `/proc/net/tcp`, а `curl http://127.0.0.1:8080/health` изнутри контейнера
 * отвечает «соединение отвергнуто».
 *
 * Причина — строка запуска `uvicorn app:app --host ::`. Значение `::` выбрали
 * ради приватной сети Railway, которая работает по IPv6, но uvicorn отдаёт
 * адрес в `asyncio.create_server`, а тот выставляет сокету `IPV6_V6ONLY`.
 * Слушатель выходил только IPv6, и проверка работоспособности самого образа —
 * она ходит на `localhost`, то есть на IPv4-петлю, — не проходила никогда.
 *
 * Проверяется свойство запуска, а не текст комментария: сокет создаётся
 * заранее и с выключенным `IPV6_V6ONLY`.
 */

const ROOT = process.cwd();
const dockerfile = readFileSync(join(ROOT, "renderer/Dockerfile"), "utf8");
const serve = readFileSync(join(ROOT, "renderer/serve.py"), "utf8");

describe("рендерер слушает оба протокола", () => {
  it("контейнер не поднимает uvicorn с одиночным --host", () => {
    // Проверяется строка запуска, а не весь файл: в комментариях прежняя форма
    // упомянута намеренно, чтобы причина дефекта осталась рядом с правкой.
    const cmd = dockerfile.match(/^(?:CMD|ENTRYPOINT)\s+.*$/mu)?.[0] ?? "";
    expect(cmd).toBe('CMD ["python", "serve.py"]');
    expect(cmd).not.toMatch(/--host/u);
  });

  it("сокет создаётся с выключенным IPV6_V6ONLY", () => {
    expect(serve).toMatch(/IPV6_V6ONLY/u);
    expect(serve).toMatch(/setsockopt\(socket\.IPPROTO_IPV6, socket\.IPV6_V6ONLY, 0\)/u);
    // Сокет передаётся серверу готовым — иначе адрес снова разберёт asyncio.
    expect(serve).toMatch(/run\(sockets=\[sock\]\)/u);
  });

  it("недоступность двойного стека не мешает подняться", () => {
    // Работать по одному протоколу лучше, чем не стартовать вовсе.
    expect(serve).toMatch(/except OSError/u);
    expect(serve).toMatch(/AF_INET\b/u);
  });

  it("проверка работоспособности обращается по явному адресу", () => {
    // `localhost` может разрешиться в ::1 — тогда исход зависит от того, какая
    // петля отвечает.
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*127\.0\.0\.1/u);
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]*http:\/\/localhost/u);
  });

  it("локальный контур не переопределяет привязку", () => {
    // Расхождение между локальным контуром и продом — источник дефектов,
    // видных только на одном из них.
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toMatch(/^\s*RENDERER_HOST:/mu);
  });
});
