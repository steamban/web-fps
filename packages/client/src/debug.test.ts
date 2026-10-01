import { describe, expect, it } from "vitest";
import { createDebugMeter, FPS_WINDOW_MS, formatDebug } from "./debug";

/**
 * Arithmetic only — no DOM, no renderer. What the overlay looks like is verified by
 * playing (PLAN.md M6); what it counts is not.
 */

/**
 * Frames at a steady rate, starting from the call that opens the window. The rates used
 * here divide the window exactly, so a frame lands on the boundary rather than a
 * rounding error either side of it.
 */
function run(hz: number, ms: number): { rolled: number; fps: number } {
  const meter = createDebugMeter();
  const step = 1000 / hz;
  let rolled = 0;
  for (let now = 0; now <= ms; now += step) if (meter.frame(now)) rolled += 1;
  return { rolled, fps: meter.read().fps };
}

describe("the frame rate", () => {
  it("is zero until the first window has closed", () => {
    const meter = createDebugMeter();
    // The opening call has no predecessor to measure a span from.
    expect(meter.frame(0)).toBe(false);
    expect(meter.frame(100)).toBe(false);
    expect(meter.read().fps).toBe(0);
  });

  it("reports the rate the frames actually arrived at", () => {
    expect(run(50, FPS_WINDOW_MS).fps).toBe(50);
    expect(run(200, FPS_WINDOW_MS).fps).toBe(200);
  });

  it("rolls over twice a second and not once a frame", () => {
    // What the caller writes to the screen on, so a 240 Hz display is not four hundred
    // DOM writes a second.
    expect(run(50, 2000).rolled).toBe(Math.floor(2000 / FPS_WINDOW_MS));
  });
});

describe("the round trip", () => {
  it("is unknown until an input has been acknowledged", () => {
    expect(createDebugMeter().read().ackMs).toBeNull();
  });

  it("takes the first sample whole and then averages towards the rest", () => {
    const meter = createDebugMeter();
    meter.ack(40);
    expect(meter.read().ackMs).toBe(40);

    // A smoothed number, so one slow tick does not make the digit unreadable.
    for (let i = 0; i < 100; i += 1) meter.ack(20);
    expect(meter.read().ackMs).toBeCloseTo(20, 2);
  });

  it("stands still when a snapshot acknowledges nothing new", () => {
    // Two snapshots can echo the same ack, and the second finds nothing to time against.
    // Reporting 0 for that would flicker a zero onto the screen every other frame.
    const meter = createDebugMeter();
    meter.ack(35);
    meter.frame(0);
    expect(meter.read().ackMs).toBe(35);
  });
});

describe("the overlay text", () => {
  it("prints the tick rate beside the numbers that depend on it", () => {
    const meter = createDebugMeter();
    meter.ack(31);
    meter.tick(4182);

    expect(formatDebug(meter.read(), 20)).toBe(
      "fps 0 (worst frame 0 ms)\nin→ack 31 ms\nsnapshots 0/s\ntick 4182 @ 20 Hz",
    );
  });

  it("says nothing rather than zero before the first acknowledgement", () => {
    expect(formatDebug(createDebugMeter().read(), 20)).toContain("in→ack —");
  });
});

describe("the worst frame", () => {
  it("is the longest gap in the window, not the average the other line reports", () => {
    const meter = createDebugMeter();
    meter.frame(0);
    // 60 Hz for most of the window with one 100 ms hitch in the middle of it: the kind of
    // stall that is felt and that an average of thirty frames all but erases.
    let now = 0;
    for (let i = 0; i < 10; i += 1) meter.frame((now += 16));
    meter.frame((now += 100));
    while (now < FPS_WINDOW_MS) meter.frame((now += 16));
    meter.frame(FPS_WINDOW_MS + 16);

    expect(meter.read().worstFrameMs).toBe(100);
  });

  it("resets with the window, so a stall does not stay on screen after it is over", () => {
    const meter = createDebugMeter();
    meter.frame(0);
    meter.frame(200);
    meter.frame(FPS_WINDOW_MS);
    // The 300 ms from the second frame to the window's close, not the 200 before it.
    expect(meter.read().worstFrameMs).toBe(300);

    // Past the next rollover, which is what republishes the number.
    for (let now = FPS_WINDOW_MS + 16; now <= FPS_WINDOW_MS * 2 + 16; now += 16) meter.frame(now);
    expect(meter.read().worstFrameMs).toBeLessThan(20);
  });
});

describe("the snapshot rate", () => {
  it("counts the snapshots that actually arrived in the window", () => {
    const meter = createDebugMeter();
    meter.frame(0);
    // Ten snapshots in half a second is the 20 Hz the server says it ticks at.
    for (let i = 0; i < 10; i += 1) meter.tick(i);
    meter.frame(FPS_WINDOW_MS);

    expect(meter.read().snapshotHz).toBe(20);
  });

  it("reports the shortfall when snapshots go missing", () => {
    const meter = createDebugMeter();
    meter.frame(0);
    // Half of them lost: remote players stutter while the frame rate is untouched, which
    // is the case no other number on the overlay distinguishes.
    for (let i = 0; i < 5; i += 1) meter.tick(i);
    meter.frame(FPS_WINDOW_MS);

    expect(meter.read().snapshotHz).toBe(10);
  });
});
