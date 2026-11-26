import { describe, expect, it } from "vitest";
import { parseJsonLine, readJsonLines, type LineRecord } from "../../src/parser/lines.js";
import { asyncLines } from "./synthetic.js";

async function collect(source: Parameters<typeof readJsonLines>[0]): Promise<LineRecord[]> {
  const records: LineRecord[] = [];
  for await (const record of readJsonLines(source)) records.push(record);
  return records;
}

describe("parseJsonLine", () => {
  it("returns a JSON object line as an object record", () => {
    expect(parseJsonLine('{"type":"user","n":1}')).toEqual({
      kind: "object",
      value: { type: "user", n: 1 },
    });
  });

  it.each(["{", "not json", "[1,2]", "null", "42", '"text"', "true", '{"a":1} trailing'])(
    "treats %j as malformed",
    (text) => {
      expect(parseJsonLine(text)).toEqual({ kind: "malformed" });
    },
  );
});

describe("readJsonLines", () => {
  it("reads a sync iterable in order", async () => {
    expect(await collect(['{"n":1}', '{"n":2}'])).toEqual([
      { kind: "object", value: { n: 1 } },
      { kind: "object", value: { n: 2 } },
    ]);
  });

  it("reads an async iterable in order", async () => {
    expect(await collect(asyncLines(['{"n":1}', "oops", '{"n":3}']))).toEqual([
      { kind: "object", value: { n: 1 } },
      { kind: "malformed" },
      { kind: "object", value: { n: 3 } },
    ]);
  });

  it("splits an item that holds several lines, with LF or CRLF endings", async () => {
    expect(await collect(['{"n":1}\n{"n":2}\r\n{"n":3}\n'])).toEqual([
      { kind: "object", value: { n: 1 } },
      { kind: "object", value: { n: 2 } },
      { kind: "object", value: { n: 3 } },
    ]);
  });

  it("skips blank and whitespace-only lines without reporting them", async () => {
    expect(await collect(["", "   ", '{"n":1}', "\t", ""])).toEqual([
      { kind: "object", value: { n: 1 } },
    ]);
  });

  it("removes a byte order mark at the start of the source only", async () => {
    expect(await collect(['\uFEFF{"n":1}', '\uFEFF{"n":2}'])).toEqual([
      { kind: "object", value: { n: 1 } },
      { kind: "malformed" },
    ]);
  });

  it("reports an item that is not a string as malformed", async () => {
    const source = ['{"n":1}', 7, null] as unknown as string[];
    expect(await collect(source)).toEqual([
      { kind: "object", value: { n: 1 } },
      { kind: "malformed" },
      { kind: "malformed" },
    ]);
  });
});
