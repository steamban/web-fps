import { type InputKeys, type WeaponSlot, wrapAngle } from "@web-fps/shared";

/**
 * Keyboard and mouse for a player standing in the world: WASD by physical key position,
 * space to jump, and a look direction driven by pointer lock.
 *
 * The angles follow the movement convention (`@web-fps/shared`): yaw 0 faces -z, so
 * turning right lowers yaw, and pitch is positive looking up.
 */

export interface Look {
  readonly yaw: number;
  readonly pitch: number;
}

/** Radians of turn per pixel of mouse travel. */
export const MOUSE_SENSITIVITY = 0.0022;

/** Straight up and straight down, which is also the bound the wire protocol enforces. */
const MAX_PITCH = Math.PI / 2;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

export function applyLook(look: Look, movementX: number, movementY: number): Look {
  return {
    // Folded every step, so a long session cannot drift yaw somewhere precision shows.
    yaw: wrapAngle(look.yaw - movementX * MOUSE_SENSITIVITY),
    pitch: clamp(look.pitch - movementY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH),
  };
}

/** Keys are read by position, not by letter, so the layout the player types in is irrelevant. */
const KEY_FIELDS: Readonly<Record<string, keyof InputKeys>> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
};

export function keyField(code: string): keyof InputKeys | null {
  return KEY_FIELDS[code] ?? null;
}

/** Weapons are selected the same way: by position, so the digit row means the same thing
 *  on every layout. Which weapon is carried is purely local — it rides on each input
 *  frame, so the server needs no equip message and no equipped state to keep in step. */
const SLOT_KEYS: Readonly<Record<string, WeaponSlot>> = {
  Digit1: "primary",
  Digit2: "secondary",
  Digit3: "melee",
};

export function slotKey(code: string): WeaponSlot | null {
  return SLOT_KEYS[code] ?? null;
}

export interface Controls {
  /**
   * What is held right now, plus a jump that was pressed and released since the last
   * call. Reading consumes that latch, so each tap is reported to exactly one step.
   * Writing to the result changes nothing.
   */
  keys(): InputKeys;
  look(): Look;
  /**
   * The weapon this step fired, or null if the trigger was not pulled. Held or tapped, and
   * consumed by the read, exactly like the jump above — a click inside one 50 ms step is
   * invisible in the held state, and a shot swallowed is worse than a jump swallowed.
   */
  fire(): WeaponSlot | null;
  dispose(): void;
}

const NOTHING_HELD: InputKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
};

export function createControls(canvas: HTMLElement, startYaw: number): Controls {
  let held: InputKeys = { ...NOTHING_HELD };
  let look: Look = { yaw: startYaw, pitch: 0 };
  /**
   * A jump pressed and released inside one step, which at the server's 20 Hz tick is a
   * 40 ms tap — well within what a player actually does. Sampling the held state alone
   * would see nothing at either boundary and swallow the jump. Only jump is latched:
   * doing the same to WASD would turn a tap into a whole step of travel.
   */
  let tappedJump = false;

  let slot: WeaponSlot = "primary";
  let triggerHeld = false;
  let tappedTrigger = false;

  const setKey = (event: KeyboardEvent, down: boolean): void => {
    const field = keyField(event.code);
    if (field === null) return;
    held[field] = down;
    if (down && field === "jump") tappedJump = true;
    // Space scrolls the page otherwise, which drags the canvas out from under the player.
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const weapon = slotKey(event.code);
    if (weapon !== null) {
      slot = weapon;
      return;
    }
    setKey(event, true);
  };
  const onKeyUp = (event: KeyboardEvent): void => setKey(event, false);

  // A key let go while the window is in the background never reports its keyup, so coming
  // back would find the player still walking.
  const onBlur = (): void => {
    held = { ...NOTHING_HELD };
    tappedJump = false;
    triggerHeld = false;
    tappedTrigger = false;
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== canvas) return;
    look = applyLook(look, event.movementX, event.movementY);
  };

  const onClick = (): void => {
    if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
  };

  /**
   * On the canvas, and only while the mouse is captured: the click that takes pointer lock
   * must not also discharge a round, and the host's Pause and Close sit over the view — a
   * window-level trigger would fire every time the host reached for them.
   */
  const onMouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement !== canvas || event.button !== 0) return;
    triggerHeld = true;
    tappedTrigger = true;
  };

  // Released from the window, though: a mouseup the canvas never sees would leave the
  // trigger held down for the rest of the match.
  const onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) triggerHeld = false;
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousedown", onMouseDown);

  return {
    keys: () => {
      const sample = { ...held, jump: held.jump || tappedJump };
      tappedJump = false;
      return sample;
    },
    look: () => look,
    fire: () => {
      // The mouse can be handed back in the middle of a hold — Esc releases pointer lock
      // and no mouseup ever arrives — so the capture is rechecked here rather than trusted
      // from the press. Recapturing takes a fresh click, like the first one did.
      if (document.pointerLockElement !== canvas) {
        triggerHeld = false;
        tappedTrigger = false;
        return null;
      }
      const pulled = triggerHeld || tappedTrigger;
      tappedTrigger = false;
      return pulled ? slot : null;
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousedown", onMouseDown);
    },
  };
}
