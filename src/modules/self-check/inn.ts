/**
 * Контрольные разряды ИНН (алгоритм ФНС).
 *
 * Поле ИНН на форме сайта необязательно, но введённый номер попадает в профиль
 * субъекта как его признак. Без контрольной суммы номером считалось бы любое
 * число нужной длины — например, хвост дроби «11398.600000000002».
 *
 * Модуль без зависимостей: номер проверяет и сервер, и форма в браузере.
 */

const COEFFICIENTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const COEFFICIENTS_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const COEFFICIENTS_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: readonly number[], coefficients: readonly number[]): number {
  const sum = coefficients.reduce((acc, c, i) => acc + c * digits[i], 0);
  return (sum % 11) % 10;
}

/** ИНН юрлица (10 цифр) или физлица и ИП (12 цифр) с верными контрольными разрядами. */
export function isValidInn(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!/^(\d{10}|\d{12})$/.test(v)) return false;
  const digits = [...v].map(Number);
  if (digits.length === 10) {
    return checkDigit(digits, COEFFICIENTS_10) === digits[9];
  }
  return (
    checkDigit(digits, COEFFICIENTS_11) === digits[10] &&
    checkDigit(digits, COEFFICIENTS_12) === digits[11]
  );
}
