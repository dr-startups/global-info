"""Типографика строки блока: роль строки и её оформление.

Единственный ответ на два вопроса — «что это за строка» и «как её печатать».
Им пользуются и замер, и вывод: пока у них были разные ответы, заголовок темы
мерился обычным начертанием, рисовался жирным и выезжал за блок.

Почему роли, а не разметка в тексте. Строку блока читают два десятка
потребителей — бюджеты знаков, вычистка повторов, ворот следа, сторож внутренних
кодов, эталон клиентского текста, стадия 2. Любой, кто разметку не знает,
довезёт звёздочки до бумаги (так уже было с ответом поискового ИИ). Перенос
строки для всех них объявлен решением вёрстки, поэтому структура блока — это
его строки, а оформление — свойство роли строки.

Модуль чистый: `python-pptx` ему не нужен. Тон и кегль он называет словами, в
RGB и пункты их переводит тот, кто рисует.

Словарь форм — ярлыки меты и действия, пределы ярлыка — объявлен в общем
контракте клиентского текста (`client_text_contract.json`, раздел `typography`),
который делят приложение и рендерер. Второго списка ярлыков в коде нет.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

try:
    from client_text_contract import load_bundled_contract
except ImportError:  # pragma: no cover — package-style import inside container
    from renderer.client_text_contract import load_bundled_contract  # type: ignore

ROLE_HEADING = "heading"
ROLE_TEXT = "text"
ROLE_QUOTE = "quote"
ROLE_META = "meta"
ROLE_ACTION = "action"
ROLE_ADDRESS = "address"

TONE_INK = "ink"
TONE_MUTED = "muted"
TONE_HEADING = "heading"
TONE_ACTION = "action"

SIZE_BODY = "body"
SIZE_CAPTION = "caption"

#: Отбивки блока списка в пунктах. Читают двое — замер и вывод; разойдутся они,
#: и высота блока перестанет совпадать с нарисованной.
BLOCK_GAP_PT = 6
LINE_GAP_PT = 3

#: Насколько цитата стоит глубже остальных строк блока, EMU.
QUOTE_EXTRA_INDENT = 170_000

#: Длиннее — уже предложение, а не заголовок блока.
HEADING_MAX_CHARS = 160
#: Прежнее правило: строка-ввод с двоеточием жирная, только пока она коротка.
LEAD_IN_HEADING_MAX_CHARS = 80

_SENTENCE_END = ".!?…"
#: Знаки, после которых строка — не заголовок: предложение кончилось либо не кончилось.
_NOT_A_HEADING_TAIL = _SENTENCE_END + ":;,"

_THEME_LINE_RE = re.compile(r"^«[^»]{2,80}»\s*$")
#: Цитата с атрибуцией: формат `sourceQuote` приложения, один на деку. После
#: «источник» не буква — `\b` здесь не годится только в JavaScript, в Python он
#: знает кириллицу, но явная форма читается однозначно.
_QUOTE_ATTRIBUTION_RE = re.compile(r"»\s*(—\s*источник(?![^\W\d_]).*)$", re.I | re.S)
_PURE_QUOTE_RE = re.compile(r"^«.*»[.!?…]?$", re.S)
#: Строка-адрес: домен с путём, обычно в скобках. В пути допустим пробел — адрес
#: источника может его содержать, — но только внутри скобок.
_ADDRESS_RE = re.compile(
    r"^(?:\((?:https?://)?[^\W_][\w-]*(?:\.[\w-]+)+(?:[/?#][^()]*)?\)\.?"
    r"|(?:https?://)?[^\W_][\w-]*(?:\.[\w-]+)+[/?#]\S*)$",
    re.I,
)
_LIST_NUMBER_RE = re.compile(r"^\d{1,2}\)(?=\s)")
#: Отдельное целое: не часть слова, адреса, даты, десятичной дроби или кода
#: через дефис («ТОП-20»). Длиннее шести знаков — идентификатор, а не количество.
_NUMBER_RE = re.compile(r"(?<![\w./:\-№#])(?<!\d,)\d{1,6}(?![\w/\-]|[.:,]\d)")
_YEAR_RE = re.compile(r"^(?:19|20)\d\d$")


@dataclass(frozen=True)
class Run:
    text: str
    bold: bool
    tone: str


@dataclass(frozen=True)
class LineLayout:
    role: str
    size: str
    runs: tuple[Run, ...]

    @property
    def measure_bold(self) -> bool:
        """Каким начертанием мерить строку.

        Строка со смешанным весом меряется жирной целиком: жирное шире, значит
        мера ошибается только в сторону «строка чуть длиннее» — туда, где потеря
        невозможна.
        """
        return any(run.bold for run in self.runs)

    @property
    def deep_indent(self) -> bool:
        return self.role == ROLE_QUOTE


@dataclass(frozen=True)
class _Rules:
    meta_colon: re.Pattern[str]
    meta_any: re.Pattern[str]
    count: re.Pattern[str] | None
    action: re.Pattern[str]
    verbatim_marker: str
    label_max_chars: int
    label_max_words: int


def _alternation(labels: list[str]) -> str:
    # Длинный ярлык раньше короткого: «Источники ответа» не должен узнаваться
    # как «Источники» с хвостом.
    ordered = sorted({str(x).strip() for x in labels if str(x).strip()}, key=len, reverse=True)
    return "|".join(re.escape(x).replace(r"\ ", r"\s+") for x in ordered)


@lru_cache(maxsize=8)
def _compile_rules(section_json: str) -> _Rules:
    section = json.loads(section_json)
    meta = _alternation(list(section.get("metaLabels") or []))
    dash = _alternation(list(section.get("metaDashLabels") or []))
    action = _alternation(list(section.get("actionLabels") or []))
    if not meta or not action:
        raise ValueError("client-text-contract: раздел typography без metaLabels/actionLabels")
    count = _alternation(list(section.get("countLabels") or []))
    meta_colon = re.compile(rf"^(?:{meta})\s*:", re.I)
    meta_any = re.compile(rf"^(?:(?:{meta})\s*:|(?:{dash})\s+—)" if dash else rf"^(?:{meta})\s*:", re.I)
    return _Rules(
        meta_colon=meta_colon,
        meta_any=meta_any,
        count=re.compile(rf"^(?:{count})\s*:", re.I) if count else None,
        action=re.compile(rf"^(?:{action})\s*:", re.I),
        verbatim_marker=str(section.get("verbatimLabelMarker") or "").strip().lower(),
        label_max_chars=int(section.get("labelMaxChars") or 48),
        label_max_words=int(section.get("labelMaxWords") or 6),
    )


def _rules(contract: dict[str, Any] | None) -> _Rules:
    """Правила из контракта пейлоада, а если раздела в нём нет — из своей копии.

    Приложение прошлой версии присылает контракт без раздела `typography`: в
    окне деплоя рендерер обязан нарисовать страницу, а не отказать.
    """
    section = (contract or {}).get("typography") if isinstance(contract, dict) else None
    if not isinstance(section, dict) or not section.get("metaLabels"):
        section = load_bundled_contract().get("typography") or {}
    return _compile_rules(json.dumps(section, ensure_ascii=False, sort_keys=True))


def meta_line_re(contract: dict[str, Any] | None = None) -> re.Pattern[str]:
    """Мета-строка в форме «Ярлык: …» — тем же списком, которым узнаётся роль."""
    return _rules(contract).meta_colon


def line_role(line: str, *, index: int, total: int, contract: dict[str, Any] | None = None) -> str:
    """Роль строки блока — по её форме.

    `index` и `total` — место строки в блоке: заголовком бывает только первая
    строка, и только у блока, в котором есть что озаглавить.
    """
    text = (line or "").strip()
    if not text:
        return ROLE_TEXT
    rules = _rules(contract)
    if _ADDRESS_RE.match(text):
        return ROLE_ADDRESS
    if rules.action.match(text):
        return ROLE_ACTION
    if rules.meta_any.match(text):
        return ROLE_META
    attributed = text.startswith("«") and _QUOTE_ATTRIBUTION_RE.search(text) is not None
    if index == 0 and not attributed:
        if _THEME_LINE_RE.match(text):
            return ROLE_HEADING
        if text.endswith(":") and len(text) <= LEAD_IN_HEADING_MAX_CHARS:
            return ROLE_HEADING
        if total > 1 and len(text) <= HEADING_MAX_CHARS and text[-1] not in _NOT_A_HEADING_TAIL:
            return ROLE_HEADING
    if attributed or (text.startswith("«") and _PURE_QUOTE_RE.match(text)):
        return ROLE_QUOTE
    return ROLE_TEXT


def _quoted_spans(text: str) -> list[tuple[int, int]]:
    """Участки внутри «ёлочек», включая вложенные: там чужие слова."""
    spans: list[tuple[int, int]] = []
    depth = 0
    start = 0
    for i, ch in enumerate(text):
        if ch == "«":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "»" and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append((start, i + 1))
    return spans


def _emphasize_numbers(text: str, tone: str, *, list_number: bool) -> list[Run]:
    """Числа — жирным; всё, что в кавычках, не трогается.

    Дословная цитата не редактируется даже весом шрифта: выделить в ней число
    значит расставить в чужих словах свои акценты.
    """
    quoted = _quoted_spans(text)
    marks: list[tuple[int, int]] = []
    if list_number:
        m = _LIST_NUMBER_RE.match(text)
        if m:
            marks.append((m.start(), m.end()))
    for m in _NUMBER_RE.finditer(text):
        if marks and m.start() < marks[0][1]:
            continue
        if _YEAR_RE.match(m.group(0)):
            continue
        if any(a <= m.start() < b for a, b in quoted):
            continue
        marks.append((m.start(), m.end()))
    runs: list[Run] = []
    pos = 0
    for a, b in marks:
        if a > pos:
            runs.append(Run(text[pos:a], False, tone))
        runs.append(Run(text[a:b], True, tone))
        pos = b
    if pos < len(text):
        runs.append(Run(text[pos:], False, tone))
    return runs or [Run(text, False, tone)]


#: Законченное предложение: конечный знак, после него допустима закрывающая
#: скобка или кавычка.
_FINISHED_SENTENCE_RE = re.compile(r"[.!?…][)»\"“]?$")


def _is_own_sentence(text: str) -> bool:
    """Наша ли это строка — законченное предложение.

    Всё, что пишем мы, кончается знаком (`finishSentence` у построителей).
    Строка без конечного знака — чужая: поисковая подсказка, связанный запрос,
    заголовок выдачи. В чужих словах рендерер акцентов не расставляет.
    """
    return _FINISHED_SENTENCE_RE.search(text.rstrip()) is not None


def _plain(text: str, tone: str) -> list[Run]:
    return [Run(text, False, tone)]


def _label_end(text: str, rules: _Rules) -> int:
    """Конец ярлыка «Итоговая оценка:» в начале строки или 0, если ярлыка нет.

    Ярлык — короткая именная группа до двоеточия. Пределы объявлены в контракте:
    без них жирным становилось бы придаточное до первого двоеточия в любом
    длинном предложении.
    """
    colon = text.find(": ")
    if colon <= 1 or colon > rules.label_max_chars:
        return 0
    head = text[:colon]
    if not head[0].isupper():
        return 0
    if any(ch in head for ch in "«»\".!?;"):
        return 0
    if len(head.split()) > rules.label_max_words:
        return 0
    return colon + 1


def line_layout(
    line: str,
    *,
    index: int,
    total: int,
    contract: dict[str, Any] | None = None,
    emphasize: bool = True,
) -> LineLayout:
    """Роль, кегль и прогоны строки — то, чем её и меряют, и рисуют.

    `emphasize=False` — страница печатает чужой текст без кавычек (ответ
    поискового ИИ): роли строк остаются, а ярлыки и числа внутри текста не
    выделяются вовсе.

    Выделяются только наши слова. Чужие приходят четырьмя путями, и ни в одном
    акцентов нет: в «ёлочках»; после ярлыка с объявленным признаком дословного
    текста; строкой без конечного знака; страницей чужого текста целиком.
    """
    text = (line or "").strip()
    role = line_role(text, index=index, total=total, contract=contract)
    rules = _rules(contract)
    own = emphasize and _is_own_sentence(text)
    if role == ROLE_HEADING:
        return LineLayout(role, SIZE_BODY, (Run(text, True, TONE_HEADING),))
    if role == ROLE_ADDRESS:
        return LineLayout(role, SIZE_CAPTION, (Run(text, False, TONE_MUTED),))
    if role == ROLE_META:
        m = rules.meta_any.match(text)
        end = m.end() if m else 0
        # Под ярлыком меты обычно чужое — примеры заголовков, домены. Числа
        # наши только под счётным ярлыком («Всего по теме: 5 материалов…»).
        counted = own and rules.count is not None and rules.count.match(text) is not None
        tail = (
            _emphasize_numbers(text[end:], TONE_MUTED, list_number=False)
            if counted
            else _plain(text[end:], TONE_MUTED)
        )
        return LineLayout(role, SIZE_CAPTION, (Run(text[:end], True, TONE_MUTED), *tail))
    if role == ROLE_ACTION:
        m = rules.action.match(text)
        end = m.end() if m else 0
        tail = _emphasize_numbers(text[end:], TONE_INK, list_number=False) if own else _plain(text[end:], TONE_INK)
        return LineLayout(role, SIZE_BODY, (Run(text[:end], True, TONE_ACTION), *tail))
    if role == ROLE_QUOTE:
        cut = _QUOTE_ATTRIBUTION_RE.search(text)
        if cut:
            at = cut.start(1)
            return LineLayout(
                role, SIZE_BODY, (Run(text[:at], False, TONE_INK), Run(text[at:], False, TONE_MUTED))
            )
        return LineLayout(role, SIZE_BODY, (Run(text, False, TONE_INK),))
    if not own:
        return LineLayout(role, SIZE_BODY, tuple(_plain(text, TONE_INK)))
    end = _label_end(text, rules)
    if end:
        verbatim = bool(rules.verbatim_marker) and rules.verbatim_marker in text[:end].lower()
        tail = (
            _plain(text[end:], TONE_INK)
            if verbatim
            else _emphasize_numbers(text[end:], TONE_INK, list_number=False)
        )
        return LineLayout(role, SIZE_BODY, (Run(text[:end], True, TONE_HEADING), *tail))
    return LineLayout(role, SIZE_BODY, tuple(_emphasize_numbers(text, TONE_INK, list_number=True)))
