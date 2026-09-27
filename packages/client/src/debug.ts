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
  let windowStart: number | null = null;
  let ackMs: number | null = null;
  let tick = 0;

  return {
    frame(now: number): boolean {
      // The first frame only starts the window: it has no predecessor to span from.
      if (windowStart === null) {
        windowStart = now;
        return false;
      }
      frames += 1;
      const span = now - windowStart;
      if (span < FPS_WINDOW_MS) return false;

      fps = Math.round((frames * 1000) / span);
      frames = 0;
      windowStart = now;
      return true;
    },
    ack(roundTripMs: number): void {
      ackMs = ackMs === null ? roundTripMs : ackMs + (roundTripMs - ackMs) * ACK_SMOOTHING;
    },
    tick(latest: number): void {
      tick = latest;
    },
    read: (): DebugState => ({ fps, ackMs, tick }),
  };
}

/** One line each, monospaced, with the tick rate next to the numbers it explains. */
export function formatDebug(state: DebugState, tickRateHz: number): string {
  const ack = state.ackMs === null ? "—" : `${Math.round(state.ackMs)} ms`;
  return [`fps ${state.fps}`, `in→ack ${ack}`, `tick ${state.tick} @ ${tickRateHz} Hz`].join("\n");
}
