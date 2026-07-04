/* traffic.js — the microsimulation engine.
 *
 * Substrate shared by cars (and, later, pedestrians / incidents):
 *   1. buildNetwork()  — turns the parking layout into a routable lane graph
 *      (aisle centrelines x connector cross-aisles), with an entrance, an exit,
 *      building doors and a per-stall access point.
 *   2. createTraffic() — a deterministic, seeded, fixed-step simulation: cars
 *      arrive, route (Dijkstra) to a chosen free stall, follow the car ahead so
 *      QUEUES and SPILLBACK emerge, park for a dwell time, then drive to the exit.
 *   3. congestion EMA per edge + live stats, and the canvas render hooks.
 *
 * Everything is metric (metres, seconds) and dependency-free.
 */
(function () {
  const PS = (window.PS = window.PS || {});

  // Is building b open at hour h (0-24)? from > to wraps past midnight;
  // unset or from === to (or full 0-24) = always open.
  PS.buildingOpen = function (b, h) {
    const from = b.openFrom != null ? b.openFrom : 0;
    const to = b.openTo != null ? b.openTo : 24;
    if (from === to || (from === 0 && to === 24)) return true;
    return from < to ? (h >= from && h < to) : (h >= from || h < to);
  };
  const g = PS.geom;

  // Vehicle + following constants (metres / seconds).
  const CAR_LEN = 4.6, CAR_W = 1.9;
  const MIN_GAP = 1.1;          // bumper gap kept when stopped
  const NODE_APPROACH = 6;      // start caring about the junction ahead within this
  const STOP_OFFSET = 2.5;      // stop this far short of (before) a blocked junction
  const BOX_CLEAR = 3.0;        // extra room needed past a junction before entering it
  const HALF_LANE = 2.3;        // keep-right offset from the centreline (wider lanes → opposing cars clear each other)
  const OT_OFFSET = 4.0;        // lateral shift into the oncoming lane when overtaking

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ======================================================================
  // 1. Network
  // ======================================================================
  PS.buildNetwork = function (state) {
    if (state.layoutMode === "manual") return PS.buildNetworkManual(state);
    const site = state.site, buildings = state.buildings || [], parking = state.parking, p = state.params;
    if (!parking || !parking.aisles.length) return null;
    const horiz = p.orientation !== "v";
    const bb = g.bbox(site);
    const driveMargin = 2.0, bPad = 1.2;

    function inBuilding(x, y, pad) {
      for (const b of buildings) if (g.pointInRect(x, y, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0, pad)) return true;
      return false;
    }
    function drivable(x, y) {
      if (!g.pointInPolygon([x, y], site)) return false;
      if (g.distToBoundary([x, y], site) < driveMargin) return false;
      if (inBuilding(x, y, bPad)) return false;
      return true;
    }
    function segDrivable(x1, y1, x2, y2) {
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        if (!drivable(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
      }
      return true;
    }

    // Aisle cross-positions (the fixed coordinate of each aisle centreline).
    const aisles = parking.aisles
      .map((ai) => {
        const xs = ai.poly.map((q) => q[0]);
        const ys = ai.poly.map((q) => q[1]);
        const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        return horiz ? avg(ys) : avg(xs);
      })
      .sort((a, b) => a - b);

    // Cross-aisle positions — reuse the ones the parking generator carved clear,
    // so drive lanes never sit on top of stalls. Fall back if absent.
    const alongMin = (horiz ? bb.minX : bb.minY) + driveMargin;
    const alongMax = (horiz ? bb.maxX : bb.maxY) - driveMargin;
    let conns;
    if (parking.connectors && parking.connectors.length) {
      conns = parking.connectors.slice();
    } else {
      const span = Math.max(1, alongMax - alongMin);
      const Nc = Math.max(2, Math.min(5, Math.round(span / 65) + 1));
      conns = [];
      for (let j = 0; j < Nc; j++) conns.push(alongMin + span * (j / (Nc - 1)));
    }

    const ptFor = horiz
      ? (cross, along) => [along, cross]
      : (cross, along) => [cross, along];

    // Grid of intersection nodes.
    const nodes = [];
    const grid = [];
    for (let i = 0; i < aisles.length; i++) {
      grid[i] = [];
      for (let j = 0; j < conns.length; j++) {
        const pt = ptFor(aisles[i], conns[j]);
        if (drivable(pt[0], pt[1])) {
          grid[i][j] = nodes.length;
          nodes.push({ id: nodes.length, x: pt[0], y: pt[1], i, j });
        } else grid[i][j] = -1;
      }
    }
    if (!nodes.length) return null;

    const edges = [];
    const adj = nodes.map(() => []);
    function addEdge(aId, bId) {
      const A = nodes[aId], B = nodes[bId];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      if (len < 0.5 || !segDrivable(A.x, A.y, B.x, B.y)) return;
      const id = edges.length;
      edges.push({ id, a: aId, b: bId, len, block: 0, cong: 0, load: 0 });
      adj[aId].push({ edge: id, to: bId, rev: false });
      adj[bId].push({ edge: id, to: aId, rev: true });
    }
    for (let i = 0; i < aisles.length; i++)
      for (let j = 0; j < conns.length - 1; j++)
        if (grid[i][j] >= 0 && grid[i][j + 1] >= 0) addEdge(grid[i][j], grid[i][j + 1]);
    for (let j = 0; j < conns.length; j++)
      for (let i = 0; i < aisles.length - 1; i++)
        if (grid[i][j] >= 0 && grid[i + 1][j] >= 0) addEdge(grid[i][j], grid[i + 1][j]);

    // Nodes per aisle, sorted along the aisle (for stall access).
    const aisleNodes = [];
    for (let i = 0; i < aisles.length; i++) {
      const list = [];
      for (let j = 0; j < conns.length; j++)
        if (grid[i][j] >= 0) list.push({ node: grid[i][j], along: conns[j] });
      list.sort((a, b) => a.along - b.along);
      aisleNodes[i] = list;
    }

    // Perimeter ring: per-aisle left/right end nodes joined by boundary-following
    // left & right drive roads, so cars can circulate the edge of the lot instead
    // of funnelling through the middle.
    function scanEnd(cross, dir) {
      const from = dir > 0 ? alongMin : alongMax;
      const to = dir > 0 ? alongMax : alongMin;
      for (let a = from; dir > 0 ? a <= to : a >= to; a += dir * 2) {
        const pt = ptFor(cross, a);
        if (drivable(pt[0], pt[1])) return a;
      }
      return null;
    }
    function addPerimNode(i, along) {
      if (along == null) return -1;
      const list = aisleNodes[i];
      for (const nd of list) if (Math.abs(nd.along - along) < 5) return nd.node; // reuse existing
      const pt = ptFor(aisles[i], along);
      if (!drivable(pt[0], pt[1])) return -1;
      const id = nodes.length;
      nodes.push({ id, x: pt[0], y: pt[1], i, j: -1 });
      adj.push([]);
      let best = null, bd = Infinity;
      for (const nd of list) { const d = Math.abs(nd.along - along); if (d < bd) { bd = d; best = nd; } }
      if (best) addEdge(id, best.node);
      list.push({ node: id, along });
      list.sort((a, b) => a.along - b.along);
      return id;
    }
    const leftPer = [], rightPer = [];
    for (let i = 0; i < aisles.length; i++) {
      leftPer[i] = addPerimNode(i, scanEnd(aisles[i], +1));
      rightPer[i] = addPerimNode(i, scanEnd(aisles[i], -1));
    }
    for (let i = 0; i < aisles.length - 1; i++) {
      if (leftPer[i] >= 0 && leftPer[i + 1] >= 0) addEdge(leftPer[i], leftPer[i + 1]);
      if (rightPer[i] >= 0 && rightPer[i + 1] >= 0) addEdge(rightPer[i], rightPer[i + 1]);
    }

    // Two driveways at bottom-left & bottom-right; each is both entrance and
    // exit, so inflow is split across the lot.
    const cx = (bb.minX + bb.maxX) / 2;
    const maxY = bb.maxY;
    function nearestNode(tx, ty, exclude) {
      let best = -1, bd = Infinity;
      for (const n of nodes) {
        if (n.id === exclude) continue;
        const d = Math.hypot(n.x - tx, n.y - ty);
        if (d < bd) { bd = d; best = n.id; }
      }
      return best;
    }
    // User-defined gates (state.gates): snap each to the nearest drivable node,
    // split into entrances ('in') and exits ('out') — separate objects.
    const gates = (state.gates && state.gates.length) ? state.gates : [
      { type: "in", x: cx - bb.w * 0.16, y: maxY },
      { type: "out", x: cx + bb.w * 0.16, y: maxY },
    ];
    const entrances = [], exits = [];
    for (const gt of gates) {
      const nid = nearestNode(gt.x, gt.y);
      if (nid < 0) continue;
      gt._node = nid; // remember snapped node (for rendering the marker on the graph)
      if (gt.type === "out") exits.push(nid); else entrances.push(nid);
    }
    if (!entrances.length && exits.length) entrances.push(exits[0]);
    if (!exits.length && entrances.length) exits.push(entrances[0]);

    // Building doors: edge midpoint nearest the lot centroid (rect or polygon).
    const centroid = g.centroid(site);
    const doors = buildings.map((b) => {
      if (b.poly && b.poly.length >= 3) return g.polyEdgeMidNearest(b.poly, centroid);
      const mids = g.rectPoints(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0, true);
      let best = mids[0], bd = Infinity;
      for (const m of mids) {
        const d = Math.hypot(m[0] - centroid[0], m[1] - centroid[1]);
        if (d < bd) { bd = d; best = m; }
      }
      return best;
    });

    // Stall access points on the nearest aisle.
    const stallAccess = parking.stalls.map((s) => {
      const crossCoord = horiz ? s.cy : s.cx;
      const alongCoord = horiz ? s.cx : s.cy;
      let ai = 0, bd = Infinity;
      for (let i = 0; i < aisles.length; i++) {
        const d = Math.abs(aisles[i] - crossCoord);
        if (d < bd) { bd = d; ai = i; }
      }
      if (!aisleNodes[ai] || !aisleNodes[ai].length) return null;
      // distance to nearest door (for stall-choice bias)
      let dDoor = 1e6;
      for (const dpt of doors) dDoor = Math.min(dDoor, Math.hypot(s.cx - dpt[0], s.cy - dpt[1]));
      return { aisleIndex: ai, along: alongCoord, access: ptFor(aisles[ai], alongCoord), cross: aisles[ai], dDoor };
    });

    function dijkstra(src) {
      const n = nodes.length;
      const dist = new Array(n).fill(Infinity);
      const prev = new Array(n).fill(-1);
      const done = new Array(n).fill(false);
      if (src < 0) return { dist, prev };
      dist[src] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1, ud = Infinity;
        for (let k = 0; k < n; k++) if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
        if (u < 0) break;
        done[u] = true;
        for (const e of adj[u]) {
          if (edges[e.edge].block >= 1) continue;
          const nd = dist[u] + edges[e.edge].len;
          if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
        }
      }
      return { dist, prev };
    }

    const net = {
      nodes, edges, adj, grid, aisles, conns, aisleNodes,
      entrances, exits, doors, stallAccess, horiz, ptFor, dijkstra,
    };
    net.fromIn = entrances.map(dijkstra);
    net.fromOut = exits.map(dijkstra);
    net.recomputeRoutes = () => { net.fromIn = net.entrances.map(dijkstra); net.fromOut = net.exits.map(dijkstra); };
    return net;
  };

  // Manual network: build the drive graph from user-drawn road polylines and
  // roundabout loops (auto-splitting at intersections), then attach each stall
  // to the nearest road edge and snap gates to the nearest node.
  PS.buildNetworkManual = function (state) {
    if (!state.parking) return null;
    const roads = state.roads || [], rounds = state.roundabouts || [];
    const raw = []; // {a, b, oneway}
    for (const r of roads) for (let i = 0; i < r.length - 1; i++) raw.push({ a: r[i], b: r[i + 1], oneway: false });
    for (const rb of rounds) {
      // One-way ring, counter-clockwise on screen (right-hand traffic). Angle
      // decreases so consecutive points run 6→3→12→9 o'clock.
      const N = 16, pts = [];
      for (let k = 0; k < N; k++) { const a = -(k / N) * Math.PI * 2; pts.push([rb.x + Math.cos(a) * rb.r, rb.y + Math.sin(a) * rb.r]); }
      for (let k = 0; k < N; k++) raw.push({ a: pts[k], b: pts[(k + 1) % N], oneway: true });
    }
    // Section drive aisles (rungs + rails). Two-way; they auto-split at crossings
    // with drawn roads below, so a road running through a section links into its
    // aisles. For a road that merely passes NEAR a section (a small gap), add one
    // short driveway spur from the nearest ladder endpoint to the nearest road so
    // the section still connects without the user having to draw an exact touch.
    const roadSegs = raw.slice(); // roads + roundabouts only, before aisles
    function projPt(p, A, B) {
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1;
      let t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const x = A[0] + t * dx, y = A[1] + t * dy;
      return { x, y, d: Math.hypot(p[0] - x, p[1] - y) };
    }
    for (const grp of (state.parking.aisleGroups || [])) {
      for (const ln of grp) raw.push({ a: ln[0], b: ln[1], oneway: false });
      if (!roadSegs.length) continue;
      let best = null;
      for (const ln of grp) for (const p of ln) for (const rs of roadSegs) {
        const pr = projPt(p, rs.a, rs.b);
        if (!best || pr.d < best.d) best = { d: pr.d, from: p, to: [pr.x, pr.y] };
      }
      if (best && best.d > 1 && best.d < 30) raw.push({ a: best.from, b: best.to, oneway: false });
    }
    if (!raw.length) return null;

    const eps = 1.0, nodes = [];
    function nodeAt(x, y) {
      for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i].x - x, nodes[i].y - y) < eps) return i;
      nodes.push({ id: nodes.length, x, y }); return nodes.length - 1;
    }
    const edges = [], adj = [];
    function addEdge(aId, bId, oneway) {
      if (aId === bId) return;
      const A = nodes[aId], B = nodes[bId], len = Math.hypot(B.x - A.x, B.y - A.y);
      if (len < 0.5) return;
      // A two-way road may not cut across a roundabout's central island — that
      // would give cars a straight shortcut through the middle instead of
      // circulating the one-way ring. The ring's own edges are one-way (exempt).
      if (!oneway) {
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        for (const rb of rounds) if (Math.hypot(mx - rb.x, my - rb.y) < rb.r - 1) return;
      }
      for (const e of adj[aId] || []) if (e.to === bId) return; // dedupe
      const id = edges.length;
      edges.push({ id, a: aId, b: bId, len, block: 0, cong: 0, load: 0, oneway: !!oneway });
      (adj[aId] = adj[aId] || []).push({ edge: id, to: bId, rev: false });
      if (!oneway) (adj[bId] = adj[bId] || []).push({ edge: id, to: aId, rev: true });
    }
    // Split each raw segment at crossings with the others, then chain into edges.
    for (let si = 0; si < raw.length; si++) {
      const p1 = raw[si].a, p2 = raw[si].b, oneway = raw[si].oneway;
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L2 = dx * dx + dy * dy || 1;
      const cuts = [{ t: 0, p: p1 }, { t: 1, p: p2 }];
      for (let sj = 0; sj < raw.length; sj++) {
        if (sj === si) continue;
        const o = raw[sj];
        if (!g.segIntersect(p1, p2, o.a, o.b)) continue;
        const ip = g.lineIntersect(p1, p2, o.a, o.b);
        if (!ip) continue;
        const t = ((ip[0] - p1[0]) * dx + (ip[1] - p1[1]) * dy) / L2;
        if (t > 0.001 && t < 0.999) cuts.push({ t, p: ip });
      }
      cuts.sort((a, b) => a.t - b.t);
      let prev = -1;
      for (const c of cuts) {
        const nid = nodeAt(c.p[0], c.p[1]);
        if (prev >= 0 && nid !== prev) {
          // Clip a two-way road/aisle where it runs inside a roundabout's
          // carriageway, so an approach road ENDS at the ring instead of
          // protruding into it — cars then merge (and give way) at the edge.
          let skip = false;
          if (!oneway) {
            const mx = (nodes[prev].x + nodes[nid].x) / 2, my = (nodes[prev].y + nodes[nid].y) / 2;
            for (const rb of rounds) if (Math.hypot(mx - rb.x, my - rb.y) < rb.r) { skip = true; break; }
          }
          if (!skip) addEdge(prev, nid, oneway);
        }
        prev = nid;
      }
    }
    for (let i = 0; i < nodes.length; i++) if (!adj[i]) adj[i] = [];
    if (!edges.length) return null;

    // --- Auto-weld near-miss gaps ----------------------------------------
    // Traced road ways, section driveway-spurs and roundabout rings routinely
    // stop a couple of metres short of one another without sharing a node,
    // which splits the drive graph into unreachable islands (cars then can't
    // reach the parking from a gate). Weld components whose closest node-pair
    // is within WELD_MAX metres with a short two-way link — never across a
    // roundabout island, which would defeat circulation.
    const welds = [];
    const WELD_MAX = 4;
    function insideRing(ax, ay, bx, by) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      for (const rb of rounds) if (Math.hypot(mx - rb.x, my - rb.y) < rb.r - 1) return true;
      return false;
    }
    function undirComp() {
      const cid = new Array(nodes.length).fill(-1);
      const uadj = nodes.map(() => []);
      for (const e of edges) { uadj[e.a].push(e.b); uadj[e.b].push(e.a); }
      let c = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (cid[i] >= 0) continue;
        const st = [i]; cid[i] = c;
        while (st.length) { const u = st.pop(); for (const v of uadj[u]) if (cid[v] < 0) { cid[v] = c; st.push(v); } }
        c++;
      }
      return cid;
    }
    // Kruskal over components: hash nodes into a WELD_MAX grid once, collect
    // cross-component candidate pairs from each 3×3 neighbourhood, then merge
    // nearest-first with a union-find. Same greedy closest-pair welds as the
    // old rescan-per-weld loop, but ~O(nodes) instead of O(welds × nodes²) —
    // that loop dominated every rebuild on big traced sites.
    {
      const cid = undirComp();
      const grid = new Map();
      const cellOf = (x, y) => Math.floor(x / WELD_MAX) + "," + Math.floor(y / WELD_MAX);
      for (let i = 0; i < nodes.length; i++) {
        const key = cellOf(nodes[i].x, nodes[i].y);
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(i);
      }
      const cand = [];
      for (let i = 0; i < nodes.length; i++) {
        const cx = Math.floor(nodes[i].x / WELD_MAX), cy = Math.floor(nodes[i].y / WELD_MAX);
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = grid.get(gx + "," + gy);
          if (!arr) continue;
          for (const j of arr) {
            if (j <= i || cid[i] === cid[j]) continue;
            const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
            if (d < WELD_MAX && !insideRing(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y)) cand.push({ i, j, d });
          }
        }
      }
      cand.sort((a, b) => a.d - b.d);
      const parent = {}; // component-id -> merged-into id (tiny forest, no compression needed)
      const find = (x) => { while (parent[x] != null) x = parent[x]; return x; };
      for (const c of cand) {
        const ra = find(cid[c.i]), rb = find(cid[c.j]);
        if (ra === rb) continue; // already bridged transitively by an earlier weld
        const before = edges.length;
        addEdge(c.i, c.j, false);
        if (edges.length === before) continue;
        parent[ra] = rb;
        welds.push([[nodes[c.i].x, nodes[c.i].y], [nodes[c.j].x, nodes[c.j].y]]);
      }
    }

    const aisleNodes = edges.map((e) => [{ node: e.a, along: 0 }, { node: e.b, along: e.len }]);

    // The entrance sits on the building edge facing its nearest drive access
    // (a road or parking aisle) — the side visitors actually arrive from. Since
    // parking choice pulls stalls toward the door, this makes cars park on the
    // access side. (It previously faced the leftover site centroid, which is
    // meaningless on a traced/real-map layout.)
    function nearestNodeXY(px, py) {
      let bx = px, by = py, bd = Infinity;
      for (const n of nodes) { const dd = (n.x - px) * (n.x - px) + (n.y - py) * (n.y - py); if (dd < bd) { bd = dd; bx = n.x; by = n.y; } }
      return [bx, by];
    }
    const doors = (state.buildings || []).map((b) => {
      const c = (b.poly && b.poly.length >= 3) ? g.centroid(b.poly) : [b.x + b.w / 2, b.y + b.h / 2];
      const target = nearestNodeXY(c[0], c[1]);
      if (b.poly && b.poly.length >= 3) return g.polyEdgeMidNearest(b.poly, target);
      const mids = g.rectPoints(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0, true);
      let best = mids[0], bd = Infinity;
      for (const m of mids) { const d = Math.hypot(m[0] - target[0], m[1] - target[1]); if (d < bd) { bd = d; best = m; } }
      return best;
    });

    function proj(px, py, A, B) {
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
      let t = ((px - A.x) * dx + (py - A.y) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const x = A.x + t * dx, y = A.y + t * dy;
      return { x, y, t, d: Math.hypot(px - x, py - y) };
    }
    const stallAccess = state.parking.stalls.map((s) => {
      let be = -1, bd = Infinity, bp = null, bt = 0;
      for (const e of edges) { const pr = proj(s.cx, s.cy, nodes[e.a], nodes[e.b]); if (pr.d < bd) { bd = pr.d; be = e.id; bp = [pr.x, pr.y]; bt = pr.t; } }
      if (be < 0) return null;
      let dDoor = 1e6; for (const dpt of doors) dDoor = Math.min(dDoor, Math.hypot(s.cx - dpt[0], s.cy - dpt[1]));
      return { aisleIndex: be, along: bt * edges[be].len, access: bp, dDoor };
    });

    function nearestNode(tx, ty) { let b = -1, bd = Infinity; for (const n of nodes) { const d = Math.hypot(n.x - tx, n.y - ty); if (d < bd) { bd = d; b = n.id; } } return b; }
    const gates = (state.gates && state.gates.length) ? state.gates : [];
    const entrances = [], exits = [];
    for (const gt of gates) { const nid = nearestNode(gt.x, gt.y); if (nid < 0) continue; gt._node = nid; if (gt.type === "out") exits.push(nid); else entrances.push(nid); }
    if (!entrances.length && exits.length) entrances.push(exits[0]);
    if (!exits.length && entrances.length) exits.push(entrances[0]);

    function dijkstra(src) {
      const n = nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
      if (src < 0) return { dist, prev };
      dist[src] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1, ud = Infinity; for (let k = 0; k < n; k++) if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
        if (u < 0) break; done[u] = true;
        for (const e of adj[u]) { if (edges[e.edge].block >= 1) continue; const nd = dist[u] + edges[e.edge].len; if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; } }
      }
      return { dist, prev };
    }
    // Reverse adjacency → distance-TO-a-target Dijkstra (needed for exits so the
    // one-way ring is routed the correct way rather than a reversed from-exit path).
    const radj = nodes.map(() => []);
    for (let u = 0; u < adj.length; u++) for (const e of adj[u]) radj[e.to].push({ edge: e.edge, from: u });
    function dijkstraTo(target) {
      const n = nodes.length, dist = new Array(n).fill(Infinity), done = new Array(n).fill(false);
      if (target < 0) return { dist };
      dist[target] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1, ud = Infinity; for (let k = 0; k < n; k++) if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
        if (u < 0) break; done[u] = true;
        for (const e of radj[u]) { if (edges[e.edge].block >= 1) continue; const nd = dist[u] + edges[e.edge].len; if (nd < dist[e.from]) dist[e.from] = nd; }
      }
      return { dist };
    }
    // Connectivity overlay: flag which edges are reachable-from-a-gate (green)
    // vs isolated fragments (red), and collect junction points (where 3+ edges
    // meet) — the renderer marks these so the user can see what is connected.
    const junctions = [];
    (function () {
      const cid = undirComp();
      const haveGates = entrances.length || exits.length;
      const gateComp = new Set();
      for (const nId of entrances.concat(exits)) if (nId >= 0) gateComp.add(cid[nId]);
      for (const e of edges) e.connected = haveGates ? gateComp.has(cid[e.a]) : true;
      const deg = new Array(nodes.length).fill(0);
      for (const e of edges) { deg[e.a]++; deg[e.b]++; }
      const secPolys = (state.sections || []).map((s) => s.poly || (PS.sectionCorners && PS.sectionCorners(s))).filter(Boolean);
      for (let i = 0; i < nodes.length; i++) {
        if (deg[i] < 3) continue; // only real meeting points, not polyline bends
        const n = nodes[i];
        // Skip nodes inside a parking section — those are aisle-ladder rungs, not
        // road/roundabout connections, and would swamp the overlay with dots.
        let inSec = false;
        for (const poly of secPolys) if (g.polyContains(n.x, n.y, poly, 0)) { inSec = true; break; }
        if (!inSec) junctions.push([n.x, n.y]);
      }
    })();

    const net = { nodes, edges, adj, aisleNodes, entrances, exits, doors, stallAccess, horiz: true, dijkstra, welds, junctions };
    net.fromIn = entrances.map(dijkstra);
    net.fromOut = exits.map(dijkstraTo);
    net.recomputeRoutes = () => { net.fromIn = net.entrances.map(dijkstra); net.fromOut = net.exits.map(dijkstraTo); };
    return net;
  };

  // ======================================================================
  // 2. Simulation
  // ======================================================================
  PS.createTraffic = function (state) {
    const sim = {
      running: false,
      t: 0, dt: 0.15, tempo: 20,
      seed: 1337, rng: mulberry32(1337),
      arrivalRate: 40, dwellMin: 20, speedKmh: 15, followSec: 1.5,
      clockStart: 8,        // time of day (hours) at sim.t = 0 — 1 sim-second = 1 clock-minute
      arrivalCurve: null,   // 24 hourly arrival rates (cars/min); null = flat arrivalRate
      dateStr: null,        // current sim date "YYYY-MM-DD" (null = app sets today); advances at midnight
      weekMult: null,       // 7 weekday multipliers, Monday first (null = app default)
      monthMult: null,      // 12 month multipliers, January first (null = app default)
      domMult: null,        // 31 day-of-month multipliers (payday bump etc.; null = app default)
      stopDate: null,       // "YYYY-MM-DD" — sim pauses itself when reached...
      stopHour: null,       // ...at this hour (float). null = run forever
      // Driver-population traits (means in [0,1]) + how much they vary per car.
      meanAggr: 0.5, meanCaution: 0.4, traitSpread: 0.35, allowOvertake: true,
      cars: [], peds: [], net: null, selectedCar: null,
      conflict: new Map(), _crashPts: [], _confTick: 0,
      _arrAcc: 0,
      recentSearch: [], parkedTotal: 0, turnedAway: 0, collisions: 0,
      stats: { circulating: 0, parked: 0, queuing: 0, avgSearch: 0, occupancyPct: 0, worstEdge: -1, worstCong: 0, collisions: 0 },
    };

    const vmax = () => sim.speedKmh / 3.6;
    const dwellSeconds = () => sim.dwellMin * 60 * (0.6 + 0.8 * sim.rng());
    const carColor = () => PS.CAR_COLORS[Math.floor(sim.rng() * PS.CAR_COLORS.length)];
    // Per-driver personality, jittered around the population means.
    function makeTraits() {
      const j = (m) => g.clamp(m + (sim.rng() * 2 - 1) * sim.traitSpread, 0, 1);
      return { aggr: j(sim.meanAggr), caution: j(sim.meanCaution), stressProne: j(0.5), stress: 0 };
    }

    // ---- path building ----
    function reconstruct(prev, dst) {
      const out = [];
      let u = dst;
      while (u !== -1) { out.push(u); u = prev[u]; }
      out.reverse();
      return out;
    }
    function nodesToSegments(net, ids) {
      const segs = [];
      for (let k = 0; k < ids.length - 1; k++) {
        const u = ids[k], v = ids[k + 1];
        let edgeId = -1, rev = false;
        for (const e of net.adj[u]) if (e.to === v) { edgeId = e.edge; rev = e.rev; break; }
        const A = net.nodes[u], B = net.nodes[v];
        segs.push({
          x1: A.x, y1: A.y, x2: B.x, y2: B.y,
          len: Math.hypot(B.x - A.x, B.y - A.y),
          laneKey: edgeId >= 0 ? edgeId + ":" + (rev ? "BA" : "AB") : null,
          edgeId, startNode: u, endNode: v,
        });
      }
      return segs;
    }
    // Is the straight along-aisle span between two along-coords clear of buildings?
    // (The approach/exit segment is drawn as a straight line along the aisle, so
    // it must not cut through a building sitting on that aisle.)
    // Does the straight segment p1->p2 stay clear of every building? (Samples the
    // segment; works for axis-aligned aisles and arbitrary drawn roads alike.)
    function segClear(p1, p2) {
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = p1[0] + (p2[0] - p1[0]) * t, y = p1[1] + (p2[1] - p1[1]) * t;
        for (const b of state.buildings) if (g.pointInRect(x, y, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0)) return false;
      }
      return true;
    }
    function approachFor(net, sa, dist) {
      const list = net.aisleNodes[sa.aisleIndex];
      let best = null, bc = Infinity, bi = -1;
      for (let k = 0; k < list.length; k++) {
        const nd = list[k];
        if (!isFinite(dist[nd.node])) continue;
        const np = net.nodes[nd.node];
        if (!segClear([np.x, np.y], sa.access)) continue; // no building between node and access
        const cost = dist[nd.node] + Math.abs(nd.along - sa.along);
        if (cost < bc) { bc = cost; best = nd; bi = k; }
      }
      return best ? { nd: best, idx: bi } : null;
    }
    function alongSeg(net, sa, ap) {
      // Segment from the approach node along the aisle to the stall access point.
      const A = net.nodes[ap.nd.node];
      const acc = sa.access;
      const list = net.aisleNodes[sa.aisleIndex];
      // neighbour toward the stall (for the shared lane key)
      let neighbour = null;
      for (const di of [-1, 1]) {
        const nb = list[ap.idx + di];
        if (!nb) continue;
        if (Math.abs(nb.along - sa.along) < Math.abs(ap.nd.along - sa.along)) { neighbour = nb; break; }
      }
      let laneKey = null, edgeId = -1;
      if (neighbour) {
        for (const e of net.adj[ap.nd.node]) if (e.to === neighbour.node) {
          edgeId = e.edge; laneKey = edgeId + ":" + (e.rev ? "BA" : "AB"); break;
        }
      }
      return { x1: A.x, y1: A.y, x2: acc[0], y2: acc[1], len: Math.hypot(acc[0] - A.x, acc[1] - A.y), laneKey, edgeId, startNode: ap.nd.node, endNode: null, keepRight: true };
    }

    // Cost of reaching a stall given a Dijkstra field (Infinity if unreachable).
    function costTo(stallIdx, dij) {
      const sa = sim.net.stallAccess[stallIdx];
      if (!sa || !dij) return Infinity;
      const ap = approachFor(sim.net, sa, dij.dist);
      if (!ap) return Infinity;
      return dij.dist[ap.nd.node] + Math.abs(ap.nd.along - sa.along);
    }
    // Build entrance-node -> stall path using entrance field `dij` rooted at `src`.
    function pathToStall(stallIdx, dij, src) {
      const net = sim.net, sa = net.stallAccess[stallIdx];
      if (!sa || !dij) return null;
      const ap = approachFor(net, sa, dij.dist);
      if (!ap) return null;
      const ids = reconstruct(dij.prev, ap.nd.node);
      if (ids[0] !== src) return null;
      const segs = nodesToSegments(net, ids);
      segs.push(alongSeg(net, sa, ap));
      const s = state.parking.stalls[stallIdx];
      segs.push({ x1: sa.access[0], y1: sa.access[1], x2: s.cx, y2: s.cy, len: Math.hypot(s.cx - sa.access[0], s.cy - sa.access[1]), laneKey: null, edgeId: -1, startNode: -1, endNode: null });
      return segs.filter((sg) => sg.len > 0.01);
    }
    // Build stall -> nearest exit path.
    function pathToExit(stallIdx) {
      const net = sim.net, sa = net.stallAccess[stallIdx];
      if (!sa || !net.exits.length) return null;
      // Congestion-aware exit pick: weight the static distance by the worst
      // current congestion on edges touching each exit, so departers spread to
      // a clear gate instead of all funnelling to the geometrically nearest
      // one (same 6x factor dijkstraCong uses). Scans BOTH edge directions —
      // adj[] only lists outgoing, which misses the inbound queue on one-ways.
      const exitCong = (exN) => {
        let cg = 0;
        for (const e of net.edges) if (e.a === exN || e.b === exN) cg = Math.max(cg, e.cong || 0);
        return cg;
      };
      let best = -1, bc = Infinity;
      for (let k = 0; k < net.exits.length; k++) {
        const c = costTo(stallIdx, net.fromOut[k]) * (1 + 6 * exitCong(net.exits[k]));
        if (c < bc) { bc = c; best = k; }
      }
      if (best < 0) return null;
      const dij = net.fromOut[best]; // dij.dist = distance TO the exit (respects one-way)
      const ap = approachFor(net, sa, dij.dist);
      if (!ap) return null;
      // Greedy forward walk along edge directions toward the exit (so one-way
      // rings are traversed the correct way, not a reversed from-exit path).
      const exitNode = net.exits[best];
      const ids = [ap.nd.node];
      let u = ap.nd.node, guard = 0;
      while (u !== exitNode && guard++ < 4000) {
        let bw = -1, bcst = Infinity;
        for (const e of net.adj[u]) {
          if (net.edges[e.edge].block >= 1) continue;
          const c = net.edges[e.edge].len + dij.dist[e.to];
          if (c < bcst) { bcst = c; bw = e.to; }
        }
        if (bw < 0) return null;
        u = bw; ids.push(u);
      }
      if (u !== exitNode) return null;
      const s = state.parking.stalls[stallIdx];
      const A = net.nodes[ap.nd.node];
      const segs = [
        { x1: s.cx, y1: s.cy, x2: sa.access[0], y2: sa.access[1], len: Math.hypot(sa.access[0] - s.cx, sa.access[1] - s.cy), laneKey: null, edgeId: -1, startNode: -1, endNode: null },
        { x1: sa.access[0], y1: sa.access[1], x2: A.x, y2: A.y, len: Math.hypot(A.x - sa.access[0], A.y - sa.access[1]), laneKey: null, edgeId: -1, startNode: -1, endNode: null, keepRight: true },
      ];
      return segs.concat(nodesToSegments(net, ids)).filter((sg) => sg.len > 0.01);
    }

    // ---- dynamic re-routing (a stuck car looks for a way around the jam) -----
    // Congestion-weighted forward Dijkstra from a node: a busy edge costs more,
    // so the fresh route steers around queues. Blocked edges are impassable.
    function dijkstraCong(src) {
      const net = sim.net, n = net.nodes.length;
      const dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
      if (src < 0) return { dist, prev };
      dist[src] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1, ud = Infinity;
        for (let k = 0; k < n; k++) if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
        if (u < 0) break; done[u] = true;
        for (const e of net.adj[u]) {
          const ed = net.edges[e.edge];
          if (ed.block >= 1) continue;
          const nd = dist[u] + ed.len * (1 + 6 * (ed.cong || 0)); // strongly penalise congested edges so a clear detour wins
          if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
        }
      }
      return { dist, prev };
    }
    // Rebuild a car's remaining path from the node it's heading to, routing
    // around congestion. Keeps the current segment, then splices the new route.
    function reroute(car) {
      const net = sim.net, li = car._li;
      if (!li || li.laneKey == null || li.endNode == null || li.endNode < 0) return false; // only from a real junction
      const startNode = li.endNode;
      const dij = dijkstraCong(startNode);
      let tail = null;
      if (car.state === "toStall") {
        const sa = net.stallAccess[car.stallIdx];
        if (!sa) return false;
        const ap = approachFor(net, sa, dij.dist);
        if (!ap || !isFinite(dij.dist[ap.nd.node])) return false;
        const ids = reconstruct(dij.prev, ap.nd.node);
        if (ids[0] !== startNode) return false;
        const segs = nodesToSegments(net, ids);
        segs.push(alongSeg(net, sa, ap));
        const s = state.parking.stalls[car.stallIdx];
        segs.push({ x1: sa.access[0], y1: sa.access[1], x2: s.cx, y2: s.cy, len: Math.hypot(s.cx - sa.access[0], s.cy - sa.access[1]), laneKey: null, edgeId: -1, startNode: -1, endNode: null });
        tail = segs;
      } else if (car.state === "toExit") {
        let bx = -1, bd = Infinity;
        for (const ex of net.exits) if (isFinite(dij.dist[ex]) && dij.dist[ex] < bd) { bd = dij.dist[ex]; bx = ex; }
        if (bx < 0) return false;
        const ids = reconstruct(dij.prev, bx);
        if (ids[0] !== startNode || ids.length < 2) return false;
        tail = nodesToSegments(net, ids);
      } else return false;
      tail = tail.filter((sg) => sg.len > 0.01);
      if (!tail.length) return false;
      // If the congestion-optimal route starts with the SAME edge the car was
      // already taking, there's no better way around — leave it be (don't churn,
      // and let its stuck-timer keep running toward give-up).
      const oldNext = car.path[car.segIndex + 1];
      if (oldNext && tail[0] && oldNext.edgeId != null && oldNext.edgeId >= 0 && oldNext.edgeId === tail[0].edgeId) return false;
      car.path = [car.path[car.segIndex]].concat(tail); // keep current segment; splice new route from its end node
      car.segIndex = 0;
      setPose(car);
      return true;
    }

    // A queued driver SETTLES: gives up the assigned (door-close) stall and
    // takes a free one nearby instead — real drivers grab what's available
    // rather than idle in a conga line past open spots. Finds free stalls
    // around the car via the spatial grid, then routes to the cheapest one
    // reachable from the junction the car is heading to.
    function settleForNearbyStall(car) {
      const net = sim.net, li = car._li;
      if (!li || li.laneKey == null || li.endNode == null || li.endNode < 0) return false;
      if (!sim._stallGrid || !state.parking) return false;
      const stalls = state.parking.stalls;
      const cand = [];
      const cx = Math.floor(car.x / 6), cy = Math.floor(car.y / 6), R = 10; // ~60 m radius (gate queues sit on the access road, a bit from the stalls)
      for (let gx = cx - R; gx <= cx + R; gx++) for (let gy = cy - R; gy <= cy + R; gy++) {
        const cell = sim._stallGrid.get(gx + "," + gy);
        if (!cell) continue;
        for (const k of cell) {
          if (k === car.stallIdx) continue;
          const s = stalls[k];
          if (!s || s.occupied || s.reserved) continue;
          cand.push({ k, d: Math.hypot(s.cx - car.x, s.cy - car.y) });
        }
      }
      if (!cand.length) return false; // nothing free nearby — keep queueing
      cand.sort((a, b) => a.d - b.d);
      const dij = dijkstraCong(li.endNode);
      // Among the nearest handful, take the cheapest actually-reachable one.
      let best = null, bestCost = Infinity;
      for (const c of cand.slice(0, 12)) {
        const sa = net.stallAccess[c.k];
        if (!sa) continue;
        const ap = approachFor(net, sa, dij.dist);
        if (!ap || !isFinite(dij.dist[ap.nd.node])) continue;
        const cost = dij.dist[ap.nd.node] + Math.abs(ap.nd.along - sa.along);
        if (cost < bestCost) { bestCost = cost; best = { k: c.k, sa, ap }; }
      }
      if (!best) return false;
      // Euclidean-near but a long drive away (other side of a divider) is not
      // "settling". NOTE: the cost is congestion-WEIGHTED (jammed metres count
      // up to 7x), and settling happens precisely when everything nearby is
      // jammed — so the cap must leave room for that inflation.
      if (bestCost > 400) return false;
      const ids = reconstruct(dij.prev, best.ap.nd.node);
      if (ids[0] !== li.endNode) return false;
      const segs = nodesToSegments(net, ids);
      segs.push(alongSeg(net, best.sa, best.ap));
      const s = stalls[best.k];
      segs.push({ x1: best.sa.access[0], y1: best.sa.access[1], x2: s.cx, y2: s.cy, len: Math.hypot(s.cx - best.sa.access[0], s.cy - best.sa.access[1]), laneKey: null, edgeId: -1, startNode: -1, endNode: null });
      const tail = segs.filter((sg) => sg.len > 0.01);
      if (!tail.length) return false;
      // Swap the reservation and splice the new route, like reroute().
      const old = stalls[car.stallIdx];
      if (old) old.reserved = false;
      s.reserved = true;
      car.stallIdx = best.k;
      car.path = [car.path[car.segIndex]].concat(tail);
      car.segIndex = 0;
      setPose(car);
      return true;
    }

    // ---- car helpers ----
    function setPose(car) {
      const seg = car.path[car.segIndex];
      car.x = seg.x1 + (seg.x2 - seg.x1) * car.segT;
      car.y = seg.y1 + (seg.y2 - seg.y1) * car.segT;
      const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1, m = Math.hypot(dx, dy) || 1;
      car.hx = dx / m; car.hy = dy / m;
    }
    function pathRemaining(car) {
      let r = car.path[car.segIndex].len * (1 - car.segT);
      for (let k = car.segIndex + 1; k < car.path.length; k++) r += car.path[k].len;
      return r;
    }
    function moveAlong(car, adv) {
      while (adv > 1e-6 && car.segIndex < car.path.length) {
        const seg = car.path[car.segIndex];
        const rem = seg.len * (1 - car.segT);
        if (adv < rem) { car.segT += adv / seg.len; adv = 0; }
        else {
          adv -= rem;
          if (car.segIndex === car.path.length - 1) { car.segT = 1; break; }
          car.segIndex++; car.segT = 0;
        }
      }
      setPose(car);
    }
    function laneInfo(car) {
      const seg = car.path[car.segIndex];
      return {
        laneKey: seg.laneKey, edgeId: seg.edgeId, keepRight: !!seg.keepRight,
        dir: seg.laneKey ? seg.laneKey.split(":")[1] : null,
        q: car.segT * seg.len, remaining: seg.len * (1 - car.segT), endNode: seg.endNode,
      };
    }

    // ---- lifecycle ----
    function freeStallList() {
      const stalls = state.parking.stalls;
      const out = [];
      for (let k = 0; k < stalls.length; k++) {
        const s = stalls[k];
        if (!s.occupied && !s.reserved && sim.net.stallAccess[k]) out.push(k);
      }
      return out;
    }
    // Footprint area of a building — polygon (shoelace) or rectangle.
    function footprint(x) {
      const fp = (x.poly && x.poly.length >= 3) ? g.area(x.poly) : (x.w || 0) * (x.h || 0);
      return Math.max(1, fp); // never 0/NaN, so every building keeps some weight
    }
    // Pick a destination building, weighted by floor area (bigger = busier).
    // ---- time of day ---------------------------------------------------
    // 1 sim-second = 1 clock-minute: a full day passes in 24 sim-minutes,
    // which is watchable at high tempo and slow enough to see rush hours.
    sim.hourNow = () => (((sim.clockStart || 0) + sim.t / 60) % 24 + 24) % 24;
    // Arrival rate at hour h — linear blend between the curve's hourly buckets.
    function curveAt(h) {
      const c = sim.arrivalCurve;
      if (!c || c.length !== 24) return sim.arrivalRate;
      const i0 = Math.floor(h) % 24, i1 = (i0 + 1) % 24, f = h - Math.floor(h);
      return c[i0] + (c[i1] - c[i0]) * f;
    }
    sim.curveAt = curveAt;
    // ---- calendar (weekday / month / payday multipliers) -----------------
    sim.dateNow = () => new Date((sim.dateStr || "2026-01-01") + "T12:00:00");
    // Combined calendar multiplier for the current date. Weekday is Monday-
    // first (JS getDay() is Sunday-first); every part defaults to 1.
    sim.calMult = function () {
      const d = sim.dateNow();
      const wi = (d.getDay() + 6) % 7;
      const w = (sim.weekMult && sim.weekMult.length === 7) ? sim.weekMult[wi] : 1;
      const m = (sim.monthMult && sim.monthMult.length === 12) ? sim.monthMult[d.getMonth()] : 1;
      const dm = sim.domMult;
      const p = (dm && dm.length === 31 && dm[d.getDate() - 1] != null) ? dm[d.getDate() - 1] : 1;
      return { w, m, p, total: w * m * p, weekday: wi, month: d.getMonth(), dom: d.getDate() };
    };
    function advanceDate(days) {
      const d = sim.dateNow(); d.setDate(d.getDate() + days);
      sim.dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function chooseDestBuilding() {
      const b = state.buildings;
      if (!b.length) return -1;
      // Weight = floor area x attractiveness (a grocery pulls harder than an
      // office of the same size), gated on opening hours — a closed building
      // attracts nobody. All closed -> -1 (the arrival loop trickles).
      const h = sim.hourNow();
      let tot = 0;
      const w = b.map((x) => {
        const a = footprint(x) * (x.floors || 1) * (x.attract != null ? x.attract : 1) * (PS.buildingOpen(x, h) ? 1 : 0);
        tot += a; return a;
      });
      if (tot <= 0) return -1;
      let r = sim.rng() * tot;
      for (let i = 0; i < b.length; i++) { r -= w[i]; if (r <= 0) return i; }
      return b.length - 1;
    }
    // Visit length scales with building size — a bigger building (more floor
    // area) keeps each visitor longer. Factor = sqrt of this building's floor
    // area relative to the average building, clamped so it stays sensible.
    function dwellFactorFor(destB) {
      const bs = state.buildings;
      if (destB == null || destB < 0 || !bs || !bs.length || !bs[destB]) return 1;
      let sum = 0; for (const x of bs) sum += footprint(x) * (x.floors || 1);
      const mean = sum / bs.length || 1;
      return g.clamp(Math.sqrt((footprint(bs[destB]) * (bs[destB].floors || 1)) / mean), 0.5, 3);
    }
    // Pick a free stall as close as possible to the destination building's door
    // (randomised among the nearest handful, so drivers compete for close spots).
    // Only stalls REACHABLE from the spawning gate (`dij`) count — otherwise a
    // disconnected section next to the door swallows the whole arrival stream
    // as "turned away" while the connected lot sits empty.
    function chooseStall(destB, dij) {
      const free = freeStallList();
      if (!free.length) return -1;
      const reach = (k) => !dij || isFinite(costTo(k, dij));
      const door = destB >= 0 && sim.net.doors[destB] ? sim.net.doors[destB] : null;
      if (!door) {
        for (let t = 0; t < 15; t++) {
          const k = free[Math.floor(sim.rng() * free.length)];
          if (reach(k)) return k;
        }
        return free[Math.floor(sim.rng() * free.length)];
      }
      const stalls = state.parking.stalls;
      const scored = free.map((k) => {
        const s = stalls[k];
        return { k, d: Math.hypot(s.cx - door[0], s.cy - door[1]) };
      });
      scored.sort((a, b) => a.d - b.d);
      // Walk outward from the door and keep the 10 nearest *reachable* stalls.
      const ok = [];
      for (const sc of scored) {
        if (reach(sc.k)) { ok.push(sc); if (ok.length >= 10) break; }
      }
      if (!ok.length) return scored[0].k; // nothing reachable — caller turns the car away
      return ok[Math.floor(sim.rng() * ok.length)].k;
    }
    function gateBlocked(gnode) {
      const eN = sim.net.nodes[gnode];
      for (const car of sim.cars) {
        if (car.state !== "toStall" && car.state !== "toExit") continue;
        // Only a car actually stopped/queued at the gate blocks a fresh spawn —
        // a car merely driving PAST (e.g. a gate on a through-road) shouldn't
        // starve that gate, or arrivals can't spread evenly across entrances.
        const dGate = Math.hypot(car.x - eN.x, car.y - eN.y);
        if (dGate < CAR_LEN + 0.5) return true; // physically ON the gate mouth — never spawn inside a car, rolling or not
        if (dGate < CAR_LEN + MIN_GAP + 1 && (car.v || 0) < 1.5) return true;
      }
      return false;
    }
    // Spawn one car AT a specific entrance k (each gate has its own arrival
    // stream — see the arrival loop — so demand is spread evenly across gates).
    // Returns true if consumed (spawned or turned away), false if the gate is
    // momentarily blocked and the car must keep waiting on the street.
    // Congestion-aware arrival field: when the lot is jammed, route fresh
    // arrivals (and their stall choice) AROUND the jam instead of feeding it
    // head-on with the static shortest-distance field. Cached per gate on the
    // current net (a rebuild discards it), refreshed at most every 2 sim-s
    // behind the shared wall-clock Dijkstra throttle; calm lots pay nothing.
    function arrivalField(k) {
      const net = sim.net;
      if ((sim._maxCong || 0) < 0.3) return net.fromIn[k];
      if (!net._congIn) net._congIn = {};
      const c = net._congIn[k];
      if (c && sim.t - c.at < 2) return c.field;
      if (performance.now() - (sim._lastRerouteWall || -1e9) < 100) return c ? c.field : net.fromIn[k];
      sim._lastRerouteWall = performance.now();
      const field = dijkstraCong(net.entrances[k]);
      net._congIn[k] = { field, at: sim.t };
      return field;
    }
    // Can gate m serve an arrival for destB right now? Returns the spawn plan.
    function planFromGate(m, destB) {
      const dij = arrivalField(m);
      const stallIdx = chooseStall(destB, dij);
      if (stallIdx < 0) return null;                     // lot genuinely full
      if (!isFinite(costTo(stallIdx, dij))) return null; // no free stall reachable from m
      const path = pathToStall(stallIdx, dij, sim.net.entrances[m]);
      if (!path || !path.length) return null;
      return { stallIdx, path };
    }
    function spawnCarAt(k) {
      const ent = sim.net.entrances;
      const destB = chooseDestBuilding();
      let m = k, plan = planFromGate(k, destB);
      if (!plan) {
        // This gate can't reach any free stall — the driver arrives via
        // another gate that can. Only when NO gate reaches a free stall is
        // the arrival a genuine turn-away (what the analyst assumes it means).
        for (let j = 0; j < ent.length && !plan; j++) if (j !== k) { plan = planFromGate(j, destB); if (plan) m = j; }
        if (!plan) { sim.turnedAway++; return true; }
      }
      if (gateBlocked(ent[m])) return false; // the chosen gate's mouth is occupied — wait
      if (!sim.entCount || sim.entCount.length !== ent.length) sim.entCount = new Array(ent.length).fill(0);
      sim.entCount[m]++;
      state.parking.stalls[plan.stallIdx].reserved = true;
      const car = { kind: "car", state: "toStall", stallIdx: plan.stallIdx, path: plan.path, segIndex: 0, segT: 0, v: 0, color: carColor(), spawnT: sim.t, traits: makeTraits(), stuck: 0, gateIn: m, destB };
      setPose(car);
      sim.cars.push(car);
      return true;
    }
    // ---- pedestrian walking routes ------------------------------------
    // Walkers used to beeline stall->door straight THROUGH buildings (and the
    // old clear-test only knew rectangles, so traced polygon buildings were
    // never even checked). When the straight line is blocked, walk the
    // drivable graph instead — it is building-free by construction. Undirected
    // (walkers ignore one-way), cached adjacency per net.
    function pedSegClear(p1, p2) {
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = p1[0] + (p2[0] - p1[0]) * t, y = p1[1] + (p2[1] - p1[1]) * t;
        for (const b of state.buildings) if (PS.buildingHit(x, y, b, 0)) return false;
      }
      return true;
    }
    function pedRoute(from, to) {
      if (pedSegClear(from, to)) return [to];
      const net = sim.net;
      if (!net || !net.nodes.length) return [to];
      if (!net._pedAdj) {
        const ua = net.nodes.map(() => []);
        for (const e of net.edges) { ua[e.a].push({ to: e.b, len: e.len }); ua[e.b].push({ to: e.a, len: e.len }); }
        net._pedAdj = ua;
      }
      const ua = net._pedAdj;
      let src = -1, sd = Infinity, dst = -1, dd = Infinity;
      for (const nd of net.nodes) {
        const ds = (nd.x - from[0]) * (nd.x - from[0]) + (nd.y - from[1]) * (nd.y - from[1]);
        const de = (nd.x - to[0]) * (nd.x - to[0]) + (nd.y - to[1]) * (nd.y - to[1]);
        if (ds < sd) { sd = ds; src = nd.id; }
        if (de < dd) { dd = de; dst = nd.id; }
      }
      if (src < 0 || dst < 0) return [to];
      const n = net.nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
      dist[src] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1, ud = Infinity; for (let k = 0; k < n; k++) if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; }
        if (u < 0 || u === dst) break; done[u] = true;
        for (const e of ua[u]) { const nd2 = dist[u] + e.len; if (nd2 < dist[e.to]) { dist[e.to] = nd2; prev[e.to] = u; } }
      }
      if (!isFinite(dist[dst])) return [to];
      const ids = []; let u = dst; while (u !== -1) { ids.push(u); u = prev[u]; } ids.reverse();
      const wps = ids.map((id) => [net.nodes[id].x, net.nodes[id].y]);
      wps.push(to);
      // Trim leading waypoints the walker can already reach directly (less zig-zag).
      while (wps.length > 1 && pedSegClear(from, wps[1])) wps.shift();
      return wps;
    }
    function parkCar(car) {
      const s = state.parking.stalls[car.stallIdx];
      if (!s) { car._dead = true; return; } // stall vanished (layout changed)
      s.occupied = true; s.color = car.color;
      car.state = "parked";
      const search = sim.t - car.spawnT;
      sim.recentSearch.push(search);
      if (sim.recentSearch.length > 40) sim.recentSearch.shift();
      sim.parkedTotal++;
      // Count this visit toward the destination building's running total.
      if (car.destB != null && car.destB >= 0) {
        if (!sim.visitTotals) sim.visitTotals = {};
        sim.visitTotals[car.destB] = (sim.visitTotals[car.destB] || 0) + 1;
      }
      // Send a pedestrian to the destination building; its round trip drives the
      // dwell time. Without a building, fall back to a plain timer.
      const door = (car.destB != null && car.destB >= 0 && sim.net.doors[car.destB]) ? sim.net.doors[car.destB] : null;
      if (door) {
        car.departAt = Infinity;
        const route = [[s.cx, s.cy], ...pedRoute([s.cx, s.cy], [door[0], door[1]])]; // stall -> (graph) -> door
        sim.peds.push({ car, stall: [s.cx, s.cy], door: [door[0], door[1]], x: s.cx, y: s.cy, route, wpi: 1, phase: "toDoor", speed: 1.1 + 0.5 * sim.rng(), shopUntil: 0, gawk: false });
      } else {
        car.departAt = sim.t + dwellSeconds() * dwellFactorFor(car.destB);
      }
    }
    function startLeaving(car) {
      const s = state.parking.stalls[car.stallIdx];
      if (!s) { car._dead = true; return; } // stall vanished (layout changed)
      const path = pathToExit(car.stallIdx);
      if (!path || !path.length) {
        // No way out right now (transient blockage / disconnected section):
        // stay parked and retry in a minute instead of evaporating in place —
        // parked cars used to silently blink out of existence here.
        car.departAt = sim.t + 60;
        return;
      }
      // Free the painted spot as it pulls out, but HOLD the claim until the
      // car has cleared the stall mouth (released in the drive loop) — an
      // arrival must not nose into a stall that still has a car in it.
      s.occupied = false; s.reserved = true;
      car.state = "toExit"; car.path = path; car.segIndex = 0; car.segT = 0; car.v = 0;
      car.crawl = 0; // impatience from the inbound leg must not carry across the dwell
      setPose(car);
    }

    // ---- one tick ----
    function step(dt) {
      if (!sim.net) return; // no drivable network yet (e.g. manual mode, no roads)
      sim.t += dt;
      { // clock rolled past midnight -> next calendar day
        const hNow = sim.hourNow();
        const hPrev = ((((sim.clockStart || 0) + (sim.t - dt) / 60) % 24) + 24) % 24;
        if (hNow < hPrev - 12) advanceDate(1);
        // Stop time reached -> flag for the UI loop to pause (lets you run
        // e.g. exactly one month and then read/export the curves).
        if (sim.stopDate && (sim.dateStr > sim.stopDate || (sim.dateStr === sim.stopDate && hNow >= (sim.stopHour || 0)))) {
          sim.running = false; sim._stopReached = true;
        }
      }

      // Clear finished crashes (the wreck is towed away).
      for (const car of sim.cars) {
        if (car.crashed && sim.t >= car.crashedUntil) {
          car.crashed = false;
          if (car.traits) car.traits.stress = Math.min(1, car.traits.stress + 0.25);
        }
      }
      sim._crashPts = sim.cars.filter((c) => c.crashed).map((c) => [c.x, c.y]);

      // Arrivals — one independent stream PER entrance, each getting an equal
      // share (arrivalRate / #gates), so demand is distributed evenly across
      // the gates. A congested gate just backs up its own (capped) queue
      // instead of shoving its share onto the others.
      const nEnt = (sim.net && sim.net.entrances.length) || 0;
      if (nEnt) {
        if (!sim._gateAcc || sim._gateAcc.length !== nEnt) sim._gateAcc = new Array(nEnt).fill(0);
        if (!sim._gateWait || sim._gateWait.length !== nEnt) sim._gateWait = new Array(nEnt).fill(0);
        // Arrivals follow the day curve; when every building is closed only a
        // trickle shows up (staff, confused people, people who can't read signs).
        const hArr = sim.hourNow();
        let rateNow = curveAt(hArr) * sim.calMult().total;
        if (state.buildings.length && !state.buildings.some((x) => PS.buildingOpen(x, hArr))) rateNow *= 0.05;
        sim._rateNow = rateNow;
        const per = (rateNow / 60) * dt / nEnt;
        for (let k = 0; k < nEnt; k++) {
          sim._gateAcc[k] = Math.min(4, sim._gateAcc[k] + per);
          while (sim._gateAcc[k] >= 1) { if (spawnCarAt(k)) { sim._gateAcc[k] -= 1; sim._gateWait[k] = 0; } else break; }
          if (sim._gateAcc[k] >= 1) {
            // Demand pending at a physically blocked gate: after ~10 s divert
            // the driver to another usable gate instead of letting this gate's
            // share of the arrivals silently evaporate.
            sim._gateWait[k] += dt;
            if (sim._gateWait[k] > 10) {
              for (let j2 = 0; j2 < nEnt; j2++) {
                if (j2 === k) continue;
                if (spawnCarAt(j2)) { sim._gateAcc[k] -= 1; sim._gateWait[k] = 0; sim.diverted = (sim.diverted || 0) + 1; break; }
              }
            }
          }
        }
      }

      // Departures — on the dwell timer, or early because the destination
      // building just closed (only for timer-driven cars; ped-driven ones
      // leave via their pedestrian walking back at closing).
      const hDep = sim.hourNow();
      for (const car of sim.cars) {
        if (car.state !== "parked") continue;
        const closedDest = isFinite(car.departAt) && car.destB >= 0 && state.buildings[car.destB] &&
          PS.buildingOpen && !PS.buildingOpen(state.buildings[car.destB], hDep);
        if (sim.t >= car.departAt || closedDest) startLeaving(car);
      }

      // Group moving cars by directed lane; sort by position. Also record each
      // car's RENDERED position (with keep-right offset) for the proximity brake.
      const lanes = new Map();
      const movers = [];
      for (const car of sim.cars) {
        if (car.state !== "toStall" && car.state !== "toExit") continue;
        car._li = laneInfo(car);
        const lat = car.lat || 0, hx = car.hx || 0, hy = car.hy || 0;
        car._rx = car.x + -hy * lat; car._ry = car.y + hx * lat;
        movers.push(car);
        const lk = car._li.laneKey;
        if (lk != null) { if (!lanes.has(lk)) lanes.set(lk, []); lanes.get(lk).push(car); }
      }

      // Junction contention: closest approaching car wins the node; and note
      // which cars are physically inside a junction box (existing traffic).
      const nodeWinner = new Map();
      const nodeBusy = new Map();
      for (const car of sim.cars) {
        if (car.state !== "toStall" && car.state !== "toExit") continue;
        const li = car._li;
        if (li.endNode != null && li.remaining < NODE_APPROACH && car.segIndex < car.path.length - 1) {
          const cur = nodeWinner.get(li.endNode);
          if (!cur || li.remaining < cur.rem) nodeWinner.set(li.endNode, { car, rem: li.remaining });
        }
        const seg = car.path[car.segIndex];
        if (seg.startNode != null && seg.startNode >= 0) {
          const n = sim.net.nodes[seg.startNode];
          if (Math.hypot(car.x - n.x, car.y - n.y) < NODE_APPROACH * 0.55) {
            if (!nodeBusy.has(seg.startNode)) nodeBusy.set(seg.startNode, []);
            nodeBusy.get(seg.startNode).push(car);
          }
        }
      }

      // Head-on distance to the nearest oncoming car on the same edge (metres),
      // measured along the edge; also returns that car so we can crash it too.
      function oncoming(li) {
        const edge = sim.net.edges[li.edgeId];
        if (!edge) return { gap: Infinity, car: null };
        const L = edge.len;
        const onKey = li.edgeId + ":" + (li.dir === "AB" ? "BA" : "AB");
        const arr = lanes.get(onKey) || [];
        const myA = li.dir === "AB" ? li.q : L - li.q;
        let gap = Infinity, who = null;
        for (const o of arr) {
          const oA = o._li.dir === "AB" ? o._li.q : L - o._li.q;
          const gp = li.dir === "AB" ? oA - myA : myA - oA;
          if (gp > 0 && gp < gap) { gap = gp; who = o; }
        }
        return { gap, car: who };
      }

      const vm = vmax();
      const walkers = sim.peds.filter((p) => p.phase !== "inBuilding");
      for (const car of sim.cars) {
        if (car.state !== "toStall" && car.state !== "toExit") continue;
        // Departer has cleared its stall mouth → release the claim held since
        // startLeaving (arrivals may now take the spot).
        if (car.state === "toExit" && car.stallIdx >= 0 && car.segIndex > 0) {
          const exSt = state.parking.stalls[car.stallIdx];
          if (exSt) exSt.reserved = false;
          car.stallIdx = -1;
        }
        if (car.crashed) { car.v = 0; continue; } // stuck at the scene
        const li = car._li;
        const tr = car.traits;

        // Trait-driven desired speed + following gap.
        const vdes = vm * g.clamp(0.65 + 0.55 * tr.aggr - 0.35 * tr.caution + 0.25 * tr.stress, 0.3, 1.3);
        const gapMin = Math.max(0.4, MIN_GAP * (1 + 1.6 * tr.caution - 0.5 * tr.aggr));
        let move = vdes * dt;
        const remTotal = pathRemaining(car);
        move = Math.min(move, remTotal); // stop at destination

        // Slow right down to manoeuvre into/out of a stall or on arrival.
        if (li.laneKey == null || remTotal < 8) {
          move = Math.min(move, 2.2 * (1 - 0.35 * tr.caution) * dt);
        }
        // Rubberneck: crawl past a crash scene.
        for (const cp of sim._crashPts) {
          if (Math.abs(car.x - cp[0]) < 9 && Math.abs(car.y - cp[1]) < 9) { move = Math.min(move, 1.4 * dt); break; }
        }

        // Leader on the same directed lane.
        let leaderGap = Infinity, leader = null;
        if (li.laneKey != null) {
          const arr = lanes.get(li.laneKey);
          for (const o of arr) { if (o === car) continue; const dq = o._li.q - li.q; if (dq > 0 && dq < leaderGap) { leaderGap = dq; leader = o; } }
        }

        if (car.overtaking) {
          // Passing in the oncoming lane: ignore the queue, watch for head-ons.
          const on = oncoming(li);
          if (on.gap < 3.2) { sim.crash(car); if (on.car) sim.crash(on.car); }
          else {
            if (on.gap < 11) move = Math.min(move, Math.max(0, on.gap - 3)); // brake for oncoming
            // Only merge back into a real gap in the keep-right lane — never on
            // top of another car. If there's no gap, keep going and look further.
            const arr = lanes.get(li.laneKey) || [];
            let gapAhead = Infinity, gapBehind = Infinity;
            for (const o of arr) {
              if (o === car || o.overtaking) continue;
              const dq = o._li.q - li.q;
              if (dq >= 0) gapAhead = Math.min(gapAhead, dq); else gapBehind = Math.min(gapBehind, -dq);
            }
            const canMerge = gapAhead > CAR_LEN + gapMin && gapBehind > CAR_LEN * 0.7;
            const passedLeader = li.q > car.otLeaderQ + CAR_LEN + 1;
            if (canMerge && (passedLeader || li.remaining < CAR_LEN)) {
              car.overtaking = false;
            } else if (li.remaining < CAR_LEN + 1) {
              move = Math.min(move, Math.max(0, li.remaining - STOP_OFFSET)); // no gap & junction ahead → wait
            }
          }
        } else {
          // Time-headway ("three-second rule"): keep as much gap to the car ahead
          // as you'd cover in followSec seconds at your CURRENT speed — never less
          // than the static bumper gap (so cars still nudge close when stopped).
          const followGap = Math.max(gapMin, (sim.followSec || 0) * (car.v || 0));
          if (leaderGap < Infinity) move = Math.min(move, Math.max(0, leaderGap - CAR_LEN - followGap));
          // A stressed, aggressive, stuck driver may pull out to overtake.
          if (sim.allowOvertake && li.laneKey != null && li.edgeId >= 0 &&
              ((car.stuck || 0) > 3 || (car.crawl || 0) > 8) &&
              car.v < Math.max(0.3, 0.35 * vm) && tr.aggr > 0.62 && tr.stress > 0.55 && leader && leaderGap < CAR_LEN + 4 &&
              li.remaining > CAR_LEN * 2 && sim.rng() < dt * 0.6) {
            if (oncoming(li).gap > 16) { car.overtaking = true; car.otLeaderQ = leader._li.q; }
          }
        }

        // Junction: yield to the node winner, to a car already crossing the
        // junction, to a full next lane, and to a blocked edge. Roundabouts
        // override the "closest wins" rule: circulating traffic has priority,
        // so a car ENTERING the ring gives way to cars already on it, and a car
        // already ON the ring does not yield to entering traffic at the node.
        if (!car.overtaking && li.endNode != null && car.segIndex < car.path.length - 1) {
          let blocked = false;
          const nseg = car.path[car.segIndex + 1];
          // A car already circulating a roundabout (on a one-way ring edge) keeps
          // priority: it does not yield to entering traffic at the ring node.
          // (Entering cars give way geometrically further below.)
          const curOnRing = li.edgeId >= 0 && sim.net.edges[li.edgeId] && sim.net.edges[li.edgeId].oneway;
          if (!curOnRing) {
            const w = nodeWinner.get(li.endNode);
            if (w && w.car !== car) blocked = true;
            const occ = nodeBusy.get(li.endNode);
            if (occ) for (const o of occ) { if (o !== car) { blocked = true; break; } }
          }
          // Both cases: don't pile into an occupied next lane or a blocked edge.
          if (nseg.laneKey != null) {
            const narr = lanes.get(nseg.laneKey) || [];
            for (const o of narr) { if (o !== car && o._li.q < CAR_LEN + gapMin + BOX_CLEAR) { blocked = true; break; } }
          }
          if (nseg.edgeId >= 0 && sim.net.edges[nseg.edgeId] && sim.net.edges[nseg.edgeId].block >= 1) blocked = true;
          if (blocked) move = Math.min(move, Math.max(0, li.remaining - STOP_OFFSET));
        }

        // General merge guard: never roll onto a lane whose entry is occupied —
        // covers pulling out of a stall / an approach into a standing queue.
        if (!car.overtaking && car.segIndex < car.path.length - 1) {
          const mseg = car.path[car.segIndex + 1];
          if (mseg.laneKey != null && li.remaining < CAR_LEN + 1.5) {
            const marr = lanes.get(mseg.laneKey) || [];
            let minq = Infinity;
            for (const o of marr) { if (o !== car && o._li.q < minq) minq = o._li.q; }
            if (minq < CAR_LEN + gapMin) move = Math.min(move, Math.max(0, li.remaining - STOP_OFFSET));
          }
        }

        // Yield to pedestrians crossing ahead — stop rather than run them over.
        // But after a few seconds crawling behind a walker headed the same way,
        // squeeze past with care (crash-scene speed) — cars used to trail a
        // single pedestrian at walking pace for the length of the lot.
        const hx = car.hx || 0, hy = car.hy || 0;
        for (const ped of walkers) {
          const rx = ped.x - car.x, ry = ped.y - car.y;
          const ahead = rx * hx + ry * hy;
          if (ahead > 0 && ahead < 7 && Math.abs(-rx * hy + ry * hx) < 2.2) {
            if ((car.crawl || 0) > 5) move = Math.min(move, Math.max(1.4 * dt, ahead - 2.6));
            else move = Math.min(move, Math.max(0, ahead - 2.6));
          }
        }

        // Roundabout give-way: a car about to merge onto a one-way RING edge
        // yields to any car already circulating (on a one-way edge) that's near
        // the merge point and coming round toward it — braking before the merge
        // node. Classifying by the one-way ring edge (not by distance to the
        // centre) is what makes this work even when the approach road ends
        // INSIDE the carriageway: the approaching car is still on a two-way
        // road edge, so it's correctly treated as entering, not circulating.
        if (car.segIndex < car.path.length - 1) {
          const curRing = li.edgeId >= 0 && sim.net.edges[li.edgeId] && sim.net.edges[li.edgeId].oneway;
          const nseg = car.path[car.segIndex + 1];
          const nextRing = nseg.edgeId >= 0 && sim.net.edges[nseg.edgeId] && sim.net.edges[nseg.edgeId].oneway;
          if (!curRing && nextRing && li.endNode != null) {
            const P = sim.net.nodes[li.endNode];
            let give = false;
            for (const o of movers) {
              if (o === car) continue;
              const oe = sim.net.edges[o._li.edgeId];
              if (!oe || !oe.oneway) continue;                 // o must be circulating on a ring
              if ((o.v || 0) < 0.5) continue;                  // ignore a STOPPED ring car (else entry/ring deadlock)
              const rx = P.x - o.x, ry = P.y - o.y, d = Math.hypot(rx, ry);
              if (d > 8) continue;                              // only a genuinely close car — otherwise accept the gap
              if (d < 2 || rx * (o.hx || 0) + ry * (o.hy || 0) > 0) { give = true; break; } // right at / approaching the entry
            }
            if (give) { sim._giveWays = (sim._giveWays || 0) + 1; move = Math.min(move, Math.max(0, li.remaining - STOP_OFFSET)); } // hold before merging
          }
        }

        // Proximity brake: never drive over another car, whatever lane it's on
        // (catches cross-lane/junction/merge overlaps the lane logic misses).
        // Uses rendered positions so opposing lanes (offset apart) don't trip it.
        for (const o of movers) {
          if (o === car) continue;
          const rx = o._rx - car._rx, ry = o._ry - car._ry;
          const ahead = rx * hx + ry * hy;
          if (ahead <= 0 || ahead > CAR_LEN + 3) continue;
          if (Math.abs(-rx * hy + ry * hx) < CAR_W + 0.5) {
            move = Math.min(move, Math.max(0, ahead - CAR_LEN - 0.5));
          }
        }

        // Don't drive over PARKED cars either (except heading into own target
        // stall). Only nearby stalls are checked via the spatial grid.
        if (sim._stallGrid) {
          const gx = Math.floor(car.x / 6), gy = Math.floor(car.y / 6);
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
            const cell = sim._stallGrid.get((gx + ox) + "," + (gy + oy));
            if (!cell) continue;
            for (const k of cell) {
              if (k === car.stallIdx) continue;
              const ps = state.parking.stalls[k];
              if (!ps || !ps.occupied) continue;
              const rx = ps.cx - car.x, ry = ps.cy - car.y;
              const ahead = rx * hx + ry * hy;
              if (ahead > 0 && ahead < CAR_LEN + 1 && Math.abs(-rx * hy + ry * hx) < CAR_W + 0.2) {
                move = Math.min(move, Math.max(0, ahead - CAR_LEN * 0.6 - 0.8));
              }
            }
          }
        }

        move = Math.max(0, move);
        moveAlong(car, move);
        car.v = move / dt;

        // Lateral lane position: keep right on a lane, swing left into the
        // oncoming lane while overtaking, centre while manoeuvring off-lane.
        const onLane = li.laneKey != null || li.keepRight;
        const latTarget = car.overtaking ? -OT_OFFSET : (onLane ? HALF_LANE : 0);
        car.lat = (car.lat || 0) + (latTarget - (car.lat || 0)) * Math.min(1, dt * 4);

        // Standstill timer (give-up/overtake semantics): absolute test.
        if (car.v < 0.6) car.stuck = (car.stuck || 0) + dt; else car.stuck = 0;
        // Stress + crawl-impatience build on RELATIVE speed with hysteresis:
        // a queue rarely stands fully still — a conga line rolls at half
        // cruising speed, which never tripped the old absolute 0.6 m/s tests
        // (drivers stayed serenely calm through ten-minute rolling jams).
        // Recovery only starts above 75% of cruise, so stop-and-go keeps accruing.
        const v0 = sim.speedKmh / 3.6;
        if (car.v < 0.6 * v0) {
          tr.stress = Math.min(1, tr.stress + dt * (0.02 + 0.05 * tr.stressProne));
          car.crawl = (car.crawl || 0) + dt;
        } else if (car.v > 0.75 * v0) {
          tr.stress = Math.max(0, tr.stress - dt * 0.05);
          car.crawl = Math.max(0, (car.crawl || 0) - dt * 2);
        }

        // Re-planning as a PROACTIVE driver decision: react to congestion on the
        // road AHEAD (current + next edge), independent of the car's own speed —
        // aggressive drivers (the impatient overtakers, who otherwise never sit
        // still long enough to trip a stuck-timer) divert early at a low
        // congestion level; patient drivers only re-plan once a jam is severe.
        // Only from a graph edge heading to a junction. Throttled globally
        // (≤ ~1 Dijkstra / 0.4 s sim time) and per car; the attempt is marked
        // whether or not a better route existed, so a stuck car with no
        // alternative keeps counting toward give-up.
        const curEdge = li.edgeId >= 0 ? sim.net.edges[li.edgeId] : null;
        const nextSeg = car.path[car.segIndex + 1];
        const nextEdge = nextSeg && nextSeg.edgeId >= 0 ? sim.net.edges[nextSeg.edgeId] : null;
        const congAhead = Math.max(curEdge ? (curEdge.cong || 0) : 0, nextEdge ? (nextEdge.cong || 0) : 0);
        const congGate = 0.7 - 0.3 * (tr.aggr || 0);       // aggr 1 → 0.40, aggr 0 → 0.70 (aggressive react to a milder jam)
        const rerouteCooldown = 4 + 8 * (1 - (tr.aggr || 0)); // aggr 1 → 4 s, aggr 0 → 12 s (aggressive re-plan more often)
        // Global throttle is WALL-clock (not sim-time): at tempo 20 a sim-time
        // gate lets the O(n²) dijkstraCong fire nearly every frame — exactly
        // when the user is watching a jam. ≤10 replans/s regardless of tempo.
        if (!car.crashed &&
            (congAhead > congGate || (car.state === "toExit" && (car.crawl || 0) > 15)) &&
            li.laneKey != null && li.endNode != null && li.endNode >= 0 &&
            (performance.now() - (sim._lastRerouteWall || -1e9) >= 100) &&
            (sim.t - (car._reroutedAt || -1e9)) > rerouteCooldown) {
          car._reroutedAt = sim.t; sim._lastRerouteWall = performance.now(); sim._rerouteAttempts = (sim._rerouteAttempts || 0) + 1;
          if (reroute(car)) { car.stuck = 0; car.crawl = 0; car._didReroute = true; sim.reroutes = (sim.reroutes || 0) + 1; }
        }

        // Settling: a driver crawling in queue toward its assigned stall gives
        // up on it and takes a free stall nearby instead — nobody inches past
        // open spots for minutes to park by the door. Triggered on crawl-time
        // (see above), with patience scaled by personality: stressed and
        // aggressive drivers settle after ~6 s of crawling, calm ones hold out
        // ~18 s. Same wall-clock Dijkstra throttle as reroute.
        if (!car.crashed && car.state === "toStall" &&
            (car._settleCount || 0) < 3 && // settle once or twice like a real driver — not a stall-hopping loop
            (car.crawl || 0) > 6 + 12 * (1 - Math.max(tr.stress || 0, tr.aggr || 0)) &&
            (sim.t - (car._settledAt || -1e9)) > 6 &&
            (performance.now() - (sim._lastSettleWall || -1e9) >= 100)) {
          sim._lastSettleWall = performance.now();
          car._settledAt = sim.t; // mark the attempt either way — don't rescan every frame for a car with nothing free nearby
          if (settleForNearbyStall(car)) { car.stuck = 0; car.crawl = 0; car._settleCount = (car._settleCount || 0) + 1; sim.settles = (sim.settles || 0) + 1; }
        }

        // Frustration: stuck far too long → give up and vanish (self-heals any
        // gridlock, and keeps a fully jammed lot from locking forever).
        if (!car.crashed && (car.stuck > 120 || (car.crawl || 0) > 240)) {
          if (car.stallIdx >= 0 && state.parking.stalls[car.stallIdx]) state.parking.stalls[car.stallIdx].reserved = false;
          car._dead = true;
          sim.gaveUp = (sim.gaveUp || 0) + 1;
          continue;
        }

        if (pathRemaining(car) < 0.06) {
          if (car.state === "toStall") parkCar(car);
          else car._dead = true;
        }
      }

      // Reap finished cars.
      if (sim.cars.some((c) => c._dead)) sim.cars = sim.cars.filter((c) => !c._dead);

      // ---- pedestrians: walk to the building and back (drives dwell time) ----
      const hPed = sim.hourNow();
      for (const ped of sim.peds) {
        // Closing time empties the building: shoppers leave when the door
        // shuts even if their planned visit had time left.
        const destBldg = ped.car && ped.car.destB >= 0 ? state.buildings[ped.car.destB] : null;
        const destClosed = destBldg && PS.buildingOpen && !PS.buildingOpen(destBldg, hPed);
        if (ped.phase === "inBuilding") { if (sim.t >= ped.shopUntil || destClosed) ped.phase = "toStall"; continue; }
        ped.gawk = false;
        for (const cp of sim._crashPts) { if (Math.abs(ped.x - cp[0]) < 11 && Math.abs(ped.y - cp[1]) < 11) { ped.gawk = true; break; } }
        if (ped.gawk) continue; // stop and look at the crash
        const route = ped.route || [ped.phase === "toDoor" ? ped.door : ped.stall];
        const tgt = route[Math.min(ped.wpi || 0, route.length - 1)];
        const dx = tgt[0] - ped.x, dy = tgt[1] - ped.y, d = Math.hypot(dx, dy);
        const stepd = ped.speed * dt;
        if (d <= stepd) {
          ped.x = tgt[0]; ped.y = tgt[1];
          if ((ped.wpi || 0) < route.length - 1) { ped.wpi = (ped.wpi || 0) + 1; }
          else if (ped.phase === "toDoor") {
            ped.route = [...route].reverse(); ped.wpi = 1; // walk the same way back to the car
            if (destClosed) ped.phase = "toStall"; // locked door — turn straight back
            else { ped.phase = "inBuilding"; ped.shopUntil = sim.t + dwellSeconds() * 0.6 * dwellFactorFor(ped.car.destB); }
          }
          else { ped._done = true; startLeaving(ped.car); }
        } else { ped.x += (dx / d) * stepd; ped.y += (dy / d) * stepd; }
      }
      if (sim.peds.some((p) => p._done)) sim.peds = sim.peds.filter((p) => !p._done);

      // ---- ped/vehicle conflict points (safety heatmap), throttled ----
      sim._confTick++;
      if (sim._confTick % 4 === 0) {
        for (const ped of sim.peds) {
          if (ped.phase === "inBuilding") continue;
          for (const car of sim.cars) {
            if (car.state !== "toStall" && car.state !== "toExit") continue;
            if (Math.abs(ped.x - car.x) < 5 && Math.abs(ped.y - car.y) < 5) {
              const k = Math.round(ped.x / 4) + "," + Math.round(ped.y / 4);
              sim.conflict.set(k, Math.min(1, (sim.conflict.get(k) || 0) + 0.12));
              // Non-decaying twin for the period heatmap export.
              if (!sim._confPeriod) sim._confPeriod = new Map();
              sim._confPeriod.set(k, (sim._confPeriod.get(k) || 0) + 1);
              break;
            }
          }
        }
      }
      if (sim._confTick % 20 === 0) {
        for (const [k, v] of sim.conflict) { const nv = v * 0.9; if (nv < 0.03) sim.conflict.delete(k); else sim.conflict.set(k, nv); }
      }

      updateStats(dt);
    }

    function updateStats(dt) {
      // Per-edge congestion (EMA of 1 - meanSpeed/vmax).
      const acc = new Map(); // edgeId -> {sumV,n}
      for (const car of sim.cars) {
        if ((car.state !== "toStall" && car.state !== "toExit") || !car._li || car._li.laneKey == null) continue;
        const edgeId = parseInt(car._li.laneKey, 10);
        const a = acc.get(edgeId) || { sumV: 0, n: 0 };
        a.sumV += car.v; a.n += 1; acc.set(edgeId, a);
      }
      const vm = vmax();
      let worst = -1, worstC = 0, maxC = 0;
      for (const e of sim.net.edges) {
        const a = acc.get(e.id);
        const inst = a ? Math.max(0, 1 - a.sumV / a.n / vm) : 0;
        e.load = a ? a.n : 0;
        e.cong = e.cong * 0.88 + inst * 0.12;
        e._congSum = (e._congSum || 0) + e.cong * dt; // time-integrated, for the period heatmap (avg = _congSum / sim.t)
        if (e.cong > maxC) maxC = e.cong;
        if (e.load > 0 && e.cong > worstC) { worstC = e.cong; worst = e.id; }
      }
      sim._maxCong = maxC; // cheap global jam indicator (gates the cong-aware arrival fields)

      let circ = 0, parked = 0, queue = 0;
      for (const car of sim.cars) {
        if (car.state === "parked") parked++;
        else if (car.state === "toStall" || car.state === "toExit") { circ++; if (car.v < 0.4 || (car.crawl || 0) > 3) queue++; }
      }
      // Rolling history for the time-series chart (sampled, bounded).
      if (!sim.history) sim.history = [];
      if (sim.t - (sim._histT != null ? sim._histT : -1e9) >= 20) {
        sim._histT = sim.t;
        sim.history.push({ t: sim.t, h: sim.hourNow(), d: sim.dateStr, c: circ, p: parked, q: queue });
        if (sim.history.length > 4320) sim.history.shift(); // 24 h at 20 s sampling
        // Stall utilization for the period heatmap: occupied-time per stall.
        for (const st of state.parking.stalls) if (st.occupied) st._occT = (st._occT || 0) + 20;
        // Queue hotspots: accumulate WHERE queued cars sit (8 m grid cells) so
        // the period heatmap can show the spots where queues actually form.
        if (!sim._queueGrid) sim._queueGrid = new Map();
        for (const car of sim.cars) {
          if (car.state !== "toStall" && car.state !== "toExit") continue;
          if (car.v < 0.4 || (car.crawl || 0) > 3) {
            const key = Math.round(car.x / 8) + "," + Math.round(car.y / 8);
            sim._queueGrid.set(key, (sim._queueGrid.get(key) || 0) + 20);
          }
        }
      }
      const total = state.parking.stalls.length || 1;
      sim.stats = {
        circulating: circ, parked, queuing: queue,
        avgSearch: sim.recentSearch.length ? sim.recentSearch.reduce((s, v) => s + v, 0) / sim.recentSearch.length : 0,
        occupancyPct: Math.round((parked / total) * 100),
        worstEdge: worst, worstCong: worstC,
        turnedAway: sim.turnedAway, collisions: sim.collisions,
      };
    }

    // ---- public API ----
    sim.step = step;
    sim.rebuild = function () {
      sim.net = PS.buildNetwork(state);
      sim.entCount = null; sim._gateAcc = null; // reset per-entrance arrival streams for the new network
      sim.visitTotals = {};
      sim.cars = [];
      sim.peds = [];
      sim.conflict.clear();
      sim._crashPts = [];
      sim._arrAcc = 0;
      // Seed the lot from the current static occupancy as already-parked cars.
      const stalls = state.parking.stalls;
      for (let k = 0; k < stalls.length; k++) {
        const s = stalls[k];
        if (s.occupied) {
          s.reserved = true;
          s.color = s.color || carColor();
          sim.cars.push({ kind: "car", state: "parked", stallIdx: k, x: s.cx, y: s.cy, departAt: sim.t + dwellSeconds() * sim.rng(), color: s.color, spawnT: sim.t, traits: makeTraits(), stuck: 0 });
        } else s.reserved = false;
      }
      // Spatial grid of stalls (positions fixed) so moving cars can cheaply avoid
      // driving over parked cars.
      sim._stallGrid = new Map();
      for (let k = 0; k < stalls.length; k++) {
        const key = Math.floor(stalls[k].cx / 6) + "," + Math.floor(stalls[k].cy / 6);
        if (!sim._stallGrid.has(key)) sim._stallGrid.set(key, []);
        sim._stallGrid.get(key).push(k);
      }
    };
    sim.reseed = function (seed) {
      const hold = sim.hourNow ? sim.hourNow() : (sim.clockStart || 8); // reset the TRAFFIC, not the time of day
      sim.seed = seed; sim.rng = mulberry32(seed);
      sim.t = 0;
      sim.clockStart = hold; sim.parkedTotal = 0; sim.turnedAway = 0; sim.collisions = 0; sim.gaveUp = 0; sim._arrAcc = 0; sim.recentSearch = [];
      // Clear the cars too — reseeding only the peds orphaned ped-driven
      // parked cars (their departAt stayed pinned at Infinity forever).
      sim.cars = []; sim.selectedCar = null;
      sim.history = []; sim._histT = null;
      if (state.parking) for (const st of state.parking.stalls) st._occT = 0;
      if (sim.net) for (const e of sim.net.edges) e._congSum = 0;
      sim._queueGrid = new Map();
      sim._confPeriod = new Map();
      sim._periodStart = { d: sim.dateStr, h: sim.hourNow ? sim.hourNow() : 8 };
      if (state.parking) for (const s of state.parking.stalls) s.reserved = false;
      sim.peds = []; sim.conflict.clear(); sim._crashPts = []; sim.entCount = null; sim._gateAcc = null; sim._gateWait = null; sim.visitTotals = {}; sim.reroutes = 0; sim.settles = 0; sim.diverted = 0;
    };
    // Force a car to stall/crash: it stops and blocks its lane for a while.
    sim.crash = function (car) {
      if (!car || car.crashed) return;
      if (car.state !== "toStall" && car.state !== "toExit") return;
      car.crashed = true; car.v = 0; car.overtaking = false;
      car.crashedUntil = sim.t + 20 + 25 * sim.rng();
      sim.collisions++;
    };
    // Pick the nearest moving car to a world point (for click-to-select).
    sim.pickCar = function (wx, wy, maxDist) {
      let best = null, bd = maxDist * maxDist;
      for (const car of sim.cars) {
        if (car.state !== "toStall" && car.state !== "toExit") continue;
        const d = (car.x - wx) * (car.x - wx) + (car.y - wy) * (car.y - wy);
        if (d < bd) { bd = d; best = car; }
      }
      return best;
    };
    return sim;
  };

  // ======================================================================
  // 3. Rendering hooks (called from render.js, inside the site clip)
  // ======================================================================
  function congColor(c, alpha) {
    // green -> amber -> red
    let r, g2, b;
    if (c < 0.5) { const t = c / 0.5; r = 90 + t * 150; g2 = 175 - t * 5; b = 70 - t * 40; }
    else { const t = (c - 0.5) / 0.5; r = 240 - t * 20; g2 = 170 - t * 120; b = 30 + t * 10; }
    return "rgba(" + (r | 0) + "," + (g2 | 0) + "," + (b | 0) + "," + alpha + ")";
  }

  PS.drawTrafficHeat = function (ctx, cam, state) {
    const sim = state.traffic;
    if (!sim || !sim.net || !state.showHeat) return;
    ctx.save();
    ctx.lineCap = "round";
    for (const e of sim.net.edges) {
      if (e.cong < 0.06 && e.load === 0) continue;
      const A = sim.net.nodes[e.a], B = sim.net.nodes[e.b];
      if (!A || !B) continue;
      const p1 = PS.w2s(cam, A.x, A.y), p2 = PS.w2s(cam, B.x, B.y);
      ctx.strokeStyle = congColor(Math.min(1, e.cong), 0.5);
      ctx.lineWidth = Math.max(3, 4.5 * cam.scale);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    }
    // Pulse the worst spot. worstEdge can be a stale index after a network
    // rebuild, so guard against a missing edge/nodes before dereferencing.
    if (sim.stats.worstEdge >= 0 && sim.stats.worstCong > 0.4) {
      const e = sim.net.edges[sim.stats.worstEdge];
      const A = e && sim.net.nodes[e.a], B = e && sim.net.nodes[e.b];
      if (e && A && B) {
        const m = PS.w2s(cam, (A.x + B.x) / 2, (A.y + B.y) / 2);
        ctx.strokeStyle = "rgba(210,40,40,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(m[0], m[1], Math.max(10, 9 * cam.scale), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  };

  function drawCarBody(ctx, cam, x, y, hx, hy, color, stopped) {
    if (!hx && !hy) hx = 1; // degenerate heading fallback
    const s = PS.w2s(cam, x, y);
    const L = CAR_LEN * cam.scale, W = CAR_W * cam.scale;
    ctx.save();
    ctx.translate(s[0], s[1]);
    ctx.rotate(Math.atan2(hy, hx));
    ctx.fillStyle = color;
    ctx.beginPath();
    const r = Math.min(L, W) * 0.28;
    roundRect(ctx, -L / 2, -W / 2, L, W, r);
    ctx.fill();
    // windshield hint
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    roundRect(ctx, L * 0.08, -W * 0.36, L * 0.28, W * 0.72, r * 0.5); ctx.fill();
    if (stopped) {
      ctx.fillStyle = "rgba(220,40,40,0.85)";
      ctx.beginPath(); ctx.arc(-L / 2, 0, Math.max(1.2, W * 0.18), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBubble(ctx, sx, sy, txt) {
    ctx.save();
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = 20, h = 18;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1;
    roundRect(ctx, sx - w / 2, sy - h, w, h, 6);
    ctx.fill(); ctx.stroke();
    ctx.fillText(txt, sx, sy - h / 2 - 1);
    ctx.restore();
  }

  PS.drawTrafficAgents = function (ctx, cam, state) {
    const sim = state.traffic;
    if (!sim || !sim.net) return;
    // Drop a stale selection (its car already left the lot).
    if (sim.selectedCar && sim.cars.indexOf(sim.selectedCar) < 0) sim.selectedCar = null;
    for (const car of sim.cars) {
      if (car.state !== "toStall" && car.state !== "toExit") continue;
      // Lateral offset: keep-right lane position (and overtaking swing).
      let ox = car.x, oy = car.y;
      if (car.lat) { ox += -(car.hy || 0) * car.lat; oy += (car.hx || 0) * car.lat; }
      // NB: pass headings directly — `car.hx || 1` would turn a legitimate 0
      // (straight up/down) into 1 and render vertical cars at 45°.
      drawCarBody(ctx, cam, ox, oy, car.hx, car.hy, car.color, car.v < 0.4 || car.crashed);
      const s = PS.w2s(cam, ox, oy);
      if (car === sim.selectedCar) {
        ctx.strokeStyle = "#3b5bdb"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(9, 5 * cam.scale), 0, Math.PI * 2); ctx.stroke();
        // Line to its destination building door.
        if (car.destB != null && car.destB >= 0 && sim.net.doors[car.destB]) {
          const d = sim.net.doors[car.destB], ds = PS.w2s(cam, d[0], d[1]);
          ctx.save(); ctx.strokeStyle = "rgba(59,91,219,0.6)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(ds[0], ds[1]); ctx.stroke(); ctx.restore();
        }
      }
      // Emoji sits ON the car (just above its centre), scaling with zoom.
      let face = null;
      if (car.crashed) face = "💥";
      else if (car.overtaking) face = "😠";
      else if (car.traits && car.traits.stress > 0.8) face = "🤬";
      else if (car.traits && car.traits.stress > 0.6) face = "😤";
      if (face) {
        ctx.save();
        ctx.globalAlpha = 1;
        const fs = Math.max(11, 2.6 * cam.scale);
        const ex = s[0], ey = s[1] - 1.4 * cam.scale;
        // Opaque white disc behind the face so it always reads solidly.
        ctx.beginPath(); ctx.arc(ex, ey, fs * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.font = fs + "px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#000";
        ctx.fillText(face, ex, ey);
        ctx.restore();
      }
    }
  };

  // Gate markers (entrances = green "IN", exits = orange "UT"), drawn from the
  // user-editable state.gates so they show even when the sim isn't running.
  PS.drawGates = function (ctx, cam, state) {
    const gates = state.gates || [];
    const sel = state.selection;
    for (let i = 0; i < gates.length; i++) {
      const gt = gates[i];
      const s = PS.w2s(cam, gt.x, gt.y);
      const r = 9;
      ctx.fillStyle = gt.type === "out" ? "#e8590c" : "#2f9e44";
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.fill();
      if (sel && sel.type === "gate" && sel.index === i) {
        ctx.strokeStyle = "#3b5bdb"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(s[0], s[1], r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = "#fff"; ctx.font = "700 9px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(gt.type === "out" ? "UT" : "IN", s[0], s[1]);
    }
  };

  PS.drawConflicts = function (ctx, cam, state) {
    const sim = state.traffic;
    if (!sim || !state.showConflicts) return;
    ctx.save();
    for (const [k, v] of sim.conflict) {
      const p = k.split(",");
      const s = PS.w2s(cam, (+p[0]) * 4, (+p[1]) * 4);
      ctx.fillStyle = "rgba(240,110,20," + (0.12 + 0.5 * v) + ")";
      ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(4, (2.5 + 4 * v) * cam.scale), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  PS.drawPeds = function (ctx, cam, state) {
    const sim = state.traffic;
    if (!sim || !state.showPeds) return;
    for (const ped of sim.peds) {
      if (ped.phase === "inBuilding") continue;
      const s = PS.w2s(cam, ped.x, ped.y);
      const r = Math.max(1.6, 0.85 * cam.scale);
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = ped.gawk ? "#f0a020" : "#149e8c"; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1; ctx.stroke();
      if (ped.gawk) {
        ctx.strokeStyle = "rgba(240,160,32,0.85)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s[0], s[1], r + 2.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  };
})();
