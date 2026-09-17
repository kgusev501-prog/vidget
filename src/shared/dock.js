'use strict';

const { panelSize } = require('./panel-size');

/**
 * Where the widget sits on a screen, and what that means for its window.
 *
 * The strip can live on any of the four edges of a work area and slide along
 * it right up to the corners. Everything the main process needs follows from
 * two numbers — which edge, and how far along it — so it is worked out here,
 * away from Electron, where it can be tested.
 *
 * The window itself is larger than anything visible: it must hold the open
 * panel wherever it slides out, plus room for its shadow, and on a side edge
 * the tall karaoke plate as well. It never leaves the work area. The strip
 * moves inside it, which is what lets the strip reach a corner even though the
 * window, as wide as the panel, cannot.
 */

const EDGES = ['top', 'bottom', 'left', 'right'];

// The strip's grab zone: its length along the edge and how far it reaches in.
const HANDLE_LEN = 260;
const HANDLE_DEPTH = 30;

// Room beside the panel for its shadow to fade out.
const SHADOW_ROOM = 68;

// Room on the sides of the panel that do not touch the screen edge. The shadow
// has to fade to nothing inside the window: a transparent window clips it at
// its own border, and a window exactly as wide as the panel cut the shadow off
// in hard vertical lines on either side.
const SHADOW = 48;

// On a side edge everything turns portrait. The words become a karaoke plate —
// wide enough for a line to fit, as tall as the top plate is wide — and the
// panel opens in the same footprint, laid out like a phone screen: a panel as
// wide as a monitor sliding out of its side would cover half the desk.
const KARAOKE_W = 420;
const KARAOKE_H = 594;
const KARAOKE_MARGIN = SHADOW;

const isSide = (edge) => edge === 'left' || edge === 'right';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fraction = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);

/**
 * A remembered placement, made safe.
 *
 * Builds before this one stored only `x`, the share along the top edge, and
 * that is read as exactly that. Anything missing or broken means the middle
 * of the top edge, where the widget has always started.
 */
function normalizePlacement(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const edge = EDGES.includes(s.edge) ? s.edge : 'top';
  const along = s.along != null ? Number(s.along) : s.x != null ? Number(s.x) : NaN;
  const display = s.display == null || !Number.isFinite(Number(s.display)) ? null : Number(s.display);
  return { display, edge, along: fraction(along) };
}

/** The stretch of the edge the strip's centre can travel along, in screen terms. */
function track(area, edge) {
  const start = isSide(edge) ? area.y : area.x;
  const length = isSide(edge) ? area.height : area.width;
  const half = Math.min(HANDLE_LEN / 2, length / 2);
  return { from: start + half, to: start + length - half };
}

/** Screen coordinate of the strip's centre along its edge. */
function centreAlong(area, edge, along) {
  const t = track(area, edge);
  return Math.round(t.from + (t.to - t.from) * fraction(along));
}

/** The reverse: the share of the track a screen coordinate falls on. */
function alongFor(area, edge, coordinate) {
  const t = track(area, edge);
  if (t.to <= t.from) return 0.5;
  return (clamp(coordinate, t.from, t.to) - t.from) / (t.to - t.from);
}

/** How far the panel sits in from the window sides, leaving room for its shadow. */
function inset(bounds, size) {
  return Math.max(0, Math.round((bounds.width - Math.min(size.width, bounds.width)) / 2));
}

/** How tall the karaoke plate can be on this screen. */
function karaokeHeight(area) {
  return Math.max(0, Math.min(KARAOKE_H, area.height - KARAOKE_MARGIN * 2));
}

/**
 * The window, the strip within it and the rectangle the panel slides into.
 *
 * @param {{x:number,y:number,width:number,height:number}} area work area
 * @param {{edge?:string, along?:number}} placement
 */
