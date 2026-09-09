'use strict';

// Comfortable on a wide desktop, still usable on a small laptop.
const MAX_W = 980;
const MIN_W = 560;
const SIDE_GAP = 80; // breathing room so the panel never touches both edges

const MAX_SHADE = 288;
const MIN_SHADE = 210;
const SHADOW_ROOM = 68; // room under the shade for its drop shadow to fade out

/**
 * Panel size for a given work area.
 *
 * Bounds are in device-independent pixels, so a display running at 150% reports
 * a work area a third narrower than its panel says — the size has to be
 * measured against that rather than assumed from a desktop-sized screen.
 */
function panelSize(area) {
  const availW = Math.max(0, (area && area.width) || 0);
  const availH = Math.max(0, (area && area.height) || 0);

  const width = Math.round(Math.max(MIN_W, Math.min(MAX_W, availW - SIDE_GAP)));
  const shade = Math.round(Math.max(MIN_SHADE, Math.min(MAX_SHADE, availH - 120)));

  // On a very short screen the shadow room is what gives way first, and the
  // window still must not be taller than the space it sits in.
  const height = Math.min(shade + SHADOW_ROOM, Math.max(shade, availH));

  return { width, shade, height };
}

/**
 * Where the strip sits along the top of a work area, from a remembered share
 * of the room it has to move in.
 *
 * The strip is dragged in screen coordinates but remembered as a fraction: a
 * monitor unplugged, resized or rescaled would otherwise leave the widget
 * parked off the edge of whatever is left. 0 is hard left, 1 hard right, and
 * anything missing means the middle — where it has always started.
 */
function slotX(area, width, fraction) {
  const left = (area && area.x) || 0;
  const span = Math.max(0, ((area && area.width) || 0) - width);
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0.5;
  return Math.round(left + span * f);
}

/** The reverse: the share a screen position lands on, kept inside the area. */
function slotFraction(area, width, x) {
  const left = (area && area.x) || 0;
  const span = Math.max(0, ((area && area.width) || 0) - width);
  if (span <= 0) return 0.5; // nowhere to go: the panel fills the width
  const clamped = Math.max(left, Math.min(left + span, x));
  return (clamped - left) / span;
}

module.exports = { panelSize, slotX, slotFraction, MAX_W, MIN_W, MAX_SHADE, MIN_SHADE };
