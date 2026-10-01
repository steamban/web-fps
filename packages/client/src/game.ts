import {
  type ClientMessage,
  eyePosition,
  MAX_CATCHUP_MS,
  type MapData,
  MOVE_SPEED,
  type MovementState,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  type PlayerId,
  type ServerMessage,
  type SnapshotPlayer,
  type SpawnPoint,
  spawnState,
  stepMovement,
  type WeaponSlot,
} from "@web-fps/shared";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
} from "three";
import { advanceStride, createAudio, shotIsDue } from "./audio";
import { createControls } from "./controls";
import { createDebugMeter, type DebugState } from "./debug";
import { interpolatePlayers, lerpVec3, type PendingInput, reconcile } from "./netcode";
import { createView } from "./scene";

/**
 * A match, as seen from one player's eyes. The server decides where everyone is; this
 * makes that feel immediate.
 *
 * Three clocks are deliberately kept apart. Input and prediction run on the server's
 * fixed step, because a prediction simulated with a different timestep is a different
 * trajectory and would be corrected forever. Aim runs at the frame rate, straight off the
 * mouse, because latency is felt in the crosshair before anywhere else. Movement is drawn
 * between the last two predicted steps, which costs at most one step of positional lag
 * and is what stops a 20 Hz tick looking like a 20 Hz tick.
 *
 * The wiring lives here; the maths it wires together is in `netcode.ts`, tested on its own.
 */

type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;

export interface GameOptions {
  readonly canvas: HTMLCanvasElement;
  readonly map: MapData;
  readonly selfId: PlayerId;
  /** Where the server seated this player; their first frame is drawn from it. */
  readonly spawn: SpawnPoint;
  readonly tickRateHz: number;
  readonly send: (message: ClientMessage) => void;
  /**
   * Whether the server is stepping. It stops while the host has the match paused, and
   * predicting through that would mean walking around and then snapping back on resume.
   */
  readonly isRunning: () => boolean;
  /**
   * Whether this server draws hitbox wireframes on remote players — `lobbyState.debug`,
   * which is the host's `GAME_MODE=dev`. Seeing the boxes the server raycasts is an
   * advantage, so it stays the host's call; the stats overlay is not and does not.
   */
  readonly debug: boolean;
  /** Called about twice a second, always: whether anything is on screen is the caller's. */
  readonly onDebug?: (state: DebugState) => void;
}

export interface Game {
  /** Correct the local player and move everyone else towards where the server says. */
  snapshot(message: SnapshotMessage): void;
  /** Somebody else pulled a trigger; the server says who and with what. */
  remoteShot(shooterId: PlayerId, slot: WeaponSlot): void;
  /** One of this player's shots landed. */
  hitMarker(): void;
  /** Which weapon is in hand, for the HUD. Purely local — see `controls.ts`. */
  slot(): WeaponSlot;
  dispose(): void;
}

/** A snapshot and the moment it turned up, which is what remote interpolation runs on. */
interface Received {
  readonly players: readonly SnapshotPlayer[];
  readonly at: number;
}

const REMOTE_COLOR = 0xc8714a;
/** Green enough to read against the arena and the players both. */
const HITBOX_COLOR = 0x7fe08a;

