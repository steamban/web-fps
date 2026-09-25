// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLook,
  type Controls,
  createControls,
  keyField,
  MOUSE_SENSITIVITY,
  slotKey,
} from "./controls";

/**
 * Keyboard and mouse handling for the sandbox. The angle maths is pure and covered
 * directly; the listener wiring is covered through real events, because the bugs it has
 * are keys that stick and a mouse that turns the view when it should not.
 */

let controls: Controls | null = null;

const canvas = (): HTMLElement => {
  const node = document.createElement("canvas");
  document.body.append(node);
  return node;
};

const lockTo = (element: HTMLElement | null): void => {
  Object.defineProperty(document, "pointerLockElement", { value: element, configurable: true });
};

const press = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, cancelable: true }));
};
const release = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code, cancelable: true }));
};
const moveMouse = (movementX: number, movementY: number): void => {
  window.dispatchEvent(new MouseEvent("mousemove", { movementX, movementY }));
};

const pressMouse = (on: EventTarget, button = 0): void => {
  on.dispatchEvent(new MouseEvent("mousedown", { button, bubbles: true }));
};
const releaseMouse = (button = 0): void => {
  window.dispatchEvent(new MouseEvent("mouseup", { button }));
};

afterEach(() => {
  controls?.dispose();
  controls = null;
  document.body.innerHTML = "";
  lockTo(null);
});

