import { describe, expect, it } from "vitest";
import { boundedPage } from "../src/server/boundedPagination";

describe("bounded API pagination", () => {
  it("normalizes invalid offsets and caps response detail", () => {
    expect(boundedPage(-4.8, 10_000, 25, 10)).toEqual({ offset: 0, limit: 25 });
    expect(boundedPage(Number.NaN, Number.NaN, 25, 10)).toEqual({ offset: 0, limit: 10 });
    expect(boundedPage(9.9, 0, 25, 10)).toEqual({ offset: 9, limit: 1 });
  });
});
