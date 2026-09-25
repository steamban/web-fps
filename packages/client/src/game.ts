import {
  type ClientMessage,
  MAX_CATCHUP_MS,
  type MapData,
  type MovementState,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  type PlayerId,
  type ServerMessage,
  type SnapshotPlayer,
  type SpawnPoint,
  spawnState,
  stepMovement,
} from "@web-fps/shared";
import { BoxGeometry, Mesh, MeshLambertMaterial } from "three";
import { createControls } from "./controls";
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
}

export interface Game {
  /** Correct the local player and move everyone else towards where the server says. */
  snapshot(message: SnapshotMessage): void;
  dispose(): void;
}

/** A snapshot and the moment it turned up, which is what remote interpolation runs on. */
interface Received {
  readonly players: readonly SnapshotPlayer[];
  readonly at: number;
}

const REMOTE_COLOR = 0xc8714a;

export function startGame(options: GameOptions): Game {
  const { canvas, map, selfId, spawn, tickRateHz, send, isRunning } = options;
  // The same expression the server derives its timestep from, so both sides step by the
  // identical double and a prediction can match a simulation exactly.
  const stepMs = 1000 / tickRateHz;

  const view = createView(canvas, map);
  const controls = createControls(canvas, spawn.yaw);

  // One geometry and one material for everybody; the meshes differ only in where they are.
  const body = new BoxGeometry(PLAYER_HALF_WIDTH * 2, PLAYER_HEIGHT, PLAYER_HALF_WIDTH * 2);
  const skin = new MeshLambertMaterial({ color: REMOTE_COLOR, flatShading: true });
  const meshes = new Map<PlayerId, Mesh>();

  let predicted: MovementState = spawnState(spawn);
  /** Where the player was a step ago; the camera is drawn between the two. */
  let stepStart: MovementState = predicted;
  let pending: readonly PendingInput[] = [];
  let seq = 0;

  let previous: Received | null = null;
  let latest: Received | null = null;

  let lastFrame: number | null = null;
  let accumulated = 0;

  /** One step: tell the server, remember it, and act on it without waiting to be told. */
  function step(yaw: number, pitch: number): void {
    // Sampled per step rather than per frame: reading the keys consumes a tapped jump, so
    // reusing one sample across two steps would turn one tap into two jumps.
    const keys = controls.keys();
    seq += 1;
    send({ type: "input", seq, keys, yaw, pitch });
    pending = [...pending, { seq, keys, yaw }];

    stepStart = predicted;
    predicted = stepMovement(predicted, keys, yaw, stepMs, map);
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
    if (isRunning()) {
      while (accumulated >= stepMs) {
        step(look.yaw, look.pitch);
        accumulated -= stepMs;
      }
    } else {
      // Nothing to catch up on when the match resumes: the server did not step either.
      accumulated = 0;
    }

    const eye = lerpVec3(stepStart.position, predicted.position, accumulated / stepMs);
    view.camera.position.set(eye.x, eye.y + PLAYER_EYE_HEIGHT, eye.z);
    // Straight off the mouse, every frame. Aim is where lag is felt first.
    view.camera.rotation.set(look.pitch, look.yaw, 0);

    drawRemotes(now);
    view.renderer.render(view.scene, view.camera);
  });

  return {
    snapshot(message: SnapshotMessage): void {
      previous = latest;
      latest = { players: message.players, at: performance.now() };

      const self = message.players.find((player) => player.id === selfId);
      if (!self) return;

      const corrected = reconcile(self, message.ackSeq, pending, map, stepMs);
      pending = corrected.pending;
      // Both, or the camera glides through the correction over the following step —
      // backwards first, whenever the correction was backwards.
      predicted = corrected.state;
      stepStart = corrected.state;
    },

    dispose(): void {
      controls.dispose();
      view.dispose();
      body.dispose();
      skin.dispose();
      // Hiding the canvas does not hand the mouse back on its own.
      document.exitPointerLock?.();
    },
  };
}
