# Global Info

Отчёт о цифровом профиле физического лица (due diligence): сбор открытых
источников, сверка принадлежности материалов проверяемому лицу, темы риска и
готовая презентация в PPTX и PDF.

Next.js + TypeScript + Prisma + PostgreSQL, рендерер на Python.

## Быстрый старт

```bash
cp .env.example .env        # заполнить секреты
docker compose up -d --build
docker compose logs -f app
```

Приложение — http://localhost:3000/admin/digital-profile

## Проверки

```bash
npm run ci        # типы + тесты + офлайн-смоки
npm run build     # сборка приложения
```

## Дальше

Всё остальное — в **[docs/ENGINEERING.md](docs/ENGINEERING.md)**: архитектура,
деплой на Railway, переменные окружения по контейнерам, CI, база данных и
решения, которые стоит помнить.
