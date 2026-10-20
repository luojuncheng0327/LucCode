"use strict";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeArea(display) {
  const area = display?.workArea || display?.bounds || display;
  if (!area) return null;
  const x = finiteNumber(area.x) ? area.x : 0;
  const y = finiteNumber(area.y) ? area.y : 0;
  const width = finiteNumber(area.width) && area.width > 0 ? area.width : 0;
  const height = finiteNumber(area.height) && area.height > 0 ? area.height : 0;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function intersection(rect, area) {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function hasVisibleIntersection(rect, areas, minVisibleWidth, minVisibleHeight) {
  return areas.some((area) => {
    const hit = intersection(rect, area);
    return hit.width >= minVisibleWidth && hit.height >= minVisibleHeight;
  });
}

function centerInArea(width, height, area) {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

function virtualAreaFor(areas) {
  if (!areas.length) return null;
  const left = Math.min(...areas.map((area) => area.x));
  const top = Math.min(...areas.map((area) => area.y));
  const right = Math.max(...areas.map((area) => area.x + area.width));
  const bottom = Math.max(...areas.map((area) => area.y + area.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function boundedSize(value, defaultValue, minValue, maxValue) {
  const normalized = finiteNumber(value) && value > 0 ? Math.round(value) : defaultValue;
  return clamp(normalized, Math.min(minValue, maxValue), maxValue);
}

function sanitizeWindowState(state, displays, options = {}) {
  if (!state || typeof state !== "object") return null;

  const defaultWidth = options.defaultWidth ?? 960;
  const defaultHeight = options.defaultHeight ?? 820;
  const minWidth = options.minWidth ?? 420;
  const minHeight = options.minHeight ?? 500;
  const minVisibleWidth = options.minVisibleWidth ?? 80;
  const minVisibleHeight = options.minVisibleHeight ?? 60;

  const areas = (Array.isArray(displays) ? displays : [])
    .map(normalizeArea)
    .filter(Boolean);
  const primaryArea = areas[0] || { x: 0, y: 0, width: defaultWidth, height: defaultHeight };
  const visibleAreas = areas.length ? areas : [primaryArea];
  const virtualArea = virtualAreaFor(visibleAreas) || primaryArea;
  const savedWidth = boundedSize(state.width, defaultWidth, minWidth, virtualArea.width);
  const savedHeight = boundedSize(state.height, defaultHeight, minHeight, virtualArea.height);

  const hasPosition = finiteNumber(state.x) && finiteNumber(state.y);
  if (hasPosition) {
    const candidate = {
      x: Math.round(state.x),
      y: Math.round(state.y),
      width: savedWidth,
      height: savedHeight,
    };

    if (hasVisibleIntersection(candidate, visibleAreas, minVisibleWidth, minVisibleHeight)) {
      return {
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        isMaximized: state.isMaximized === true,
      };
    }
  }

  const recenteredWidth = boundedSize(state.width, defaultWidth, minWidth, primaryArea.width);
  const recenteredHeight = boundedSize(state.height, defaultHeight, minHeight, primaryArea.height);
  const position = centerInArea(recenteredWidth, recenteredHeight, primaryArea);

  return {
    x: position.x,
    y: position.y,
    width: recenteredWidth,
    height: recenteredHeight,
    isMaximized: state.isMaximized === true,
  };
}

module.exports = {
  sanitizeWindowState,
};
