/**
 * Прежние имена сторожа сети Arsenkin.
 *
 * Сам сторож теперь общий (`providers/network-guard.ts`): вопрос «можно ли в
 * сеть» один на всех провайдеров. Здесь остались только имена, которыми его
 * зовут существующие вызовы и тесты, — переименовывать их отдельным движением
 * значило бы смешать перенос с правкой.
 */

export {
  getProviderNetworkCallCount as getArsenkinNetworkCallCount,
  isRerenderOnly as isArsenkinRerenderOnly,
  noteProviderNetworkCall as noteArsenkinNetworkCall,
  resetProviderNetworkCallCount as resetArsenkinNetworkCallCount,
} from "../network-guard";
