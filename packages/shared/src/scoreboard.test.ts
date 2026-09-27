import { describe, expect, it } from "vitest";
import type { ScoreEntry } from "./protocol";
import { compareScores } from "./scoreboard";

const entry = (id: string, score: number, deaths: number): ScoreEntry => ({
  id,
  name: id,
  score,
  deaths,
});

describe("compareScores", () => {
  it("puts the most kills first, then the fewest deaths", () => {
    const board = [entry("a", 3, 0), entry("b", 9, 4), entry("c", 3, 7)].sort(compareScores);
    expect(board.map((line) => line.id)).toEqual(["b", "a", "c"]);
  });

  it("is total, so two identical lines still have an order", () => {
    // Arbitrary between them, but the same arbitrary order on every screen — which is
    // worth more than a fairer tie-break each client computes for itself.
    const one = [entry("y", 2, 2), entry("x", 2, 2)].sort(compareScores);
    const other = [entry("x", 2, 2), entry("y", 2, 2)].sort(compareScores);

    expect(one.map((line) => line.id)).toEqual(["x", "y"]);
    expect(one).toEqual(other);
  });
});