function dockLayout(area, placement) {
  const { edge, along } = normalizePlacement(placement);
  const size = panelSize(area);
  const centre = centreAlong(area, edge, along);
  const right = area.x + area.width;
  const bottom = area.y + area.height;

  let bounds;
  if (!isSide(edge)) {
    const width = Math.min(area.width, size.width + SHADOW * 2);
    const height = size.height;
    bounds = {
      x: Math.round(clamp(centre - width / 2, area.x, right - width)),
      y: edge === 'top' ? area.y : bottom - height,
      width,
      height,
    };
  } else {
    const width = Math.min(area.width, KARAOKE_W + SHADOW_ROOM);
    const height = Math.min(area.height, karaokeHeight(area) + KARAOKE_MARGIN * 2);
    bounds = {
      x: edge === 'left' ? area.x : right - width,
      y: Math.round(clamp(centre - height / 2, area.y, bottom - height)),
      width,
      height,
    };
  }

  // Everything below is relative to the window.
  let handle;
  let panel;
  if (edge === 'top') {
    handle = { x: centre - bounds.x, y: 0 };
    panel = { x: inset(bounds, size), y: 0, width: Math.min(size.width, bounds.width), height: size.shade };
  } else if (edge === 'bottom') {
    handle = { x: centre - bounds.x, y: bounds.height };
    panel = { x: inset(bounds, size), y: bounds.height - size.shade, width: Math.min(size.width, bounds.width), height: size.shade };
  } else {
    handle = { x: edge === 'left' ? 0 : bounds.width, y: centre - bounds.y };
    const phone = { width: Math.min(KARAOKE_W, bounds.width), height: karaokeHeight(area) };
    // Kept off the window's top and bottom so the rounded corners and the
    // shadow survive when the strip sits right at the end of the edge.
    const margin = Math.max(0, Math.min(KARAOKE_MARGIN, (bounds.height - phone.height) / 2));
    const top = Math.round(clamp(handle.y - phone.height / 2, margin, bounds.height - phone.height - margin));
    panel = {
      x: edge === 'left' ? 0 : bounds.width - phone.width,
      y: Math.max(0, top),
      width: phone.width,
      height: phone.height,
    };
  }

  return {
    edge,
    along: fraction(along),
    bounds,
    handle,
    panel,
    size,
    karaoke: { width: KARAOKE_W, height: karaokeHeight(area) },
  };
}

/** The default grab zone for a layout, in screen coordinates. */
function defaultGrab(layout) {
  const { edge, bounds, handle } = layout;
  if (isSide(edge)) {
    return {
      x: edge === 'left' ? bounds.x : bounds.x + bounds.width - HANDLE_DEPTH,
      y: bounds.y + handle.y - HANDLE_LEN / 2,
      width: HANDLE_DEPTH,
      height: HANDLE_LEN,
    };
  }
  return {
    x: bounds.x + handle.x - HANDLE_LEN / 2,
    y: edge === 'top' ? bounds.y : bounds.y + bounds.height - HANDLE_DEPTH,
    width: HANDLE_LEN,
    height: HANDLE_DEPTH,
  };
}

/** Which edge of the area a point is closest to — where a dragged strip lands. */
function nearestEdge(area, point) {
  const d = {
    top: Math.abs(point.y - area.y),
    bottom: Math.abs(area.y + area.height - point.y),
    left: Math.abs(point.x - area.x),
    right: Math.abs(area.x + area.width - point.x),
  };
  // Ties go to top and bottom: the panel reads best horizontal.
  return EDGES.reduce((best, edge) => (d[edge] < d[best] ? edge : best), 'top');
}

/** Where a strip dragged by a point on the screen ends up. */
function placeAt(area, point, grabOffset = 0) {
  const edge = nearestEdge(area, point);
  const coordinate = (isSide(edge) ? point.y : point.x) - grabOffset;
  return { edge, along: alongFor(area, edge, coordinate) };
}

module.exports = {
  EDGES,
  SHADOW,
  HANDLE_LEN,
  HANDLE_DEPTH,
  KARAOKE_W,
  KARAOKE_H,
  isSide,
  normalizePlacement,
  centreAlong,
  alongFor,
  karaokeHeight,
  dockLayout,
  defaultGrab,
  nearestEdge,
  placeAt,
};
