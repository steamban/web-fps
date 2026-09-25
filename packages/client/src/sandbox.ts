import {
  eyePosition,
  MAX_CATCHUP_MS,
  type MapData,
  type MovementState,
  spawnState,
  stepMovement,
} from "@web-fps/shared";
import { createControls } from "./controls";
import { createView } from "./scene";

/**
 * The M2 sandbox: one player, one map, no server. It exists to answer "does the movement
 * feel right" without a network round trip in the way of finding out.
 *
 * It deliberately does not share `game.ts`'s loop. That one is shaped by the server — a
 * step is a tick, and what is drawn is a prediction being corrected — and this one is a
 * tuning tool with nothing to be corrected by. What they do share is the view, so the feel
 * being judged is the feel through a match's camera.
 */

/**
 * Fixed simulation step. Deliberately faster than the 20 Hz server tick: the sandbox has no
 * interpolation, so stepping at the server's rate would have us judging the movement
 * through a stutter that a match's interpolation removes. What is being tuned here is the
 * physics, not the tick rate — `stepMovement` takes its dt, so the server drives the same
 * code at 20 Hz without either side changing.
 */
const STEP_MS = 1000 / 60;

export function startSandbox(canvas: HTMLCanvasElement, map: MapData): () => void {
  const spawn = map.spawns[0];
  if (!spawn) throw new Error(`map ${map.name} has no spawn points`);

  const view = createView(canvas, map);
  const controls = createControls(canvas, spawn.yaw);
  let state: MovementState = spawnState(spawn);

  let previous: number | null = null;
  let pending = 0;

  view.renderer.setAnimationLoop((now) => {
    pending = Math.min(pending + (previous === null ? 0 : now - previous), MAX_CATCHUP_MS);
    previous = now;

    const look = controls.look();
    while (pending >= STEP_MS) {
      state = stepMovement(state, controls.keys(), look.yaw, STEP_MS, map);
      pending -= STEP_MS;
    }

    const eye = eyePosition(state.position);
    view.camera.position.set(eye.x, eye.y, eye.z);
    view.camera.rotation.set(look.pitch, look.yaw, 0);
    view.renderer.render(view.scene, view.camera);
  });

  return () => {
    controls.dispose();
    view.dispose();
  };
}