export function startGame(options: GameOptions): Game {
  const { canvas, map, selfId, spawn, tickRateHz, send, isRunning, debug, onDebug } = options;
  // The same expression the server derives its timestep from, so both sides step by the
  // identical double and a prediction can match a simulation exactly.
  const stepMs = 1000 / tickRateHz;

  const view = createView(canvas, map);
  const controls = createControls(canvas, spawn.yaw);
  const audio = createAudio();
  // A browser keeps its audio suspended until a gesture, and the click that takes pointer
  // lock is the one every player makes before they can do anything else.
  canvas.addEventListener("click", audio.resume);

  // One geometry and one material for everybody; the meshes differ only in where they are.
  const body = new BoxGeometry(PLAYER_HALF_WIDTH * 2, PLAYER_HEIGHT, PLAYER_HALF_WIDTH * 2);
  const skin = new MeshLambertMaterial({ color: REMOTE_COLOR, flatShading: true });
  const meshes = new Map<PlayerId, Mesh>();

  // The body is the same box the server raycasts, but it is drawn turned to face the way
  // the player is looking and `playerBox` is axis-aligned — which is the whole point of
  // the wireframe: a player at 45 degrees presents a hitbox wider than their shoulders,
  // and nothing else on screen can show that. Built only when the server allows it, so
  // there is nothing to toggle and nothing to pay for in player mode.
  const edges = debug ? new EdgesGeometry(body) : null;
  const wire = debug ? new LineBasicMaterial({ color: HITBOX_COLOR }) : null;
  const meter = createDebugMeter();

  let predicted: MovementState = spawnState(spawn);
  /** Where the player was a step ago; the camera is drawn between the two. */
  let stepStart: MovementState = predicted;
  let pending: readonly PendingInput[] = [];
  let seq = 0;

  let previous: Received | null = null;
  let latest: Received | null = null;

  /** The last shot heard locally, so a held trigger sounds at the weapon's rate. */
  let lastShot: { seq: number; slot: WeaponSlot } | null = null;
  /** This player's own ammo, off the last snapshot. The server refuses a shot from an
   *  empty magazine outright, so without this a dry weapon keeps banging away. At most
   *  one tick stale, which is one round either side of the magazine running out. */
  let ammo: SnapshotMessage["ammo"] = null;
  const hasRounds = (slot: WeaponSlot): boolean => {
    // The snapshot's ammo block carries exactly the slots that draw from a magazine, so
    // the knife is not in it; a null block is somebody who is not a player in this match.
    if (slot === "melee" || ammo === null) return true;
    return ammo[slot].magazine > 0;
  };
  /** Distance carried towards the next footstep, for this player and for each other one. */
  let stride = 0;
  const remoteStride = new Map<PlayerId, number>();
  /** Longer than any one step can legitimately cover, so a correction is heard as silence
   *  rather than as a burst of footsteps. */
  const maxStepMetres = ((MOVE_SPEED * stepMs) / 1000) * 2;

  let lastFrame: number | null = null;
  let accumulated = 0;
  /** The server stops stepping a dead player, so this stops predicting one: walking a
   *  corpse around locally only to be snapped back every snapshot is the rubber-band the
   *  whole of this file exists to avoid. */
  let alive = true;

  /** One step: tell the server, remember it, and act on it without waiting to be told. */
  function step(yaw: number, pitch: number): void {
    // Sampled per step rather than per frame: reading the keys consumes a tapped jump, so
    // reusing one sample across two steps would turn one tap into two jumps.
    const keys = controls.keys();
    // Sampled here for the same reason, and only here: the read consumes a tapped trigger,
    // so a shot belongs to exactly one frame. `pending` never carries it — a replayed
    // frame is a movement replay, and must not fire a second round.
    const fire = controls.fire();
    // Likewise consumed by the read. Nothing local acts on it: the magazine belongs to the
    // server, which may refuse the request outright, and a HUD that started a reload the
    // server never ran would count down to a magazine that stayed empty.
    const reload = controls.reload();
    seq += 1;
    send({ type: "input", seq, keys, yaw, pitch, fire, reload });
    pending = [...pending, { seq, keys, yaw, sentAt: performance.now() }];

    if (fire !== null && hasRounds(fire) && shotIsDue(lastShot, seq, stepMs)) {
      // On the trigger, not on a server frame: your own weapon is the one place a tick of
      // latency is heard as the game being slow. The server may still refuse the shot —
      // a frame it drops takes the sound with it, which is inaudible as an error.
      audio.shot(fire);
      lastShot = { seq, slot: fire };
    }

    stepStart = predicted;
    predicted = stepMovement(predicted, keys, yaw, stepMs, map);

    const walked = advanceStride(
      stride,
      stepStart.position,
      predicted.position,
      predicted.grounded,
      maxStepMetres,
    );
    stride = walked.carried;
    if (walked.step) audio.footstep();
    if (!stepStart.grounded && predicted.grounded) {
      audio.land();
      stride = 0;
    }
  }

  /**
   * Other players' footsteps, taken from the snapshots rather than from the interpolated
   * meshes: `grounded` is already on the wire and two snapshots are all a stride needs.
   * A dead or departed player's carry goes with them, so they do not walk on coming back.
   */
  function walkRemotes(): void {
    if (!previous || !latest) return;
    const before = new Map(previous.players.map((player) => [player.id, player]));

    for (const player of latest.players) {
      if (player.id === selfId || !player.alive) {
        remoteStride.delete(player.id);
        continue;
      }
      const from = before.get(player.id);
      if (!from?.alive) continue;

      const walked = advanceStride(
        remoteStride.get(player.id) ?? 0,
        from.position,
        player.position,
        player.grounded,
        maxStepMetres,
      );
      remoteStride.set(player.id, walked.carried);
      if (walked.step) audio.footstep(player.position);
    }
  }

  function drawRemotes(now: number): void {
    if (!latest) return;

    const drawn = interpolatePlayers(
      previous?.players ?? [],
      latest.players,
      (now - latest.at) / stepMs,
      selfId,
    );

    for (const player of drawn) {
      let mesh = meshes.get(player.id);
      if (!mesh) {
        mesh = new Mesh(body, skin);
        // A child, so the existing cull takes it away with its parent.
        if (edges && wire) mesh.add(new LineSegments(edges, wire));
        meshes.set(player.id, mesh);
        view.scene.add(mesh);
      }
      // A player's position is at their feet; the box is drawn around its middle.
      mesh.position.set(
        player.position.x,
        player.position.y + PLAYER_HEIGHT / 2,
        player.position.z,
      );
      mesh.rotation.y = player.yaw;
      // Turned back out of the parent's yaw, or it would draw a rotating box and claim
      // the server raycasts one.
      const box = mesh.children[0];
      if (box) box.rotation.y = -player.yaw;
    }

    const present = new Set(drawn.map((player) => player.id));
    for (const [id, mesh] of meshes) {
      if (present.has(id)) continue;
      view.scene.remove(mesh);
      meshes.delete(id);
    }
  }

  view.renderer.setAnimationLoop((now) => {
    const elapsed = lastFrame === null ? 0 : now - lastFrame;
    lastFrame = now;
    // A backgrounded tab comes back owing minutes; simulate the cap and drop the rest.
    accumulated = Math.min(accumulated + elapsed, MAX_CATCHUP_MS);

    const look = controls.look();
    if (isRunning() && alive) {
      while (accumulated >= stepMs) {
        step(look.yaw, look.pitch);
        accumulated -= stepMs;
      }
    } else {
      // Nothing to catch up on when this ends: the server did not step either. The latches
      // go with it — a jump or a trigger tapped while dead or paused is consumed by
      // nothing otherwise, and would go off on the first step afterwards.
      controls.keys();
      controls.fire();
      controls.reload();
      accumulated = 0;
    }

    const eye = eyePosition(lerpVec3(stepStart.position, predicted.position, accumulated / stepMs));
    view.camera.position.set(eye.x, eye.y, eye.z);
    // Straight off the mouse, every frame. Aim is where lag is felt first.
    view.camera.rotation.set(look.pitch, look.yaw, 0);
    // The ears follow the camera, off the same numbers, so a sound on the left is on the
    // left of the screen.
    audio.listener(eye, look.yaw, look.pitch);

    drawRemotes(now);
    view.renderer.render(view.scene, view.camera);
    // Only on the window rollover, which is twice a second rather than once a frame.
    if (meter.frame(now)) onDebug?.(meter.read());
  });

  return {
    slot: () => controls.slot(),

    remoteShot(shooterId: PlayerId, slot: WeaponSlot): void {
      // Placed where the snapshot has them. A shooter who has already left or died between
      // the frame and this makes no sound rather than one at the origin.
      const shooter = latest?.players.find((player) => player.id === shooterId);
      // From the eye, where the shot actually leaves: the listener is 1.65 m up too, and
      // a sound at a player's feet is heard from below them.
      if (shooter) audio.remoteShot(slot, eyePosition(shooter.position));
    },

    hitMarker: () => audio.hitMarker(),

    snapshot(message: SnapshotMessage): void {
      previous = latest;
      latest = { players: message.players, at: performance.now() };

      meter.tick(message.tick);
      ammo = message.ammo;
      // The input this snapshot acknowledges is still in `pending`; `reconcile` drops it
      // on the next line. That is the whole of the round trip measurement — no `ping`
      // frame, and nothing to remember between snapshots. A snapshot that acknowledges
      // nothing new finds nothing here and leaves the last reading standing.
      const acked = pending.find((input) => input.seq === message.ackSeq);
      if (acked) meter.ack(latest.at - acked.sentAt);

      walkRemotes();

      const self = message.players.find((player) => player.id === selfId);
      if (!self) return;
      // A respawn puts the player somewhere they did not walk to, facing the way that
      // spawn faces. The snapshot's yaw is the server's, untouched by any input of theirs
      // — they have sent none since they died.
      if (self.alive && !alive) controls.faceSpawn(self.yaw);
      alive = self.alive;

      const corrected = reconcile(self, message.ackSeq, pending, map, stepMs);
      pending = corrected.pending;
      // Both, or the camera glides through the correction over the following step —
      // backwards first, whenever the correction was backwards.
      predicted = corrected.state;
      stepStart = corrected.state;
    },

    dispose(): void {
      controls.dispose();
      canvas.removeEventListener("click", audio.resume);
      audio.dispose();
      view.dispose();
      body.dispose();
      skin.dispose();
      edges?.dispose();
      wire?.dispose();
      // Hiding the canvas does not hand the mouse back on its own.
      document.exitPointerLock?.();
    },
  };
}
