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

module.exports = { panelSize, MAX_W, MIN_W, MAX_SHADE, MIN_SHADE };
