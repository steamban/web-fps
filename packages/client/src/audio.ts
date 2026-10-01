import { aimDirection, LOADOUT, type Vec3, type WeaponSlot } from "@web-fps/shared";

/**
 * The match's sound, synthesised. Nothing here loads a file: this repo has no asset
 * pipeline — the renderer is flat-shaded boxes for the same reason — and a gunshot is a
 * filtered noise burst with an envelope on it, which is a dozen lines and no build step.
 * It reads as arcade rather than as a recorded firearm, which is what the rest of the
 * game looks like.
 *
 * The one piece of arithmetic in here is `advanceStride`, and it is tested. Everything
 * else is a graph, verified by listening (PLAN.md M6).
 */

/** Metres of ground covered between one footstep and the next. */
export const STRIDE_METRES = 2.2;

/**
 * Carries a player's distance travelled towards the next footstep.
 *
 * Only horizontal movement counts and only while grounded, so falling is silent and a
 * player pinned against a wall does not run on the spot. A move longer than a step could
 * possibly be is a teleport — a respawn, or a correction — and resets the carry instead of
 * ringing out several steps at once.
 */
export function advanceStride(
  carried: number,
  from: Vec3,
  to: Vec3,
  grounded: boolean,
  maxStepMetres: number,
): { carried: number; step: boolean } {
  const travelled = Math.hypot(to.x - from.x, to.z - from.z);
  if (travelled > maxStepMetres) return { carried: 0, step: false };
  if (!grounded) return { carried, step: false };

  const total = carried + travelled;
  return total >= STRIDE_METRES
    ? { carried: total - STRIDE_METRES, step: true }
    : { carried: total, step: false };
}

/**
 * Whether enough steps have passed for this weapon to have fired again, which is the
 * server's own rule re-derived: it allows the next shot `ceil(interval / dt)` ticks later,
 * and the client samples its trigger once per step, so the two agree at every tick rate.
 * Without it a held trigger would sound at the step rate while the server fires at the
 * weapon's rate — two bangs for every round that leaves the barrel.
 */
export function shotIsDue(
  last: { seq: number; slot: WeaponSlot } | null,
  seq: number,
  stepMs: number,
): boolean {
  if (last === null) return true;
  // `fireCooldownTicks` verbatim, rather than a float product that compares equal to the
  // interval at some tick rates and a hair under it at others.
  return seq - last.seq >= Math.max(1, Math.ceil(LOADOUT[last.slot].fireIntervalMs / stepMs));
}

export interface Audio {
  /** A browser starts its audio suspended until a gesture; the canvas click is the one. */
  resume(): void;
  /** Where the ears are. Called every frame, from the same numbers as the camera. */
  listener(eye: Vec3, yaw: number, pitch: number): void;
  /** This player's own weapon, heard flat and immediately. */
  shot(slot: WeaponSlot): void;
  /** Somebody else's, placed where they are standing. */
  remoteShot(slot: WeaponSlot, at: Vec3): void;
  /** A footstep, flat for this player and placed for anybody else. */
  footstep(at?: Vec3): void;
  land(): void;
  hitMarker(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// the graph
// ---------------------------------------------------------------------------

/**
 * One context for the page, not one per match. A match is disposed and rebuilt on every
 * round (`enterMatch`), and a browser caps how many contexts a document may have — a
 * per-match one goes silent a few rounds in, which a single playtest would never show.
 * Built on the first sound rather than at import, because an `AudioContext` may not exist
 * at all: happy-dom has none, so the tests import this file safely.
 */
let shared: { ctx: AudioContext; noise: AudioBuffer; out: AudioNode } | null = null;

function audio(): typeof shared {
  if (shared) return shared;
  if (typeof AudioContext === "undefined") return null;

  const ctx = new AudioContext();
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;

  // Eight people firing at once would clip without this, and it is one node.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 12;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  limiter.connect(ctx.destination);

  shared = { ctx, noise, out: limiter };
  return shared;
}

/**
 * An attack-decay envelope. Both ends are a hair above zero because an exponential ramp
 * cannot touch it — written the obvious way the whole sound is silent.
 */
function envelope(ctx: AudioContext, peak: number, attackMs: number, decayMs: number): GainNode {
  const at = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attackMs / 1000);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + (attackMs + decayMs) / 1000);
  return gain;
}

/**
 * Where a one-shot starts: the match's own gain, or a panner standing where the sound is
 * and feeding that gain. A panner is built per sound and nothing holds it once the voice
 * through it has finished, so it goes when the voice does.
 */
function destination(ctx: AudioContext, master: GainNode, at: Vec3 | undefined, reach: number) {
  if (!at) return master;
  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = reach;
  panner.rolloffFactor = 1.2;
  panner.maxDistance = 80;
  panner.positionX.value = at.x;
  panner.positionY.value = at.y;
  panner.positionZ.value = at.z;
  panner.connect(master);
  return panner;
}

interface Burst {
  readonly type: BiquadFilterType;
  readonly from: number;
  /** Swept to over the decay, for the falling body of a gunshot. */
  readonly to?: number;
  readonly q: number;
  readonly peak: number;
  readonly attackMs: number;
  readonly decayMs: number;
}

