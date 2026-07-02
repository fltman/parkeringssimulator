/* parking.js — the parametric parking-lot generator.
 *
 * Fills a site polygon with double-loaded parking bays (two rows of stalls sharing
 * a drive aisle), dropping any stall that would fall outside the site setback or
 * collide with a building. Sprinkles landscape trees. Returns everything the
 * renderer needs plus a stall count — this is the "solver" the video shows.
 *
 * All dimensions are in feet. 90° parking is exact; 60°/45° use the standard
 * module pitch (stallW/sinθ) and vehicle projection (stallD·sinθ + stallW·cosθ)
 * so counts stay realistic, with stalls drawn as sheared parallelograms.
 */
(function () {
  const PS = (window.PS = window.PS || {});
  const g = PS.geom;

  // Does (px,py) hit building b (rect or polygon), expanded by `pad`?
  function buildingHit(px, py, b, pad) {
    if (b.poly && b.poly.length >= 3) return g.polyContains(px, py, b.poly, pad || 0);
    return g.pointInRect(px, py, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0, pad || 0);
  }
  PS.buildingHit = buildingHit;

  PS.defaults = {
    stallW: 2.5,         // stall width (m)
    stallD: 5.0,         // stall depth (m)
    aisleW: 6.5,         // two-way drive aisle (m)
    angle: 90,           // 90 | 60 | 45
    siteSetback: 5,      // keep stalls this far inside the site boundary (m)
    buildingClearance: 6, // gap between stalls and buildings — perimeter drive (m)
    orientation: "h",    // 'h' = aisles run E-W, 'v' = aisles run N-S
    islandEvery: 11,     // insert a landscape island every N stall slots per row
  };

  // Generate the whole lot. Returns { stalls, trees, aisles, count }.
  PS.generateParking = function (site, buildings, opts) {
    const p = Object.assign({}, PS.defaults, opts || {});
    const theta = (p.angle * Math.PI) / 180;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);

    const pitch = p.stallW / sin;                          // spacing along the row
    const rowDepth = p.stallD * sin + p.stallW * cos;      // band depth (vehicle projection)
    const shear = p.angle >= 89.5 ? 0 : rowDepth / Math.tan(theta); // lean of a stall
    const bayH = 2 * rowDepth + p.aisleW;                  // full double-loaded module

    const bb = g.bbox(site);
    const ox = bb.minX;
    const oy = bb.minY;

    // Local (a = along-row, b = across-band) -> world, honouring orientation.
    const horiz = p.orientation !== "v";
    const P = horiz
      ? (a, b) => [ox + a, oy + b]
      : (a, b) => [ox + b, oy + a];

    const alongLen = horiz ? bb.w : bb.h; // how far the rows run
    const bandLen = horiz ? bb.h : bb.w;  // how many bays stack


    // Cross-aisle (connector) positions in world along-coordinate. Stalls are
    // carved away here so cars get real clear lanes across the bays (instead of
    // appearing to drive through parked cars). Shared with the traffic network.
    const alongMinW = horiz ? bb.minX : bb.minY;
    const alongMaxW = horiz ? bb.maxX : bb.maxY;
    const cMin = alongMinW + p.siteSetback;
    const cMax = alongMaxW - p.siteSetback;
    const cspan = Math.max(1, cMax - cMin);
    const Nconn = Math.max(2, Math.min(5, Math.round(cspan / 65) + 1));
    const connectors = [];
    if (!p.noConnectors) for (let j = 0; j < Nconn; j++) connectors.push(cMin + cspan * (j / (Nconn - 1)));
    const carveHalf = p.aisleW * 0.5 + 0.3;
    const alongOf = horiz ? (pt) => pt[0] : (pt) => pt[1];
    function nearConnector(alongVal) {
      for (const c of connectors) if (Math.abs(alongVal - c) < carveHalf) return true;
      return false;
    }

    function stallValid(corners) {
      // Sample the 4 corners + edge midpoints + centre, so a thin site notch or
      // re-entrant vertex passing through the stall body can't slip past a
      // corners-only test on non-convex sites.
      const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
      const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
      const pts = [
        corners[0], corners[1], corners[2], corners[3],
        [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
        [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
        [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
        [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2],
        [cx, cy],
      ];
      for (const c of pts) {
        if (!g.pointInPolygon(c, site)) return false;
        if (g.distToBoundary(c, site) < p.siteSetback) return false;
        for (const b of buildings) {
          if (buildingHit(c[0], c[1], b, p.buildingClearance)) return false;
        }
      }
      return true;
    }

    const stalls = [];
    const trees = [];
    const aisles = [];

    // Build a single row of stalls. `aisleEdge` is the b-coordinate of the open
    // (aisle-facing) end; `dir` = +1 if the stall body extends toward smaller b
    // (aisle below the row) or -1 (aisle above). `lean` shears the back edge.
    function buildRow(aisleEdge, dir, lean, rowIndex) {
      let slot = 0;
      for (let a = 0; a <= alongLen; a += pitch, slot++) {
        const backEdge = aisleEdge + dir * rowDepth; // b of the closed end
        // Parallelogram corners (a, b) — sheared along the row toward the back.
        const c = [
          P(a, aisleEdge),
          P(a + pitch, aisleEdge),
          P(a + pitch + lean, backEdge),
          P(a + lean, backEdge),
        ];

        // Periodic landscape island: skip the stall, plant a tree in the slot.
        if (p.islandEvery > 0 && slot % p.islandEvery === p.islandEvery - 1) {
          const treeR = 2.2;
          const treeB = aisleEdge + dir * (rowDepth * 0.5);
          const center = P(a + pitch * 0.5 + lean * 0.5, treeB);
          if (
            !nearConnector(alongOf(center)) &&
            g.pointInPolygon(center, site) &&
            g.distToBoundary(center, site) >= Math.max(p.siteSetback, treeR) &&
            !buildings.some((b) => buildingHit(center[0], center[1], b, p.buildingClearance + treeR))
          ) {
            trees.push({ x: center[0], y: center[1], r: treeR });
          }
          continue;
        }

        const mid = P(a + pitch * 0.5 + lean * 0.5, aisleEdge + dir * rowDepth * 0.5);
        if (nearConnector(alongOf(mid))) continue; // leave the cross-aisle clear
        if (stallValid(c)) {
          stalls.push({ corners: c, cx: mid[0], cy: mid[1], occupied: false });
        }
      }
    }

    // Drive-aisle centrelines (one per bay) plus the two cross "rails" at the
    // ends that tie the parallel aisles together — the drivable graph a manual
    // section feeds into the traffic network (see buildNetworkManual). Rungs +
    // rails form a connected ladder so any road touching the section links in.
    const aisleLines = [];
    let bayIndex = 0;
    for (let bTop = 0; bTop + bayH <= bandLen + rowDepth; bTop += bayH, bayIndex++) {
      const topAisleEdge = bTop + rowDepth;                 // top row opens downward
      const botAisleEdge = bTop + rowDepth + p.aisleW;      // bottom row opens upward
      buildRow(topAisleEdge, -1, shear, bayIndex * 2);       // top row: body above aisle
      buildRow(botAisleEdge, +1, -shear, bayIndex * 2 + 1);  // bottom row: chevron mirror

      // Record the aisle strip (as a world polygon) for directional dashes.
      const a0 = 0;
      const a1 = alongLen;
      aisles.push({
        poly: [
          P(a0, topAisleEdge),
          P(a1, topAisleEdge),
          P(a1, botAisleEdge),
          P(a0, botAisleEdge),
        ],
        horiz,
      });
      const midB = bTop + rowDepth + p.aisleW * 0.5;         // aisle centreline
      aisleLines.push([P(a0, midB), P(a1, midB)]);
    }
    const rails = [
      [P(0, 0), P(0, bandLen)],
      [P(alongLen, 0), P(alongLen, bandLen)],
    ];

    return { stalls, trees, aisles, aisleLines, rails, count: stalls.length, bayH, rowDepth, aisleW: p.aisleW, connectors, horiz };
  };

  // Manual layout: fill each user-drawn section (a rotatable rectangle, with its
  // own stall angle + row direction) with stalls. Sections are filled in their
  // own local frame then rotated/translated into the world. No auto connectors —
  // roads are drawn separately.
  PS.generateManual = function (state) {
    const base = Object.assign({}, PS.defaults, state.params, { noConnectors: true });
    const stalls = [], trees = [], aisleLines = [], aisleGroups = [];
    for (const sec of state.sections || []) {
      // Polygon section: fill the drawn polygon directly (no local-frame rect).
      if (sec.poly && sec.poly.length >= 3) {
        const opts = Object.assign({}, base, {
          orientation: sec.orientation || base.orientation,
          angle: sec.angle || base.angle, siteSetback: 1.0,
        });
        const r = PS.generateParking(sec.poly, state.buildings || [], opts);
        for (const s of r.stalls) stalls.push({ corners: s.corners, cx: s.cx, cy: s.cy, occupied: false });
        for (const t of r.trees) trees.push({ x: t.x, y: t.y, r: t.r });
        // Drive-aisle ladder clipped to the polygon + a centre spine tying rungs.
        const grp = [];
        const clip = (ln) => { for (const seg of g.clipSegToPolygon(ln[0], ln[1], sec.poly)) { aisleLines.push(seg); grp.push(seg); } };
        for (const ln of r.aisleLines || []) clip(ln);
        for (const rl of r.rails || []) clip(rl);
        const bb = g.bbox(sec.poly), horiz = (sec.orientation || base.orientation) !== "v";
        if (horiz) clip([[(bb.minX + bb.maxX) / 2, bb.minY], [(bb.minX + bb.maxX) / 2, bb.maxY]]);
        else clip([[bb.minX, (bb.minY + bb.maxY) / 2], [bb.maxX, (bb.minY + bb.maxY) / 2]]);
        aisleGroups.push(grp);
        continue;
      }
      const rot = (sec.rot || 0) * Math.PI / 180, cos = Math.cos(rot), sin = Math.sin(rot);
      const w = sec.w, h = sec.h, cx = sec.cx, cy = sec.cy;
      const localPoly = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
      const opts = Object.assign({}, base, {
        orientation: sec.orientation || base.orientation,
        angle: sec.angle || base.angle,
        siteSetback: 1.0,
      });
      const r = PS.generateParking(localPoly, [], opts); // fill local rect (buildings handled after)
      const tf = (pt) => [cx + pt[0] * cos - pt[1] * sin, cy + pt[0] * sin + pt[1] * cos];
      for (const s of r.stalls) {
        const mid = tf([s.cx, s.cy]);
        let inB = false;
        for (const b of state.buildings || []) if (buildingHit(mid[0], mid[1], b, 0)) { inB = true; break; }
        if (inB) continue;
        stalls.push({ corners: s.corners.map(tf), cx: mid[0], cy: mid[1], occupied: false });
      }
      for (const t of r.trees) { const p = tf([t.x, t.y]); trees.push({ x: p[0], y: p[1], r: t.r }); }
      // Transform the section's drive-aisle ladder (rungs + rails) into world.
      // Keep a per-section group so the network can spur each ladder to a road.
      const grp = [];
      for (const ln of r.aisleLines || []) { const w = [tf(ln[0]), tf(ln[1])]; aisleLines.push(w); grp.push(w); }
      for (const rl of r.rails || []) { const w = [tf(rl[0]), tf(rl[1])]; aisleLines.push(w); grp.push(w); }
      aisleGroups.push(grp);
    }
    return { stalls, trees, aisles: [], aisleLines, aisleGroups, count: stalls.length, connectors: [], horiz: base.orientation !== "v" };
  };
})();
