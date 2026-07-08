/**
 * R10.4 — Ambiguous high-impact topics must not be auto-labelled as negative.
 */

export type ControversialTopicMatch = {
  topicId: string;
  label: string;
  matchedTerms: string[];
  defaultRiskSignal: "CONTROVERSIAL_DUAL_USE" | "COMPLIANCE_RELEVANT";
  neutralInterpretation: string;
  riskInterpretation: string;
  positiveInterpretation?: string;
  missingContext: string[];
};

const TOPIC_PATTERNS: Array<{
  id: string;
  label: string;
  terms: RegExp[];
  defaultRiskSignal: "CONTROVERSIAL_DUAL_USE" | "COMPLIANCE_RELEVANT";
  neutral: string;
  risk: string;
  positive?: string;
  missing: string[];
}> = [
  {
    id: "luxury_assets",
    label: "Роскошные активы / покупки",
    terms: [/яхт/i, /yacht/i, /самолет/i, /jet/i, /особняк/i, /mansion/i, /роскош/i, /luxury/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Публичная информация о lifestyle / имуществе без доказанной незаконности.",
    risk: "Может быть релевантно при связи с неразъяснённым происхождением средств или публичными фондами.",
    positive: "Может отражать легальный предпринимательский успех.",
    missing: ["Источник средств", "Связь с проверяемым субъектом", "Дата и контекст публикации"],
  },
  {
    id: "offshore",
    label: "Офшорные структуры",
    terms: [/offshore/i, /офшор/i, /bvi/i, /cayman/i, /cyprus/i, /кипр/i],
    defaultRiskSignal: "COMPLIANCE_RELEVANT",
    neutral: "Наличие офшорной структуры само по себе не является нарушением.",
    risk: "Может быть значимо для AML/KYC при непрозрачной бенефициарности.",
    missing: ["UBO", "Доля участия субъекта", "Подтверждение из реестра"],
  },
  {
    id: "pep_links",
    label: "PEP / политические связи",
    terms: [/pep/i, /politically exposed/i, /политическ/i, /чиновник/i, /deputy/i, /minister/i],
    defaultRiskSignal: "COMPLIANCE_RELEVANT",
    neutral: "Публичная или деловая связь с PEP не равна риску.",
    risk: "Требует проверки степени близости и регуляторного статуса.",
    missing: ["Роль субъекта", "Степень связи", "Подтверждение из PEP-источника"],
  },
  {
    id: "sanctions_name_match",
    label: "Санкционное совпадение по имени",
    terms: [/sanction/i, /санкц/i, /watchlist/i, /sdn/i, /ofac/i],
    defaultRiskSignal: "COMPLIANCE_RELEVANT",
    neutral: "Совпадение по имени может быть одноимённым лицом.",
    risk: "При совпадении идентификаторов — высокий compliance-риск.",
    missing: ["ИНН/ОГРН/DOB", "Юрисдикция", "Подтверждение из первичного списка"],
  },
  {
    id: "investigation_mention",
    label: "Упоминание в расследовании без прямого обвинения",
    terms: [/расследован/i, /investigation/i, /probe/i, /inquiry/i, /проверк/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Упоминание в материале о расследовании не означает участие или вину субъекта.",
    risk: "Может указывать на репутационный или compliance-контекст при подтверждении связи.",
    missing: ["Роль субъекта в материале", "Статус дела", "Первоисточник"],
  },
  {
    id: "court_mention",
    label: "Судебное упоминание с неясной ролью",
    terms: [/court/i, /суд/i, /arbitration/i, /арbitr/i, /иск/i, /litigation/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Судебное упоминание может относиться к стороне, свидетелю или одноимённому лицу.",
    risk: "Может быть негативным при подтверждённой роли ответчика/обвиняемого.",
    missing: ["Роль в деле", "Исход", "Связь с субъектом"],
  },
  {
    id: "adverse_low_reliability",
    label: "Негатив из низконадёжного источника",
    terms: [/компромат/i, /compromat/i, /скандал/i, /tabloid/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Публикация может быть спекулятивной или не подтверждённой.",
    risk: "Требует верификации первоисточника перед выводами.",
    missing: ["Автор", "Дата", "Подтверждение фактов независимыми источниками"],
  },
  {
    id: "procurement",
    label: "Госзакупки / procurement",
    terms: [/закупк/i, /procurement/i, /tender/i, /госконтракт/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Участие в закупках может быть обычной деловой активностью.",
    risk: "Может быть значимо при конфликте интересов или расследовании.",
    missing: ["Роль (поставщик/заказчик)", "Сумма", "Статус процедуры"],
  },
  {
    id: "donations",
    label: "Пожертвования / благотворительность",
    terms: [/donat/i, /пожертв/i, /благотвор/i, /charit/i],
    defaultRiskSignal: "CONTROVERSIAL_DUAL_USE",
    neutral: "Благотворительность может быть нейтральным или позитивным сигналом.",
    risk: "Может быть релевантно при связи с PEP или санкционными лицами.",
    missing: ["Получатель", "Сумма", "Политический контекст"],
  },
];

export function detectControversialTopics(text: string): ControversialTopicMatch[] {
  const lower = text.toLowerCase();
  const matches: ControversialTopicMatch[] = [];
  for (const topic of TOPIC_PATTERNS) {
    const matchedTerms: string[] = [];
    for (const re of topic.terms) {
      const m = lower.match(re);
      if (m) matchedTerms.push(m[0]);
    }
    if (matchedTerms.length === 0) continue;
    matches.push({
      topicId: topic.id,
      label: topic.label,
      matchedTerms: [...new Set(matchedTerms)],
      defaultRiskSignal: topic.defaultRiskSignal,
      neutralInterpretation: topic.neutral,
      riskInterpretation: topic.risk,
      positiveInterpretation: topic.positive,
      missingContext: topic.missing,
    });
  }
  return matches;
}

export function mustNotAutoLabelAdverse(topics: ControversialTopicMatch[]): boolean {
  return topics.length > 0;
}
