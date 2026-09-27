import type { ScoreEntry } from "./protocol";

/**
 * How a scoreboard is ordered: most kills, then fewest deaths, then by id — arbitrary
 * between two identical lines but total, so every client shows the same order.
 *
 * It lives here rather than beside either caller because there are two of them: the board
 * the server sends when a match ends, and the one a player holds a key for while it is
 * still running. Sorted by different rules, the board would visibly reshuffle the moment
 * `matchEnd` arrived.
 */
export function compareScores(a: ScoreEntry, b: ScoreEntry): number {
  return b.score - a.score || a.deaths - b.deaths || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
