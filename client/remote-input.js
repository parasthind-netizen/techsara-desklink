// Remote input pipeline: dashboard → WebRTC data channel → here → OS.
//
// Coordinates arrive normalised (0..1) over the captured picture and are mapped
// onto the captured display's PHYSICAL (device-pixel) bounds in virtual-screen
// space — what libnut's SendInput expects from this DPI-aware process.
// Electron's dipToScreenRect does the DIP→pixel conversion per display, so
// Windows scaling (100/125/150/200%), secondary monitors with non-zero origins
// and mixed-DPI setups resolve with no hard-coded sizes. The display is
// re-resolved on every event, so a resolution change mid-session (RDP client
// resized/reconnected, scaling changed) is picked up live.
//
// Events are applied strictly in order: nut-js button/key calls yield to the
// event loop while moves don't, so concurrent handlers could press a button
// BEFORE an earlier move landed. Consecutive moves collapse to the newest — a
// backlog would make the cursor trail the agent's hand.

const WHEEL_NOTCH_PX = 100;   // one wheel notch, in the pixel units browsers report

function createRemoteInput(deps) {
  const { screen, mouse, keyboard, Button, Point, codeToKey, log } = deps;
  const BUTTONS = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

  let capturedDisplayId = null;      // screen-API id of the display on the wire
  const queue = [];
  let busy = false;
  const heldButtons = new Set();     // pressed on this machine by the remote agent
  const heldKeys    = new Set();
  let wheelAccX = 0, wheelAccY = 0;  // sub-notch wheel remainder (touchpads)

  function setCapturedDisplay(id) { capturedDisplayId = id ? String(id) : null; }

  function capturedDisplay() {
    if (capturedDisplayId) {
      const d = screen.getAllDisplays().find(d => String(d.id) === capturedDisplayId);
      if (d) return d;
    }
    // Display vanished (an RDP reconnect re-creates it) — the capture handler
    // picks the primary, so map onto that.
    return screen.getPrimaryDisplay();
  }

  function physicalBounds(display) {
    // macOS: CoreGraphics (what libnut drives) uses the same global POINT
    // coordinates as Electron's display.bounds — Retina scaleFactor must NOT
    // be applied or every click would land at 2x the intended position.
    if (process.platform === 'darwin') return display.bounds;
    if (typeof screen.dipToScreenRect === 'function') {          // Windows
      try { return screen.dipToScreenRect(null, display.bounds); } catch (_) {}
    }
    const s = display.scaleFactor || 1;                           // Linux/X11
    return {
      x: Math.round(display.bounds.x * s),         y: Math.round(display.bounds.y * s),
      width: Math.round(display.bounds.width * s), height: Math.round(display.bounds.height * s)
    };
  }

  const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

  // floor() maps 0..1 onto pixel indices 0..size-1 exactly (1.0 → last pixel).
  function toPhysical(nx, ny) {
    const b = physicalBounds(capturedDisplay());
    return {
      x: b.x + Math.min(b.width  - 1, Math.floor(clamp01(nx) * b.width)),
      y: b.y + Math.min(b.height - 1, Math.floor(clamp01(ny) * b.height))
    };
  }

  async function moveTo(nx, ny) {
    const p = toPhysical(nx, ny);
    await mouse.setPosition(new Point(p.x, p.y));
  }

  const hasPos = (i) => Number.isFinite(i.x) && Number.isFinite(i.y);

  async function apply(input) {
    switch (input.type) {
      case 'mousemove':
        return moveTo(input.x, input.y);

      case 'mousedown': {
        const btn = BUTTONS[input.button] || Button.LEFT;
        // The click carries its own position so it lands exactly where the
        // agent sees their pointer, even if the move before it was coalesced.
        if (hasPos(input)) await moveTo(input.x, input.y);
        heldButtons.add(btn);
        return mouse.pressButton(btn);
      }
      case 'mouseup': {
        const btn = BUTTONS[input.button] || Button.LEFT;
        if (hasPos(input)) await moveTo(input.x, input.y);   // drop point of a drag
        heldButtons.delete(btn);
        return mouse.releaseButton(btn);
      }
      case 'scroll': {
        // Accumulate and emit whole notches: a trackpad flick is dozens of
        // tiny deltas, which must not become a notch each.
        wheelAccY += Number(input.deltaY) || 0;
        wheelAccX += Number(input.deltaX) || 0;
        const ny = Math.trunc(wheelAccY / WHEEL_NOTCH_PX), nx = Math.trunc(wheelAccX / WHEEL_NOTCH_PX);
        wheelAccY -= ny * WHEEL_NOTCH_PX; wheelAccX -= nx * WHEEL_NOTCH_PX;
        if (ny > 0) await mouse.scrollDown(ny); else if (ny < 0) await mouse.scrollUp(-ny);
        if (nx > 0) await mouse.scrollRight(nx); else if (nx < 0) await mouse.scrollLeft(-nx);
        return;
      }
      case 'keydown': {
        const key = codeToKey[input.code];
        if (key === undefined) return;
        heldKeys.add(key);
        return keyboard.pressKey(key);
      }
      case 'keyup': {
        const key = codeToKey[input.code];
        if (key === undefined) return;
        heldKeys.delete(key);
        return keyboard.releaseKey(key);
      }
      case 'release_all': {
        for (const b of heldButtons) { try { await mouse.releaseButton(b); } catch (_) {} }
        for (const k of heldKeys)    { try { await keyboard.releaseKey(k); } catch (_) {} }
        heldButtons.clear(); heldKeys.clear();
        wheelAccX = wheelAccY = 0;
        return;
      }
    }
  }

  function enqueue(input) {
    if (!input || typeof input.type !== 'string') return;
    const last = queue[queue.length - 1];
    if (input.type === 'mousemove' && last && last.type === 'mousemove') queue[queue.length - 1] = input;
    else queue.push(input);
    if (!busy) drain();
  }

  async function drain() {
    busy = true;
    while (queue.length) {
      const input = queue.shift();
      try { await apply(input); }
      catch (e) { log('Input error: ' + (e && e.message)); }
    }
    busy = false;
  }

  // Session over (agent tab closed, link dropped mid-drag): discard whatever it
  // still had queued and let go of anything it left held down on this machine.
  function releaseAll() {
    queue.length = 0;
    enqueue({ type: 'release_all' });
  }

  // Resolves once every queued event has been applied (tests / diagnostics).
  function idle() {
    return new Promise((resolve) => {
      const tick = () => (busy || queue.length) ? setTimeout(tick, 5) : resolve();
      tick();
    });
  }

  return {
    enqueue, releaseAll, setCapturedDisplay, idle,
    capturedDisplay, physicalBounds, toPhysical,
    held: () => ({ buttons: [...heldButtons], keys: [...heldKeys] })
  };
}

module.exports = { createRemoteInput, WHEEL_NOTCH_PX };
