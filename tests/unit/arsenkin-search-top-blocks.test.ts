import { describe, expect, it } from "vitest";
import {
  attributeSearchTopRows,
  readSearchTopRequest,
} from "@/modules/digital-profile/services/arsenkin-tool-adapters";

/** Как строит заявку `buildCheckTopRequest`: Россия — два поисковика, ОАЭ — один. */
const RU_REQUEST = {
  tools_name: "check-top",
  data: {
    queries: ["сечин игорь иванович", "иванович игорь сечин"],
    se: [
      { type: 2, region: 213 },
      { type: 11, region: 1011969 },
    ],
    depth: 20,
  },
};

const UAE_REQUEST = {
  tools_name: "check-top",
  data: {
    queries: ["sechin igor ivanovich", "sechin igor", "igor sechin"],
    se: [{ type: 11, region: 1011981 }],
    depth: 20,
  },
};

function queriesFor(pairs: Array<[string, number]>): string[] {
  return pairs.flatMap(([q, n]) => Array.from({ length: n }, () => q));
}

describe("readSearchTopRequest", () => {
  it("читает запросы, поисковики и глубину из заявки", () => {
    const r = readSearchTopRequest(RU_REQUEST);
    expect(r?.queries).toHaveLength(2);
    expect(r?.se).toHaveLength(2);
    expect(r?.depth).toBe(20);
  });

  it("принимает заявку и без обёртки data", () => {
    expect(readSearchTopRequest(RU_REQUEST.data)?.depth).toBe(20);
  });

  it("на мусоре не выдумывает структуру", () => {
    expect(readSearchTopRequest(null)).toBeNull();
    expect(readSearchTopRequest({ data: { queries: [], se: [], depth: 0 } })).toBeNull();
  });
});

describe("attributeSearchTopRows", () => {
  it("возвращает позиции внутри блока каждого поисковика (Россия, два поисковика)", () => {
    // 40 строк одного запроса = 20 Яндекса + 20 Google. Раньше вторая двадцатка
    // получала позиции 21–40 и целиком выпадала из ТОП-20.
    const { rows, warnings } = attributeSearchTopRows(
      queriesFor([["сечин игорь иванович", 40]]),
      readSearchTopRequest(RU_REQUEST)
    );
    expect(warnings).toEqual([]);
    expect(rows[0]).toEqual({ rank: 1, seIndex: 0 });
    expect(rows[19]).toEqual({ rank: 20, seIndex: 0 });
    expect(rows[20]).toEqual({ rank: 1, seIndex: 1 });
    expect(rows[39]).toEqual({ rank: 20, seIndex: 1 });
    expect(rows.every((r) => r.rank <= 20)).toBe(true);
  });

  it("начинает нумерацию заново на смене запроса (ОАЭ, один поисковик)", () => {
    const { rows } = attributeSearchTopRows(
      queriesFor([
        ["sechin igor ivanovich", 20],
        ["sechin igor", 20],
        ["igor sechin", 20],
      ]),
      readSearchTopRequest(UAE_REQUEST)
    );
    expect(rows[19]).toEqual({ rank: 20, seIndex: 0 });
    expect(rows[20]).toEqual({ rank: 1, seIndex: 0 });
    expect(rows[40]).toEqual({ rank: 1, seIndex: 0 });
    expect(rows.every((r) => r.rank <= 20)).toBe(true);
  });

  it("короткий блок при двух поисковиках относит к первому", () => {
    const { rows, warnings } = attributeSearchTopRows(
      queriesFor([["сечин игорь иванович", 14]]),
      readSearchTopRequest(RU_REQUEST)
    );
    expect(warnings).toEqual([]);
    expect(rows[13]).toEqual({ rank: 14, seIndex: 0 });
  });

  it("неразложимый блок не приписывается поисковику, но нумеруется заново", () => {
    const { rows, warnings } = attributeSearchTopRows(
      queriesFor([["сечин игорь иванович", 33]]),
      readSearchTopRequest(RU_REQUEST)
    );
    expect(warnings[0]).toContain("ENGINE_SPLIT_AMBIGUOUS");
    expect(rows[32]).toEqual({ rank: 33, seIndex: null });
    expect(rows[0]).toEqual({ rank: 1, seIndex: null });
  });

  it("без заявки нумерация всё равно перезапускается на смене запроса", () => {
    const { rows } = attributeSearchTopRows(
      queriesFor([
        ["первый запрос", 20],
        ["второй запрос", 20],
      ]),
      null
    );
    expect(rows[20]).toEqual({ rank: 1, seIndex: null });
  });

  it("пустые запросы у всех строк — один блок, сквозная нумерация внутри него", () => {
    const { rows } = attributeSearchTopRows(queriesFor([["", 25]]), readSearchTopRequest(UAE_REQUEST));
    expect(rows[24]).toEqual({ rank: 25, seIndex: 0 });
  });
});
