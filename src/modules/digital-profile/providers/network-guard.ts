/**
 * Сторож сети провайдеров: считает вызовы и запрещает их там, где нельзя.
 *
 * Вопрос «можно ли сейчас в сеть» один на всех провайдеров, поэтому и ответ
 * один. Пока счётчик жил у Arsenkin, второй провайдер задач (Topvisor) завёл бы
 * второй такой же — и офлайн-контур проверялся бы наполовину.
 *
 * `ARSENKIN_RERENDER_ONLY=1` — прежнее имя рычага, оставлено: им пользуются
 * рабочие прогоны и документация. Смысл сторожа при переносе не расширялся:
 * `NETWORK_CALLS=0` он не проверяет, потому что офлайн-тесты подменяют
 * транспорт и законно доходят до клиента — запрет здесь ронял бы их, а
 * настоящий поход в сеть закрыт подменой.
 */

let networkCalls = 0;

export function resetProviderNetworkCallCount(): void {
  networkCalls = 0;
}

export function getProviderNetworkCallCount(): number {
  return networkCalls;
}

export function isRerenderOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARSENKIN_RERENDER_ONLY === "1";
}

/**
 * Отметить исходящий вызов провайдера; бросает, если сеть запрещена.
 *
 * Имя вида («arsenkin:suggest», «topvisor:positions») попадает в текст отказа —
 * по нему видно, кто пытался пойти в сеть там, где нельзя.
 */
export function noteProviderNetworkCall(kind: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isRerenderOnly(env)) {
    throw new Error(`ARSENKIN_RERENDER_ONLY forbids network call: ${kind}`);
  }
  networkCalls += 1;
}