describe("applyLook", () => {
  const level = { yaw: 0, pitch: 0 };

  it("turns right when the mouse goes right", () => {
    // Yaw 0 faces -z and forward is (-sin yaw, -cos yaw), so turning right lowers yaw.
    expect(applyLook(level, 10, 0).yaw).toBeCloseTo(-10 * MOUSE_SENSITIVITY);
  });

  it("looks down when the mouse goes down", () => {
    expect(applyLook(level, 0, 10).pitch).toBeCloseTo(-10 * MOUSE_SENSITIVITY);
  });

  it("cannot look further than straight up or straight down", () => {
    expect(applyLook(level, 0, -100_000).pitch).toBeCloseTo(Math.PI / 2);
    expect(applyLook(level, 0, 100_000).pitch).toBeCloseTo(-Math.PI / 2);
  });

  it("keeps yaw wrapped however far the mouse travels", () => {
    let look = level;
    for (let sweep = 0; sweep < 50; sweep += 1) look = applyLook(look, 1000, 0);
    expect(look.yaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(look.yaw).toBeLessThan(Math.PI);
  });

  it("comes back to where it started after a full turn", () => {
    const full = applyLook(level, -(2 * Math.PI) / MOUSE_SENSITIVITY, 0);
    expect(Math.sin(full.yaw)).toBeCloseTo(0);
    expect(Math.cos(full.yaw)).toBeCloseTo(1);
  });
});

describe("keyField", () => {
  it("maps the movement keys by physical position", () => {
    expect(keyField("KeyW")).toBe("forward");
    expect(keyField("KeyS")).toBe("back");
    expect(keyField("KeyA")).toBe("left");
    expect(keyField("KeyD")).toBe("right");
    expect(keyField("Space")).toBe("jump");
  });

  it("ignores everything else", () => {
    expect(keyField("KeyQ")).toBeNull();
    expect(keyField("F5")).toBeNull();
  });
});

describe("slotKey", () => {
  it("maps the weapon keys by physical position, like the movement keys", () => {
    expect(slotKey("Digit1")).toBe("primary");
    expect(slotKey("Digit2")).toBe("secondary");
    expect(slotKey("Digit3")).toBe("melee");
    expect(slotKey("Digit4")).toBeNull();
    expect(slotKey("KeyW")).toBeNull();
  });
});

describe("createControls", () => {
  it("starts with nothing held, facing the way it was told to", () => {
    controls = createControls(canvas(), 1.25);
    expect(controls.keys()).toEqual({
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
    });
    expect(controls.look()).toEqual({ yaw: 1.25, pitch: 0 });
  });

  it("holds a key down until it is released", () => {
    controls = createControls(canvas(), 0);
    press("KeyW");
    expect(controls.keys().forward).toBe(true);
    release("KeyW");
    expect(controls.keys().forward).toBe(false);
  });

  it("swallows the keys it uses so the page does not scroll", () => {
    controls = createControls(canvas(), 0);
    const jump = new KeyboardEvent("keydown", { code: "Space", cancelable: true });
    const other = new KeyboardEvent("keydown", { code: "KeyQ", cancelable: true });
    window.dispatchEvent(jump);
    window.dispatchEvent(other);
    expect(jump.defaultPrevented).toBe(true);
    expect(other.defaultPrevented).toBe(false);
  });

  it("reports a jump tapped and released between two samples", () => {
    // The match samples at the server's tick — 50 ms — so a tap that starts and ends
    // between two samples is invisible in the held state, and the jump never happens.
    controls = createControls(canvas(), 0);
    press("Space");
    release("Space");

    expect(controls.keys().jump).toBe(true);
    // Consumed by that read, so one tap cannot become two jumps.
    expect(controls.keys().jump).toBe(false);
  });

  it("does not latch the movement keys, only jump", () => {
    // Latching a direction would turn a tap into a whole step of travel.
    controls = createControls(canvas(), 0);
    press("KeyW");
    release("KeyW");
    expect(controls.keys().forward).toBe(false);
  });

  it("drops every held key when the window loses focus", () => {
    controls = createControls(canvas(), 0);
    press("KeyW");
    press("KeyD");
    press("Space");
    window.dispatchEvent(new Event("blur"));
    expect(controls.keys()).toMatchObject({ forward: false, right: false, jump: false });
  });

  it("turns the view only while the pointer is locked to the canvas", () => {
    const target = canvas();
    controls = createControls(target, 0);

    moveMouse(50, 0);
    expect(controls.look().yaw).toBe(0);

    lockTo(target);
    moveMouse(50, 0);
    expect(controls.look().yaw).toBeCloseTo(-50 * MOUSE_SENSITIVITY);
  });

  it("stops listening once disposed", () => {
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);
    controls.dispose();

    press("KeyW");
    moveMouse(50, 0);
    expect(controls.keys().forward).toBe(false);
    expect(controls.look().yaw).toBe(0);
  });

  it("does not fire the click that captures the mouse", () => {
    // The first click on the view is how pointer lock is taken. Firing on it would mean a
    // round spent every time a player comes back from the escape key.
    const target = canvas();
    controls = createControls(target, 0);

    pressMouse(target);
    expect(controls.fire()).toBeNull();
  });

  it("fires for as long as the trigger is held", () => {
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    pressMouse(target);
    expect(controls.fire()).toBe("primary");
    // Automatic: the server's cooldown decides the rate, not the player's clicking.
    expect(controls.fire()).toBe("primary");
    releaseMouse();
    expect(controls.fire()).toBeNull();
  });

  it("reports a trigger tapped and released between two samples, once", () => {
    // A click inside one 50 ms step is invisible in the held state — the same reason jump
    // is latched — and a shot swallowed is worse than a jump swallowed.
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    pressMouse(target);
    releaseMouse();
    expect(controls.fire()).toBe("primary");
    expect(controls.fire()).toBeNull();
  });

  it("ignores a click that is not the trigger, and one that is not on the view", () => {
    // The host's Pause and Close sit over the game view; a window-level trigger would fire
    // a round every time the host reached for them.
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    pressMouse(target, 2);
    expect(controls.fire()).toBeNull();
    pressMouse(document.body);
    expect(controls.fire()).toBeNull();
  });

  it("releases the trigger when the window loses focus", () => {
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    pressMouse(target);
    window.dispatchEvent(new Event("blur"));
    expect(controls.fire()).toBeNull();
  });

  it("stops firing when the mouse is handed back in the middle of a hold", () => {
    // Esc releases pointer lock without ever sending a mouseup, so a held trigger would
    // keep the gun going while the player clicks around the page — including on the host's
    // Pause and Close.
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    pressMouse(target);
    expect(controls.fire()).toBe("primary");

    lockTo(null);
    expect(controls.fire()).toBeNull();
    // And it does not pick up again when the mouse is recaptured without a fresh click.
    lockTo(target);
    expect(controls.fire()).toBeNull();
  });

  it("fires whichever weapon was last selected", () => {
    const target = canvas();
    controls = createControls(target, 0);
    lockTo(target);

    press("Digit3");
    pressMouse(target);
    expect(controls.fire()).toBe("melee");

    press("Digit2");
    expect(controls.fire()).toBe("secondary");
  });

  it("hands out a snapshot a caller cannot write back through", () => {
    controls = createControls(canvas(), 0);
    controls.keys().forward = true;
    expect(controls.keys().forward).toBe(false);
  });
});