/** A band of noise, played from a random offset into the shared buffer. */
function burst(into: AudioNode, spec: Burst): void {
  const found = audio();
  if (found === null) return;
  const { ctx, noise } = found;
  // A suspended context's clock does not advance, so anything scheduled on one is
  // scheduled at the same instant and goes off together the moment it resumes.
  if (ctx.state !== "running") return;
  const at = ctx.currentTime;

  const filter = ctx.createBiquadFilter();
  filter.type = spec.type;
  filter.Q.value = spec.q;
  filter.frequency.setValueAtTime(spec.from, at);
  if (spec.to !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(spec.to, at + spec.decayMs / 1000);
  }

  const source = ctx.createBufferSource();
  source.buffer = noise;
  source
    .connect(filter)
    .connect(envelope(ctx, spec.peak, spec.attackMs, spec.decayMs))
    .connect(into);
  source.start(at, Math.random() * (noise.duration - 0.3), (spec.attackMs + spec.decayMs) / 1000);
}

/** A falling sine, which is what gives a gunshot a body rather than a hiss. */
function thump(into: AudioNode, from: number, to: number, decayMs: number): void {
  const found = audio();
  if (found === null) return;
  const { ctx } = found;
  if (ctx.state !== "running") return;
  const at = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + decayMs / 1000);
  osc.connect(envelope(ctx, 0.5, 3, decayMs)).connect(into);
  osc.start(at);
  osc.stop(at + (decayMs + 40) / 1000);
}

function tone(into: AudioNode, hz: number, peak: number, decayMs: number): void {
  const found = audio();
  if (found === null) return;
  const { ctx } = found;
  if (ctx.state !== "running") return;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = hz;
  osc.connect(envelope(ctx, peak, 1, decayMs)).connect(into);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + (decayMs + 40) / 1000);
}

/** Per weapon: how sharp the crack is and how much body follows it. */
const VOICE: Readonly<Record<WeaponSlot, { crack: number; body: number; thump: number | null }>> = {
  primary: { crack: 1200, body: 900, thump: 140 },
  secondary: { crack: 1800, body: 1100, thump: 180 },
  melee: { crack: 2500, body: 0, thump: null },
};

export function createAudio(): Audio {
  const found = audio;
  /**
   * Everything this match plays goes through one gain of its own, so disposing it silences
   * whatever is still ringing without tracking a single voice — none of them lasts beyond
   * 150 ms anyway.
   */
  let master: GainNode | null = null;
  let leftFoot = false;

  const chain = (): { ctx: AudioContext; master: GainNode } | null => {
    const built = found();
    if (!built) return null;
    if (!master) {
      master = built.ctx.createGain();
      master.gain.value = 0.7;
      // Once, here. Connecting it at the end of each voice instead would add an edge per
      // sound, and every later sound would then be re-emitted from every panner built
      // before it — the whole match playing back from everywhere anyone had ever stood.
      master.connect(built.out);
    }
    return { ctx: built.ctx, master };
  };

  const gunshot = (slot: WeaponSlot, at?: Vec3): void => {
    const found = chain();
    if (!found) return;
    const into = destination(found.ctx, found.master, at, 6);
    const voice = VOICE[slot];
    // Turned a little each time, so a held trigger is a weapon rather than a loop.
    const detune = 0.94 + Math.random() * 0.12;

    burst(into, {
      type: "highpass",
      from: voice.crack * detune,
      q: 0.7,
      peak: slot === "melee" ? 0.3 : 0.85,
      attackMs: slot === "melee" ? 14 : 1,
      decayMs: slot === "melee" ? 120 : 60,
    });
    if (voice.thump === null) return;
    burst(into, {
      type: "lowpass",
      from: voice.body * detune,
      to: 180,
      q: 0.6,
      peak: 0.6,
      attackMs: 2,
      decayMs: 110,
    });
    thump(into, voice.thump * detune, 55, 90);
  };

  return {
    resume(): void {
      // Idempotent and cheap, so it also covers a context the browser suspended while the
      // tab was in the background.
      void chain()?.ctx.resume();
    },

    listener(eye: Vec3, yaw: number, pitch: number): void {
      const found = chain();
      if (!found) return;
      const forward = aimDirection(yaw, pitch);
      const ears = found.ctx.listener;
      // The same definition the camera and the bullets use, so the ears point where the
      // crosshair does.
      ears.positionX.value = eye.x;
      ears.positionY.value = eye.y;
      ears.positionZ.value = eye.z;
      ears.forwardX.value = forward.x;
      ears.forwardY.value = forward.y;
      ears.forwardZ.value = forward.z;
      ears.upX.value = 0;
      ears.upY.value = 1;
      ears.upZ.value = 0;
    },

    shot: (slot) => gunshot(slot),
    remoteShot: (slot, at) => gunshot(slot, at),

    footstep(at?: Vec3): void {
      const found = chain();
      if (!found) return;
      leftFoot = !leftFoot;
      burst(destination(found.ctx, found.master, at, 2), {
        type: "bandpass",
        // Two feet: an identical click repeated is a machine, not a person walking.
        from: leftFoot ? 390 : 455,
        q: 1.4,
        // Your own feet are quiet; somebody else's are the point.
        peak: at ? 0.5 : 0.22,
        attackMs: 3,
        decayMs: 90,
      });
    },

    land(): void {
      const found = chain();
      if (!found) return;
      burst(found.master, {
        type: "bandpass",
        from: 260,
        q: 1.2,
        peak: 0.45,
        attackMs: 3,
        decayMs: 140,
      });
    },

    hitMarker(): void {
      const found = chain();
      if (!found) return;
      // A fifth apart, flat and short — heard over a firefight without being part of it.
      tone(found.master, 1760, 0.22, 70);
      tone(found.master, 2640, 0.1, 50);
    },

    dispose(): void {
      master?.disconnect();
      master = null;
      // The context is the page's, not this match's, and is deliberately left open.
    },
  };
}
