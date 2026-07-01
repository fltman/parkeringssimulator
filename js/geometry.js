/* geometry.js — small 2D geometry toolkit (world units = feet, y points down)
 * Exposed on the global PS namespace so the app runs from file:// with plain <script> tags. */
(function () {
  const PS = (window.PS = window.PS || {});

  const geom = {
    // Signed polygon area via the shoelace formula; abs() = area.
    area(poly) {
      let a = 0;
      for (let i = 0, n = poly.length; i < n; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a) / 2;
    },

    // Ray-casting point-in-polygon. pt = [x, y].
    pointInPolygon(pt, poly) {
      const x = pt[0];
      const y = pt[1];
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect =
          yi > y !== yj > y &&
          x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    },

    // Shortest distance from point p to segment a-b.
    distPointToSegment(p, a, b) {
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const wx = p[0] - a[0];
      const wy = p[1] - a[1];
      const len2 = vx * vx + vy * vy;
      let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const dx = a[0] + t * vx - p[0];
      const dy = a[1] + t * vy - p[1];
      return Math.hypot(dx, dy);
    },

    // Shortest distance from a point to the polygon boundary (any edge).
    distToBoundary(pt, poly) {
      let min = Infinity;
      for (let i = 0, n = poly.length; i < n; i++) {
        const d = geom.distPointToSegment(pt, poly[i], poly[(i + 1) % n]);
        if (d < min) min = d;
      }
      return min;
    },

    // Axis-aligned bounding box of a polygon -> {minX,minY,maxX,maxY,w,h}.
    bbox(poly) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of poly) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
      return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    },

    // AABB of an arbitrary set of points (e.g. a rotated stall parallelogram).
    pointsBBox(pts) {
      return geom.bbox(pts);
    },

    // Overlap test between two AABBs, each {minX,minY,maxX,maxY}. `pad` inflates b.
    aabbOverlap(a, b, pad = 0) {
      return (
        a.minX < b.maxX + pad &&
        a.maxX > b.minX - pad &&
        a.minY < b.maxY + pad &&
        a.maxY > b.minY - pad
      );
    },

    // Rectangle {x,y,w,h} -> {minX,minY,maxX,maxY} corner box.
    rectToBox(r) {
      return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
    },

    rectContains(r, x, y) {
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    },

    // Is (px,py) inside a rectangle centred at (cx,cy), size w x h, rotated by
    // rotDeg degrees, expanded by pad? (Unrotates the point into local frame.)
    pointInRect(px, py, cx, cy, w, h, rotDeg, pad) {
      const rot = -(rotDeg || 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
      const dx = px - cx, dy = py - cy;
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      const p = pad || 0;
      return Math.abs(lx) <= w / 2 + p && Math.abs(ly) <= h / 2 + p;
    },

    // A building's 4 corners (or edge midpoints) in world, honouring rotation.
    rectPoints(cx, cy, w, h, rotDeg, mids) {
      const rot = (rotDeg || 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
      const hw = w / 2, hh = h / 2;
      const local = mids
        ? [[0, -hh], [0, hh], [-hw, 0], [hw, 0]]
        : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      return local.map((p) => [cx + p[0] * c - p[1] * s, cy + p[0] * s + p[1] * c]);
    },

    // Centroid of a polygon (area-weighted).
    centroid(poly) {
      let cx = 0, cy = 0, a = 0;
      for (let i = 0, n = poly.length; i < n; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % n];
        const cross = p[0] * q[1] - q[0] * p[1];
        a += cross;
        cx += (p[0] + q[0]) * cross;
        cy += (p[1] + q[1]) * cross;
      }
      if (a === 0) {
        // Degenerate — fall back to vertex average.
        const avg = poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
        return [avg[0] / poly.length, avg[1] / poly.length];
      }
      a *= 0.5;
      return [cx / (6 * a), cy / (6 * a)];
    },

    clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    },

    // Do segments a-b and c-d intersect? (proper + collinear-overlap). Used for
    // pedestrian/vehicle conflict-point detection and cross-aisle validation.
    segIntersect(a, b, c, d) {
      function ori(p, q, r) {
        const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
        return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
      }
      function onSeg(p, q, r) {
        return (
          Math.min(p[0], r[0]) - 1e-9 <= q[0] && q[0] <= Math.max(p[0], r[0]) + 1e-9 &&
          Math.min(p[1], r[1]) - 1e-9 <= q[1] && q[1] <= Math.max(p[1], r[1]) + 1e-9
        );
      }
      const o1 = ori(a, b, c), o2 = ori(a, b, d), o3 = ori(c, d, a), o4 = ori(c, d, b);
      if (o1 !== o2 && o3 !== o4) return true;
      if (o1 === 0 && onSeg(a, c, b)) return true;
      if (o2 === 0 && onSeg(a, d, b)) return true;
      if (o3 === 0 && onSeg(c, a, d)) return true;
      if (o4 === 0 && onSeg(c, b, d)) return true;
      return false;
    },

    // Intersection point of two lines (through a-b and c-d). Null if parallel.
    lineIntersect(a, b, c, d) {
      const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
      const x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) < 1e-9) return null;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    },
  };

  PS.geom = geom;
})();
