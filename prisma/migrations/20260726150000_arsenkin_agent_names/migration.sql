-- Агенты Arsenkin получают собственные значения AgentName (шаг 15, E10).
--
-- Unified-путь передавал идентификатор `unified-<job>-<ARSENKIN_*_REAL>`, но
-- строку AgentRun создать не мог: таких значений в перечислении не было.
-- В журнале это выглядело как «AgentRun … отсутствует — итог прогона записать
-- некуда», а во вкладке «Агенты» итоги пяти платных агентов не появлялись
-- вовсе.
--
-- Свести их к SEARCH_SURFACES было нельзя: каждый агент — отдельная платная
-- отправка со своим исходом, и различать их — смысл этой вкладки.

ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'ARSENKIN_SEARCH_TOP_REAL';
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'ARSENKIN_SUGGESTIONS_REAL';
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'ARSENKIN_PAA_REAL';
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'ARSENKIN_AI_SEARCH_REAL';
ALTER TYPE "AgentName" ADD VALUE IF NOT EXISTS 'ARSENKIN_URL_AUDIT_REAL';
