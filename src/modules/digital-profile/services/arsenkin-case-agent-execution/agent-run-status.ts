/**
 * Запись статуса запуска агента (шаг 13, B6).
 *
 * Статус запуска пишется из пяти мест: «начал собирать», «задача N из M»,
 * «замещён повторным нажатием», «упал», «закончил». Все пять вызывали
 * `prisma.agentRun.update({ where: { id } })`, а он бросает `P2025`, когда
 * записи нет. Записи может не быть законно: кейс удалён, прошлый запуск уже
 * подчищен, замещается запуск, которого в базе не осталось. В журнале это
 * выглядело как десятки трасс Prisma вокруг сообщений вида
 * «supersede old AgentRun failed» — оператор видит поток ошибок там, где не
 * произошло ничего плохого.
 *
 * `updateMany` ноль строк переносит спокойно и возвращает их число, поэтому
 * «записи не было» становится ответом, а не исключением. Вызывающий код сам
 * решает, важно ли ему это: для прогресса — нет, для итога прогона — да.
 */

import type { Prisma } from "@prisma/client";

/**
 * Минимальный контракт хранилища: только то, что здесь используется.
 * Настоящий `PrismaClient` ему удовлетворяет, а тест обходится подделкой.
 */
export type AgentRunStatusStore = {
  agentRun: {
    updateMany(args: {
      where: { id: string };
      data: Prisma.AgentRunUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
};

/**
 * Пишет статус запуска агента.
 *
 * @returns `true`, если запись нашлась и обновлена; `false`, если её нет.
 *          Отсутствие записи ошибкой не является — обновлять нечего.
 *          Настоящий сбой БД по-прежнему выбрасывается наружу.
 */
export async function writeAgentRunStatus(input: {
  prisma: AgentRunStatusStore;
  agentRunId: string;
  data: Prisma.AgentRunUpdateManyMutationInput;
}): Promise<boolean> {
  if (!input.agentRunId) return false;
  const { count } = await input.prisma.agentRun.updateMany({
    where: { id: input.agentRunId },
    data: input.data,
  });
  return count > 0;
}
