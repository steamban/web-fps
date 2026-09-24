import {
  type MapData,
  type MovementState,
  PLAYER_EYE_HEIGHT,
  spawnState,
  stepMovement,
} from "@web-fps/shared";
import { PerspectiveCamera, WebGLRenderer } from "three";
import { createControls } from "./controls";
import { buildScene } from "./scene";

/**
 * The M2 sandbox: one player, one map, no server. It exists to answer "does the movement
 * feel right" before M3 puts a network round trip in the way of finding out.
 *
 * The loop is the same shape the predicting client will have in M3 — a fixed timestep
 * accumulator feeding `stepMovement` — so what is being judged here is what will run there.
 */

/**
 * Fixed simulation step. Deliberately faster than the 20 Hz server tick: the sandbox has no
 * interpolation, so stepping at the server's rate would have us judging the movement
 * through a stutter that M3's interpolation removes. What is being tuned here is the
 * physics, not the tick rate — `stepMovement` takes its dt, so M3 can drive it at 20 Hz
 * without either side changing.
 */
const STEP_MS = 1000 / 60;

/** A backgrounded tab returns with a huge elapsed time; simulate a quarter second of it and
 *  drop the rest, rather than freezing while it catches up. */
const MAX_CATCHUP_MS = 250;

export function startSandbox(canvas: HTMLCanvasElement, map: MapData): () => void {
  const spawn = map.spawns[0];
  if (!spawn) throw new Error(`map ${map.name} has no spawn points`);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = buildScene(map);
  const camera = new PerspectiveCamera(80, 1, 0.1, 200);
  // Yaw before pitch, so looking up does not roll the horizon.
  camera.rotation.order = "YXZ";

  const controls = createControls(canvas, spawn.yaw);
  let state: MovementState = spawnState(spawn);

  const resize = (): void => {
    const { innerWidth, innerHeight } = window;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  let previous: number | null = null;
  let pending = 0;

  renderer.setAnimationLoop((now) => {
    pending = Math.min(pending + (previous === null ? 0 : now - previous), MAX_CATCHUP_MS);
    previous = now;

    const look = controls.look();
    while (pending >= STEP_MS) {
      state = stepMovement(state, controls.keys(), look.yaw, STEP_MS, map);
      pending -= STEP_MS;
    }

    camera.position.set(state.position.x, state.position.y + PLAYER_EYE_HEIGHT, state.position.z);
    camera.rotation.set(look.pitch, look.yaw, 0);
    renderer.render(scene, camera);
  });

  return () => {
    renderer.setAnimationLoop(null);
    window.removeEventListener("resize", resize);
    controls.dispose();
    renderer.dispose();
  };
}
