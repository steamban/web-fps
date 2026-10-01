/**
 * The numbers behind the `GAME_MODE=dev` overlay, as arithmetic with no DOM and no
 * renderer in it — the `controls.ts` split again, so that the one client file without a
 * test of its own gains wiring rather than logic.
 *
 * Whether the overlay exists at all is the server's call, reported as `lobbyState.debug`.
 */

export interface DebugState {
  readonly fps: number;
  /**
   * The longest single frame in the window, in milliseconds. This is the number that
   * answers "it is not a constant 60": an average of 60 and a worst frame of 90 ms is a
   * visible hitch twice a second, and the average alone hides it completely.
   */
  readonly worstFrameMs: number;
  /**
   * Milliseconds from an input leaving this client to the snapshot that acknowledges it,
   * smoothed. Null until one has come back.
   *
   * It is deliberately not called a ping. It is the round trip *plus* however long the
   * input waited in the server's queue for the next tick boundary — up to a whole tick,
   * 50 ms at the default rate — so it is the latency a player actually feels rather than
   * the network's. The overlay prints the tick interval beside it so the floor is visible.
   */
  readonly ackMs: number | null;
  /** The tick of the last snapshot. */
  readonly tick: number;
  /**
   * Snapshots received per second over the same window. Measured rather than assumed:
   * below the server's tick rate means frames are being lost or bunched on the way here,
   * which is remote players stuttering while the local frame rate is untouched — the one
   * thing the other numbers cannot tell apart.
   */
  readonly snapshotHz: number;
}

export interface DebugMeter {
  /** One rendered frame. True when the window rolled over, which is when `read()` moved. */
  frame(now: number): boolean;
  ack(roundTripMs: number): void;
  tick(tick: number): void;
  read(): DebugState;
}

/**
 * Long enough to be readable and to average 30 frames at 60 Hz, short enough that a
 * stutter still shows. A per-frame `1000 / elapsed` is unreadable — one long frame and the
 * digit jumps — and a ring buffer is bookkeeping for the same answer.
 */
export const FPS_WINDOW_MS = 500;

/** How much one round trip moves the running average. */
const ACK_SMOOTHING = 0.1;

export function createDebugMeter(): DebugMeter {
  let fps = 0;
  let frames = 0;
  let worstFrameMs = 0;
  let worstInWindow = 0;
  let previousFrame: number | null = null;
  let windowStart: number | null = null;
  let ackMs: number | null = null;
  let tick = 0;
  let snapshotHz = 0;
  let snapshots = 0;

  return {
    frame(now: number): boolean {
      // The first frame only starts the window: it has no predecessor to span from.
      if (windowStart === null) {
        windowStart = now;
        previousFrame = now;
        return false;
      }
      frames += 1;
      worstInWindow = Math.max(worstInWindow, now - (previousFrame ?? now));
      previousFrame = now;
      const span = now - windowStart;
      if (span < FPS_WINDOW_MS) return false;

      fps = Math.round((frames * 1000) / span);
      worstFrameMs = worstInWindow;
      snapshotHz = Math.round((snapshots * 1000) / span);
      frames = 0;
      worstInWindow = 0;
      snapshots = 0;
      windowStart = now;
      return true;
    },
    ack(roundTripMs: number): void {
      ackMs = ackMs === null ? roundTripMs : ackMs + (roundTripMs - ackMs) * ACK_SMOOTHING;
    },
    tick(latest: number): void {
      tick = latest;
      snapshots += 1;
    },
    read: (): DebugState => ({ fps, worstFrameMs, ackMs, tick, snapshotHz }),
  };
}

/**
 * One line each, monospaced, with every number next to the one that explains it: the
 * worst frame beside the average it hides in, the measured snapshot rate beside the tick
 * rate it should match. Reading down the lines separates the two things that both feel
 * like lag — a frame rate that dips is on the first line, a network that stutters on the
 * last two.
 */
export function formatDebug(state: DebugState, tickRateHz: number): string {
  const ack = state.ackMs === null ? "—" : `${Math.round(state.ackMs)} ms`;
  return [
    `fps ${state.fps} (worst frame ${Math.round(state.worstFrameMs)} ms)`,
    `in→ack ${ack}`,
    `snapshots ${state.snapshotHz}/s`,
    `tick ${state.tick} @ ${tickRateHz} Hz`,
  ].join("\n");
}
