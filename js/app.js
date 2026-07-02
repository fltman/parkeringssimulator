/* app.js — wires the generator, renderer and UI together.
 * State lives in one object; any change flags a regen + redraw on the next frame. */
(function () {
  const PS = window.PS;
  const g = PS.geom;

  // ---- default scene ------------------------------------------------------
  // Site polygon (feet, y down) — a big parcel with a clipped/curved bottom-left,
  // echoing the parcel in the reference clip.
  // Coordinates are in METRES (y down). ~195 x 160 m parcel with a clipped bottom-left.
  function defaultSite() {
    return [
      [18, 18], [214, 18], [214, 158],
      [158, 171], [116, 179], [72, 178],
      [37, 158], [18, 131],
    ];
  }

  function defaultBuildings() {
    return [
      { name: "Retail 1", x: 130, y: 92, w: 64, h: 55, floors: 1, fill: PS.BUILDING_FILLS[0] },
    ];
  }

  // Separate, editable entrance ('in') and exit ('out') gates at the bottom edge.
  function defaultGates(site) {
    const bb = g.bbox(site);
    const cx = (bb.minX + bb.maxX) / 2;
    return [
      { type: "in", x: cx - bb.w * 0.16, y: bb.maxY - 2 },
      { type: "out", x: cx + bb.w * 0.16, y: bb.maxY - 2 },
    ];
  }

  // Deterministic hash in [0,1) from two numbers — stable car occupancy/colours.
  function hash(x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  // Decorative streets + neighbour blocks around the site (built once).
  function buildDecor(site) {
    const bb = g.bbox(site);
    const gap = 7;    // grass verge between site and street (m)
    const sw = 14;    // street width (m)
    const S = {
      top:    { name: "French Pl",    y: bb.minY - gap - sw, x: bb.minX - 36, w: bb.w + 72, h: sw, vertical: false },
      bottom: { name: "Breeze Ter",   y: bb.maxY + gap,      x: bb.minX - 36, w: bb.w + 72, h: sw, vertical: false },
      left:   { name: "E 32nd St",    x: bb.minX - gap - sw, y: bb.minY - 36, w: sw, h: bb.h + 72, vertical: true },
      right:  { name: "Edgewood Ave", x: bb.maxX + gap,      y: bb.minY - 36, w: sw, h: bb.h + 72, vertical: true },
    };
    const streets = Object.values(S).map((r) => ({
      name: r.name,
      vertical: r.vertical,
      poly: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]],
      cx1: r.vertical ? r.x + r.w / 2 : r.x,
      cy1: r.vertical ? r.y : r.y + r.h / 2,
      cx2: r.vertical ? r.x + r.w / 2 : r.x + r.w,
      cy2: r.vertical ? r.y + r.h : r.y + r.h / 2,
    }));

    // Neighbour parcels tiled outside the streets, skipping anything over the site.
    const blocks = [];
    const outer = { minX: bb.minX - 130, minY: bb.minY - 130, maxX: bb.maxX + 130, maxY: bb.maxY + 130 };
    const streetBox = {
      minX: bb.minX - gap - sw, minY: bb.minY - gap - sw,
      maxX: bb.maxX + gap + sw, maxY: bb.maxY + gap + sw,
    };
    const cell = 22;
    let seed = 0;
    for (let x = outer.minX; x < outer.maxX; x += cell) {
      for (let y = outer.minY; y < outer.maxY; y += cell) {
        seed++;
        const r = hash(x * 0.05, y * 0.05);
        if (r < 0.35) continue; // leave some empty lots
        const inStreetRing =
          x + cell > streetBox.minX && x < streetBox.maxX &&
          y + cell > streetBox.minY && y < streetBox.maxY;
        if (inStreetRing) continue; // don't build on the site or its streets
        const m = 3 + r * 4;
        blocks.push({ x: x + m, y: y + m, w: cell - m * 2, h: cell - m * 2 });
      }
    }
    return { streets, blocks };
  }

  // ---- state --------------------------------------------------------------
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  const state = {
    canvas,
    ctx,
    dpr: 1,
    cam: PS.Camera(),
    site: defaultSite(),
    buildings: defaultBuildings(),
    gates: defaultGates(defaultSite()),
    decor: null,
    parking: null,
    selection: null, // { type:'building', index } | { type:'vertex', index }
    showDims: false,
    siteName: "Site A",
    params: Object.assign({}, PS.defaults),
    occupancyFrac: 0.4,
    showHeat: true,
    showPeds: true,
    showConflicts: false,
    follow: false,
    mapMode: false,
    map: null,
    _pin: null,
    layoutMode: "manual", // manual-only: you draw roads / sections / roundabouts
    tool: "select",       // tools: 'select' | 'road' | 'section' | 'round' | 'bldg'
    roads: [],
    sections: [],
    roundabouts: [],
    _draft: null,
  };
  state.decor = buildDecor(state.site);
  state.traffic = PS.createTraffic(state);

  // ---- regen + occupancy --------------------------------------------------
  function applyOccupancy() {
    if (!state.parking) return;
    let occ = 0;
    for (const s of state.parking.stalls) {
      const r = hash(s.cx * 0.13, s.cy * 0.17);
      s.occupied = r < state.occupancyFrac;
      if (s.occupied) {
        const ci = Math.floor(hash(s.cx * 0.31 + 7, s.cy * 0.11 + 3) * PS.CAR_COLORS.length);
        s.color = PS.CAR_COLORS[ci];
        occ++;
      }
    }
    state._occCount = occ;
  }

  function regen() {
    state._analysisWorst = null; // geometry changed → the pinned bottleneck is stale
    state.parking = PS.generateManual(state); // manual-only: fill the drawn sections
    applyOccupancy();
    if (state.traffic) {
      if (state.traffic.running) state.traffic.rebuild();
      else state.traffic.net = PS.buildNetwork(state);
    }
    updateMetrics();
  }

  function updateMetrics() {
    const stalls = state.parking ? state.parking.count : 0;
    let gfa = 0;
    for (const b of state.buildings) gfa += (b.poly ? g.area(b.poly) : b.w * b.h) * (b.floors || 1);
    const area = g.area(state.site); // sf
    const ratio = gfa > 0 ? (stalls / (gfa / 1000)) : 0;
    const occTotal = stalls || 1;
    const occ = state._occCount || 0;
    document.getElementById("m-stalls").textContent = stalls.toLocaleString();
    document.getElementById("m-ratio").textContent = ratio.toFixed(1);
    document.getElementById("m-gfa").textContent = Math.round(gfa).toLocaleString();
    document.getElementById("m-area").textContent = (area / 10000).toFixed(2); // hectares
    document.getElementById("m-occ").textContent = Math.round((occ / occTotal) * 100) + "%";
  }

  // ---- draw scheduling ----------------------------------------------------
  let drawScheduled = false;
  let regenScheduled = false;
  function requestDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      PS.draw(state);
    });
  }
  function requestRegen() {
    if (regenScheduled) return;
    regenScheduled = true;
    requestAnimationFrame(() => {
      regenScheduled = false;
      regen();
      requestDraw();
    });
  }

  // ---- canvas sizing ------------------------------------------------------
  function resize(fit) {
    const rect = canvas.getBoundingClientRect();
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    if (state.mapMode && state.map) { state.map.invalidateSize(); syncCamFromMap(); }
    else if (fit) PS.fitCamera(state.cam, state.site, rect.width, rect.height, 24);
    requestDraw();
  }
  window.addEventListener("resize", () => resize(false));

  // ---- real-map mode (Leaflet, lazy-loaded) -------------------------------
  const D2R = Math.PI / 180;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (loadLeaflet._p) return loadLeaflet._p;
    loadLeaflet._p = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      js.onload = () => resolve();
      js.onerror = () => reject(new Error("Leaflet kunde inte laddas (offline?)"));
      document.head.appendChild(js);
    });
    return loadLeaflet._p;
  }
  const BASES = {
    // Clean light street map (CARTO Positron) — reads well under the lot overlay.
    map: { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", attribution: "© OpenStreetMap © CARTO", maxZoom: 20, subdomains: "abcd" },
    osm: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap", maxZoom: 19 },
  };
  function initMap() {
    if (state.map) return;
    state.map = L.map("map", { zoomControl: true, zoomAnimation: false, zoomSnap: 0, attributionControl: true });
    const c = g.centroid(state.site);
    state._pin = c;
    state.map.setView([59.334, 18.063], 18); // default: Stockholm
    state.map.on("move zoom", () => { syncCamFromMap(); requestDraw(); });
  }
  function setBase(layerKind) {
    if (state._base) { state.map.removeLayer(state._base); state._base = null; }
    const b = BASES[layerKind] || BASES.map;
    const opts = { attribution: b.attribution, maxZoom: b.maxZoom };
    if (b.subdomains) opts.subdomains = b.subdomains;
    state._base = L.tileLayer(b.url, opts).addTo(state.map);
  }
  const EARTH_R = 6378137, R2D = 180 / Math.PI;
  // Pin the lot to a GEOGRAPHIC anchor so it rides with the ground on pan/zoom
  // (screen-centring made the overlay drift out of sync when zooming).
  function syncCamFromMap() {
    if (!state.map || !state._anchor) return;
    const a = state._anchor;
    const p0 = state.map.latLngToContainerPoint([a.lat, a.lng]);
    const eastLng = a.lng + (100 / (EARTH_R * Math.cos(a.lat * D2R))) * R2D; // 100 m east
    const pe = state.map.latLngToContainerPoint([a.lat, eastLng]);
    state.cam.scale = Math.hypot(pe.x - p0.x, pe.y - p0.y) / 100; // px per metre
    const pin = state._pin || [0, 0];
    state.cam.tx = p0.x - pin[0] * state.cam.scale;
    state.cam.ty = p0.y - pin[1] * state.cam.scale;
  }
  function setBasemap(kind) {
    if (kind === "styled") {
      state.mapMode = false;
      document.getElementById("map").style.display = "none";
      resize(true);
      return;
    }
    // osm / sat → real map
    document.getElementById("map").style.display = "block";
    loadLeaflet().then(() => {
      initMap();
      state._pin = g.centroid(state.site);
      state._anchor = state.map.getCenter(); // pin the lot centroid to the current map centre
      setBase(kind);
      state.mapMode = true;
      state.map.invalidateSize();
      syncCamFromMap();
      requestDraw();
      // The map div just became visible — re-measure once layout settles so tiles show.
      setTimeout(() => { if (state.mapMode && state.map) { state.map.invalidateSize(); syncCamFromMap(); requestDraw(); } }, 80);
    }).catch((err) => {
      document.getElementById("map").style.display = "none";
      alert("Kunde inte ladda kartan: " + err.message + "\nStiliserad vy används.");
      segSetActive("base-seg", "styled");
    });
  }

  // ---- interaction --------------------------------------------------------
  const HANDLE_PX = 9;
  let drag = null; // active drag descriptor

  function mouseWorld(e) {
    const rect = canvas.getBoundingClientRect();
    return PS.s2w(state.cam, e.clientX - rect.left, e.clientY - rect.top);
  }
  function mouseScreen(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  // Which building corner (if any) is under the cursor for the selected building.
  function hitHandle(scr) {
    if (!state.selection || state.selection.type !== "building") return null;
    const b = state.buildings[state.selection.index];
    const corners = [
      ["nw", b.x, b.y], ["ne", b.x + b.w, b.y],
      ["sw", b.x, b.y + b.h], ["se", b.x + b.w, b.y + b.h],
    ];
    for (const [name, wx, wy] of corners) {
      const s = PS.w2s(state.cam, wx, wy);
      if (Math.abs(s[0] - scr[0]) <= HANDLE_PX && Math.abs(s[1] - scr[1]) <= HANDLE_PX) return name;
    }
    return null;
  }

  function buildingAt(w) {
    for (let i = state.buildings.length - 1; i >= 0; i--) {
      const b = state.buildings[i];
      if (b.poly && b.poly.length >= 3) { if (g.pointInPolygon(w, b.poly)) return i; }
      else if (g.pointInRect(w[0], w[1], b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.rot || 0)) return i;
    }
    return -1;
  }
  // Vertex of the currently-selected polygon building/section under the cursor.
  function polyVertexAt(scr) {
    const sel = state.selection;
    if (!sel) return -1;
    const item = sel.type === "building" ? state.buildings[sel.index]
      : sel.type === "section" ? state.sections[sel.index] : null;
    const poly = item && item.poly;
    if (!poly) return -1;
    for (let i = 0; i < poly.length; i++) {
      const s = PS.w2s(state.cam, poly[i][0], poly[i][1]);
      if (Math.hypot(s[0] - scr[0], s[1] - scr[1]) <= HANDLE_PX + 2) return i;
    }
    return -1;
  }
  // ---- rotated-rect edit handles (buildings + sections) ----
  function selRect() {
    const sel = state.selection;
    if (sel && sel.type === "building") {
      const b = state.buildings[sel.index];
      if (b.poly) return null; // polygons use anchor handles, not a rect box
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rot: b.rot || 0,
        apply(cx, cy, w, h, rot) { b.w = Math.max(6, w); b.h = Math.max(6, h); b.x = cx - b.w / 2; b.y = cy - b.h / 2; b.rot = rot; } };
    }
    if (sel && sel.type === "section") {
      const s = state.sections[sel.index];
      if (s.poly) return null;
      return { cx: s.cx, cy: s.cy, w: s.w, h: s.h, rot: s.rot || 0,
        apply(cx, cy, w, h, rot) { s.cx = cx; s.cy = cy; s.w = Math.max(5, w); s.h = Math.max(5, h); s.rot = rot; } };
    }
    return null;
  }
  function rotHandleWorld(r) {
    const a = r.rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    const lx = 0, ly = -r.h / 2 - 6;
    return [r.cx + lx * cs - ly * sn, r.cy + lx * sn + ly * cs];
  }
  function rectHandleAt(scr) {
    const r = selRect();
    if (!r) return null;
    const corners = g.rectPoints(r.cx, r.cy, r.w, r.h, r.rot, false);
    for (let i = 0; i < 4; i++) {
      const s = PS.w2s(state.cam, corners[i][0], corners[i][1]);
      if (Math.hypot(s[0] - scr[0], s[1] - scr[1]) <= HANDLE_PX + 2) return { kind: "corner", i };
    }
    const rh = rotHandleWorld(r), s = PS.w2s(state.cam, rh[0], rh[1]);
    if (Math.hypot(s[0] - scr[0], s[1] - scr[1]) <= HANDLE_PX + 2) return { kind: "rot" };
    return null;
  }
  function unrotate(px, py, cx, cy, rotDeg) {
    const a = -rotDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = px - cx, dy = py - cy;
    return [dx * c - dy * s, dx * s + dy * c];
  }
  function roadAt(w) {
    for (let i = state.roads.length - 1; i >= 0; i--) {
      const r = state.roads[i];
      for (let k = 0; k < r.length - 1; k++) if (g.distPointToSegment(w, r[k], r[k + 1]) < 4) return i;
    }
    return -1;
  }
  function roadVertexAt(scr) {
    if (!state.selection || state.selection.type !== "road") return -1;
    const r = state.roads[state.selection.index];
    for (let i = 0; i < r.length; i++) { const s = PS.w2s(state.cam, r[i][0], r[i][1]); if (Math.hypot(s[0] - scr[0], s[1] - scr[1]) <= HANDLE_PX + 2) return i; }
    return -1;
  }
  function roundAt(w) {
    for (let i = state.roundabouts.length - 1; i >= 0; i--) {
      const rb = state.roundabouts[i];
      if (Math.abs(Math.hypot(w[0] - rb.x, w[1] - rb.y) - rb.r) < 5) return i;
    }
    return -1;
  }
  function roundHandleAt(scr) {
    if (!state.selection || state.selection.type !== "round") return null;
    const rb = state.roundabouts[state.selection.index];
    const cS = PS.w2s(state.cam, rb.x, rb.y);
    if (Math.hypot(cS[0] - scr[0], cS[1] - scr[1]) <= HANDLE_PX + 2) return "center";
    const eS = PS.w2s(state.cam, rb.x + rb.r, rb.y);
    if (Math.hypot(eS[0] - scr[0], eS[1] - scr[1]) <= HANDLE_PX + 2) return "radius";
    return null;
  }
  canvas.addEventListener("mousedown", (e) => {
    const w = mouseWorld(e);
    const scr = mouseScreen(e);

    // Building-draw works in BOTH automatic and manual mode (buildings aren't a
    // "manual layout" thing — they matter either way).
    if (state.tool === "bldg") {
      if (!state._draft || state._draft.type !== "poly" || state._draft.kind !== "bldg") state._draft = { type: "poly", kind: "bldg", pts: [], cursor: w };
      const pts = state._draft.pts;
      if (pts.length >= 3 && Math.hypot(pts[0][0] - w[0], pts[0][1] - w[1]) < 3) { finishPoly(); return; }
      pts.push([w[0], w[1]]); requestDraw(); return;
    }
    // The other drawing tools (roads, parking sections, roundabouts) are manual-only.
    if (state.layoutMode === "manual" && state.tool !== "select") {
      if (state.tool === "road") {
        if (!state._draft || state._draft.type !== "road") state._draft = { type: "road", pts: [], cursor: w };
        const pts = state._draft.pts;
        if (pts.length >= 2 && Math.hypot(pts[0][0] - w[0], pts[0][1] - w[1]) < 3) { finishRoad(); return; }
        pts.push([w[0], w[1]]); requestDraw(); return;
      }
      if (state.tool === "section") {
        // Click out anchor points; click the first point again (or dblclick/Enter) to finish.
        if (!state._draft || state._draft.type !== "poly" || state._draft.kind !== "section") state._draft = { type: "poly", kind: "section", pts: [], cursor: w };
        const pts = state._draft.pts;
        if (pts.length >= 3 && Math.hypot(pts[0][0] - w[0], pts[0][1] - w[1]) < 3) { finishPoly(); return; }
        pts.push([w[0], w[1]]); requestDraw(); return;
      }
      if (state.tool === "round") { state._draft = { type: "round", center: w, r: 0 }; drag = { type: "drawround" }; return; }
    }
    // Edit handles of the current selection (resize/rotate a rect, move a road
    // vertex, or a roundabout centre/radius) — checked before re-selecting.
    if (!(state.layoutMode === "manual" && state.tool !== "select")) {
      const pv = polyVertexAt(scr);
      if (pv >= 0) { drag = { type: "polyvertex", vi: pv }; return; }
      const rh = rectHandleAt(scr);
      if (rh) {
        const r = selRect();
        if (rh.kind === "rot") drag = { type: "rotrect" };
        else { const corners = g.rectPoints(r.cx, r.cy, r.w, r.h, r.rot, false); drag = { type: "resizerect", opp: corners[(rh.i + 2) % 4], rot: r.rot }; }
        return;
      }
      const rv = roadVertexAt(scr);
      if (rv >= 0) { drag = { type: "roadvertex", road: state.selection.index, vi: rv }; return; }
      const rhd = roundHandleAt(scr);
      if (rhd) { drag = { type: rhd === "center" ? "roundcenter" : "roundradius", index: state.selection.index }; return; }
    }

    // Select/move sections, roads or roundabouts (manual, select tool).
    if (state.layoutMode === "manual" && state.tool === "select") {
      const si = sectionAt(w);
      if (si >= 0) {
        state.selection = { type: "section", index: si };
        drag = { type: "section", index: si, lx: w[0], ly: w[1] };
        syncSelectionUI(); requestDraw(); return;
      }
      const ri = roadAt(w);
      if (ri >= 0) { state.selection = { type: "road", index: ri }; syncSelectionUI(); requestDraw(); return; }
      const ci = roundAt(w);
      if (ci >= 0) { state.selection = { type: "round", index: ci }; syncSelectionUI(); requestDraw(); return; }
    }

    // Select a moving car if one is under the cursor (takes priority).
    if (state.traffic && state.traffic.net) {
      const car = state.traffic.pickCar(w[0], w[1], 4);
      if (car) { selectCar(car); return; }
    }

    // Select / drag an entrance or exit gate.
    const gi = gateAt(w);
    if (gi >= 0) {
      if (state.traffic && state.traffic.selectedCar) deselectCar();
      state.selection = { type: "gate", index: gi };
      drag = { type: "gate", index: gi };
      syncSelectionUI();
      requestDraw();
      return;
    }

    const bi = buildingAt(w);
    if (bi >= 0) {
      state.selection = { type: "building", index: bi };
      drag = { type: "move", index: bi, lx: w[0], ly: w[1] };
      syncSelectionUI();
      requestDraw();
      return;
    }

    // Empty space: deselect + pan (in map mode, pan the map instead of the cam).
    if (state.selection) { state.selection = null; syncSelectionUI(); }
    if (state.traffic && state.traffic.selectedCar) deselectCar();
    if (state.mapMode && state.map) {
      drag = { type: "mappan", sx: e.clientX, sy: e.clientY };
    } else {
      drag = { type: "pan", sx: e.clientX, sy: e.clientY, tx: state.cam.tx, ty: state.cam.ty };
    }
    canvas.classList.add("dragging");
    requestDraw();
  });

  window.addEventListener("mousemove", (e) => {
    if (state.layoutMode === "manual" && state.tool === "road" && state._draft && state._draft.type === "road" && !drag) {
      state._draft.cursor = mouseWorld(e); requestDraw(); return;
    }
    if ((state.tool === "bldg" || (state.layoutMode === "manual" && state.tool === "section")) && state._draft && state._draft.type === "poly" && !drag) {
      state._draft.cursor = mouseWorld(e); requestDraw(); return;
    }
    if (!drag) return;
    if (drag.type === "pan") {
      state.cam.tx = drag.tx + (e.clientX - drag.sx);
      state.cam.ty = drag.ty + (e.clientY - drag.sy);
      requestDraw();
      return;
    }
    if (drag.type === "mappan") {
      state.map.panBy([-(e.clientX - drag.sx), -(e.clientY - drag.sy)], { animate: false });
      drag.sx = e.clientX; drag.sy = e.clientY; // map 'move' resyncs cam + redraws
      return;
    }
    const w = mouseWorld(e);
    if (drag.type === "move") {
      const b = state.buildings[drag.index];
      const ddx = w[0] - drag.lx, ddy = w[1] - drag.ly; drag.lx = w[0]; drag.ly = w[1];
      if (b.poly) b.poly = b.poly.map((p) => [p[0] + ddx, p[1] + ddy]);
      else { b.x += ddx; b.y += ddy; }
      requestRegen();
    } else if (drag.type === "polyvertex") {
      const sel = state.selection;
      const poly = sel && sel.type === "building" ? state.buildings[sel.index].poly
        : sel && sel.type === "section" ? state.sections[sel.index].poly : null;
      if (poly) { poly[drag.vi] = [w[0], w[1]]; requestRegen(); }
    } else if (drag.type === "resizerect") {
      // Drag a corner; the opposite corner stays fixed. Works in the rect's own
      // rotated frame (buildings + sections).
      const nc = [(w[0] + drag.opp[0]) / 2, (w[1] + drag.opp[1]) / 2];
      const loc = unrotate(w[0], w[1], nc[0], nc[1], drag.rot);
      const r = selRect();
      if (r) { r.apply(nc[0], nc[1], Math.abs(loc[0]) * 2, Math.abs(loc[1]) * 2, drag.rot); requestRegen(); }
    } else if (drag.type === "rotrect") {
      const r = selRect();
      if (r) {
        const ang = Math.atan2(w[1] - r.cy, w[0] - r.cx) * 180 / Math.PI + 90;
        r.apply(r.cx, r.cy, r.w, r.h, ang);
        if (state.selection.type === "section") { document.getElementById("sec-rot").value = ((ang % 360) + 360) % 360; document.getElementById("sec-rot-val").textContent = Math.round(((ang % 360) + 360) % 360); }
        requestRegen();
      }
    } else if (drag.type === "roadvertex") {
      state.roads[drag.road][drag.vi] = [w[0], w[1]]; requestDraw();
    } else if (drag.type === "roundcenter") {
      const rb = state.roundabouts[drag.index]; rb.x = w[0]; rb.y = w[1]; requestDraw();
    } else if (drag.type === "roundradius") {
      const rb = state.roundabouts[drag.index]; rb.r = Math.max(3, Math.hypot(w[0] - rb.x, w[1] - rb.y)); requestDraw();
    } else if (drag.type === "gate") {
      state.gates[drag.index].x = w[0];
      state.gates[drag.index].y = w[1];
      requestDraw(); // reroute on drop (mouseup) to avoid thrashing
    } else if (drag.type === "section") {
      const sec = state.sections[drag.index];
      const ddx = w[0] - drag.lx, ddy = w[1] - drag.ly; drag.lx = w[0]; drag.ly = w[1];
      if (sec.poly) sec.poly = sec.poly.map((p) => [p[0] + ddx, p[1] + ddy]);
      else { sec.cx += ddx; sec.cy += ddy; }
      requestRegen();
    } else if (drag.type === "drawround") {
      state._draft.r = Math.hypot(w[0] - state._draft.center[0], w[1] - state._draft.center[1]); requestDraw();
    }
  });

  window.addEventListener("mouseup", () => {
    if (drag && drag.type === "pan") canvas.classList.remove("dragging");
    if (drag && (drag.type === "gate" || drag.type === "roadvertex" || drag.type === "roundcenter" || drag.type === "roundradius")) rebuildNet();
    if (drag && drag.type === "drawround") {
      const d = state._draft;
      if (d && d.r > 3) { state.roundabouts.push({ x: d.center[0], y: d.center[1], r: d.r }); rebuildNet(); }
      state._draft = null; requestDraw();
    }
    drag = null;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (state.mapMode && state.map) {
      const scr = mouseScreen(e);
      // Zoom by an amount PROPORTIONAL to the scroll delta (Leaflet levels are
      // already log-scaled), capped per event so a trackpad's many small events
      // or one big wheel notch don't rocket in/out. Matches the styled-mode feel.
      const dz = g.clamp(-e.deltaY * 0.002, -0.35, 0.35);
      state.map.setZoomAround(window.L.point(scr[0], scr[1]), state.map.getZoom() + dz);
      return; // map 'zoom' resyncs cam
    }
    const scr = mouseScreen(e);
    const before = PS.s2w(state.cam, scr[0], scr[1]);
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.cam.scale = g.clamp(state.cam.scale * factor, 0.05, 40);
    const after = PS.s2w(state.cam, scr[0], scr[1]);
    // Keep the point under the cursor fixed while zooming.
    state.cam.tx += (after[0] - before[0]) * state.cam.scale;
    state.cam.ty += (after[1] - before[1]) * state.cam.scale;
    requestDraw();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selection) {
      deleteSelected();
      e.preventDefault();
    }
    if (e.key === "Enter" && state._draft && state._draft.type === "road") { finishRoad(); e.preventDefault(); }
    if (e.key === "Enter" && state._draft && state._draft.type === "poly") { finishPoly(); e.preventDefault(); }
    if (e.key === "Escape" && state._draft) { state._draft = null; if (state.tool === "bldg") setTool("select"); else requestDraw(); }
  });
  canvas.addEventListener("dblclick", (e) => {
    if (state._draft && state._draft.type === "road") { finishRoad(); return; }
    if (state._draft && state._draft.type === "poly") { finishPoly(); return; }
    // No draft in progress → double-click a polygon edge to add an anchor point.
    insertPolyVertex(mouseWorld(e), mouseScreen(e));
  });

  // ---- building actions ---------------------------------------------------
  let retailCount = state.buildings.length;
  function addBuilding() {
    const c = g.centroid(state.site);
    retailCount++;
    const b = {
      name: "Retail " + retailCount,
      x: c[0] - 28, y: c[1] - 22, w: 56, h: 44, floors: 1, rot: 0,
      fill: PS.BUILDING_FILLS[(retailCount - 1) % PS.BUILDING_FILLS.length],
    };
    state.buildings.push(b);
    state.selection = { type: "building", index: state.buildings.length - 1 };
    syncSelectionUI();
    regen();
    requestDraw();
  }
  function deleteSelected() {
    if (!state.selection) return;
    drag = null; // avoid a stale drag index after the array shrinks
    if (state.selection.type === "building") {
      state.buildings.splice(state.selection.index, 1);
      state.selection = null;
      syncSelectionUI();
      regen();
      requestDraw();
    } else if (state.selection.type === "gate") {
      state.gates.splice(state.selection.index, 1);
      state.selection = null;
      syncSelectionUI();
      rebuildNet();
    } else if (state.selection.type === "section") {
      state.sections.splice(state.selection.index, 1);
      state.selection = null;
      syncSelectionUI();
      regen();
    } else if (state.selection.type === "road") {
      state.roads.splice(state.selection.index, 1);
      state.selection = null;
      syncSelectionUI();
      rebuildNet();
    } else if (state.selection.type === "round") {
      state.roundabouts.splice(state.selection.index, 1);
      state.selection = null;
      syncSelectionUI();
      rebuildNet();
    }
  }

  // Rebuild only the traffic network (gates changed) without regenerating parking.
  function rebuildNet() {
    if (!state.traffic) return;
    if (state.traffic.running) state.traffic.rebuild();
    else state.traffic.net = PS.buildNetwork(state);
    requestDraw();
  }
  function addGate(type) {
    const bb = g.bbox(state.site);
    state.gates.push({ type, x: (bb.minX + bb.maxX) / 2, y: bb.maxY - 2 });
    state.selection = { type: "gate", index: state.gates.length - 1 };
    syncSelectionUI();
    rebuildNet();
  }
  function gateAt(w) {
    for (let i = state.gates.length - 1; i >= 0; i--) {
      const gt = state.gates[i];
      if (Math.hypot(gt.x - w[0], gt.y - w[1]) < 6) return i;
    }
    return -1;
  }
  // ---- manual layout helpers ----
  function pointInSection(w, sec) {
    if (sec.poly && sec.poly.length >= 3) return g.pointInPolygon(w, sec.poly);
    const rot = -(sec.rot || 0) * Math.PI / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    const dx = w[0] - sec.cx, dy = w[1] - sec.cy;
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    return Math.abs(lx) <= sec.w / 2 && Math.abs(ly) <= sec.h / 2;
  }
  function sectionAt(w) {
    for (let i = state.sections.length - 1; i >= 0; i--) if (pointInSection(w, state.sections[i])) return i;
    return -1;
  }
  function finishRoad() {
    if (state._draft && state._draft.type === "road" && state._draft.pts.length >= 2) {
      state.roads.push(state._draft.pts.map((p) => [p[0], p[1]]));
      rebuildNet();
    }
    state._draft = null;
    requestDraw();
  }
  // Projection of point p onto segment a-b (world coords).
  function projOnSeg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2; t = Math.max(0, Math.min(1, t));
    return [a[0] + t * vx, a[1] + t * vy];
  }
  // Double-click a polygon edge to insert a new anchor point there.
  function insertPolyVertex(w, scr) {
    const cands = [];
    const sel = state.selection;
    if (sel && sel.type === "building" && state.buildings[sel.index] && state.buildings[sel.index].poly) cands.push(["building", sel.index]);
    if (sel && sel.type === "section" && state.sections[sel.index] && state.sections[sel.index].poly) cands.push(["section", sel.index]);
    for (let i = state.buildings.length - 1; i >= 0; i--) if (state.buildings[i].poly) cands.push(["building", i]);
    for (let i = state.sections.length - 1; i >= 0; i--) if (state.sections[i].poly) cands.push(["section", i]);
    let best = null;
    for (const [type, idx] of cands) {
      const poly = (type === "building" ? state.buildings[idx] : state.sections[idx]).poly;
      for (let k = 0; k < poly.length; k++) {
        const a = PS.w2s(state.cam, poly[k][0], poly[k][1]);
        const b = PS.w2s(state.cam, poly[(k + 1) % poly.length][0], poly[(k + 1) % poly.length][1]);
        const d = g.distPointToSegment(scr, a, b);
        if (d < 14 && (!best || d < best.d)) best = { d, type, idx, k, poly };
      }
    }
    if (!best) return false;
    const a = best.poly[best.k], b = best.poly[(best.k + 1) % best.poly.length];
    best.poly.splice(best.k + 1, 0, projOnSeg(w, a, b));
    state.selection = { type: best.type, index: best.idx };
    syncSelectionUI(); regen(); requestDraw();
    return true;
  }
  // Finish a clicked-out polygon → a building or a parking section.
  function finishPoly() {
    const d = state._draft;
    const wasBldg = d && d.type === "poly" && d.kind === "bldg";
    if (d && d.type === "poly" && d.pts.length >= 3) {
      const poly = d.pts.map((p) => [p[0], p[1]]);
      if (d.kind === "bldg") {
        retailCount++;
        state.buildings.push({ name: "Retail " + retailCount, poly, floors: 1, fill: PS.BUILDING_FILLS[(retailCount - 1) % PS.BUILDING_FILLS.length] });
        state.selection = { type: "building", index: state.buildings.length - 1 };
      } else {
        state.sections.push({ poly, angle: 90, orientation: "h", island: 11 });
        state.selection = { type: "section", index: state.sections.length - 1 };
      }
      syncSelectionUI(); regen();
    }
    state._draft = null; requestDraw();
    if (wasBldg) setTool("select"); // building draw is one-shot; return to the cursor
  }

  // ---- panel tabs (Konstruera / Simulera / Analys) ----
  function showTab(name) {
    document.querySelectorAll("#panel-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".tab-page").forEach((p) => { p.hidden = p.dataset.page !== name; });
  }
  document.getElementById("panel-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });

  function syncSelectionUI() {
    const sel = state.selection;
    if (sel) showTab("build"); // any plan element lives in Konstruera
    const selB = sel && sel.type === "building";
    const selG = sel && sel.type === "gate";
    const selS = sel && sel.type === "section";
    document.getElementById("btn-del").disabled = !(selB || selG || selS);
    document.getElementById("floors-field").hidden = !selB;
    if (selB) {
      const b = state.buildings[sel.index];
      document.getElementById("floors").value = b.floors || 1;
      document.getElementById("floors-val").textContent = b.floors || 1;
    }
    const secPanel = document.getElementById("sel-section");
    secPanel.hidden = !selS;
    if (selS) {
      const sec = state.sections[sel.index];
      document.getElementById("sec-rot-field").hidden = false; // rect: rotate area; polygon: rotate parking inside it
      document.getElementById("sec-rot").value = sec.rot || 0;
      document.getElementById("sec-rot-val").textContent = Math.round(sec.rot || 0);
      segSetActive("sec-angle-seg", String(sec.angle || 90));
      segSetActive("sec-orient-seg", sec.orientation || "h");
      const isl = sec.island != null ? sec.island : 11;
      document.getElementById("sec-island").value = isl;
      document.getElementById("sec-island-val").textContent = isl;
    }
  }

  // ---- traffic loop -------------------------------------------------------
  const sim = state.traffic;
  let rafId = null, lastTs = 0, simAcc = 0;
  function simFrame(ts) {
    if (!sim.running) return;
    try {
      const real = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      // Accumulate fractional sim-time across frames — otherwise at high frame
      // rates one frame's slice can be < dt and the sim would never step.
      simAcc = Math.min(simAcc + real * sim.tempo, 4);
      let guard = 0;
      while (simAcc >= sim.dt && guard < 200) { sim.step(sim.dt); simAcc -= sim.dt; guard++; }
      if (state.follow && sim.selectedCar) centerOnCar(sim.selectedCar);
      PS.draw(state);
      updateTrafficStats();
    } catch (err) {
      console.error("simFrame error:", err);
    }
    rafId = requestAnimationFrame(simFrame);
  }
  function startTraffic() {
    applyOccupancy();
    sim.rebuild();
    sim.running = true;
    lastTs = 0;
    simAcc = 0;
    document.getElementById("btn-traffic").textContent = "⏸ Pausa trafik";
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(simFrame);
  }
  function pauseTraffic() {
    sim.running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    document.getElementById("btn-traffic").textContent = "▶ Starta trafik";
    requestDraw();
  }
  function toggleTraffic() { sim.running ? pauseTraffic() : startTraffic(); }
  function resetTraffic() {
    pauseTraffic();
    sim.reseed(sim.seed);
    applyOccupancy();
    sim.rebuild();
    updateMetrics();
    updateTrafficStats();
    requestDraw();
  }
  function updateTrafficStats() {
    const s = sim.stats;
    document.getElementById("t-circ").textContent = s.circulating;
    document.getElementById("t-park").textContent = s.parked;
    document.getElementById("t-queue").textContent = s.queuing;
    document.getElementById("t-search").textContent = Math.round(s.avgSearch) + " s";
    document.getElementById("t-coll").textContent = s.collisions || 0;
    document.getElementById("t-away").textContent = s.turnedAway || 0;
    document.getElementById("m-occ").textContent = s.occupancyPct + "%";
    if (sim.selectedCar) refreshSelPanel();
  }

  // ---- selected-car (driver) panel ----------------------------------------
  function selectCar(car) {
    sim.selectedCar = car;
    showTab("sim"); // the "Vald bil" panel lives in Simulera
    document.getElementById("sel-car").hidden = false;
    setSel("sel-aggr", car.traits.aggr);
    setSel("sel-caut", car.traits.caution);
    setSel("sel-stress", car.traits.stress);
    refreshSelPanel();
    requestDraw();
  }
  function setSel(id, frac) {
    const v = Math.round(frac * 100);
    document.getElementById(id).value = v;
    document.getElementById(id + "-val").textContent = v;
  }
  function deselectCar() {
    sim.selectedCar = null;
    if (state.follow) setFollow(false);
    document.getElementById("sel-car").hidden = true;
    requestDraw();
  }
  function refreshSelPanel() {
    const car = sim.selectedCar;
    if (!car) return;
    if (sim.cars.indexOf(car) < 0) { deselectCar(); return; }
    setSel("sel-stress", car.traits.stress);
    const label = car.crashed ? "Krockad 💥" : car.overtaking ? "Kör om 😠"
      : car.state === "toExit" ? "På väg ut" : "Söker plats";
    const dest = (car.destB != null && car.destB >= 0 && state.buildings[car.destB])
      ? state.buildings[car.destB].name : "—";
    document.getElementById("sel-state").textContent =
      label + " · " + Math.round((car.v || 0) * 3.6) + " km/h · mål: " + dest;
  }
  function centerOnCar(car) {
    const rect = canvas.getBoundingClientRect();
    state.cam.tx = rect.width / 2 - car.x * state.cam.scale;
    state.cam.ty = rect.height / 2 - car.y * state.cam.scale;
  }
  function setFollow(on) {
    state.follow = on;
    const btn = document.getElementById("btn-follow");
    btn.textContent = on ? "🎥 Följer" : "🎥 Följ";
    btn.classList.toggle("primary", on);
  }
  function toggleFollow() {
    setFollow(!state.follow);
    if (state.follow && sim.selectedCar) {
      if (state.cam.scale < 12) state.cam.scale = 14; // zoom in for a close view
      centerOnCar(sim.selectedCar);
    }
    requestDraw();
  }

  // ---- UI bindings --------------------------------------------------------
  document.getElementById("btn-add").addEventListener("click", addBuilding);
  document.getElementById("btn-del").addEventListener("click", deleteSelected);
  document.getElementById("btn-add-in").addEventListener("click", () => addGate("in"));
  document.getElementById("btn-add-out").addEventListener("click", () => addGate("out"));
  document.getElementById("btn-traffic").addEventListener("click", toggleTraffic);
  document.getElementById("btn-treset").addEventListener("click", resetTraffic);
  document.getElementById("btn-fit").addEventListener("click", () => resize(true));
  document.getElementById("btn-reset").addEventListener("click", () => {
    pauseTraffic();
    sim.reseed(sim.seed);
    state.site = defaultSite();
    state.buildings = defaultBuildings();
    state.gates = defaultGates(state.site);
    state.roads = []; state.sections = []; state.roundabouts = [];
    state.layoutMode = "manual"; state.tool = "select"; state._draft = null;
    segSetActive("tool-seg", "select");
    document.getElementById("btn-draw-bldg").classList.remove("primary");
    retailCount = state.buildings.length;
    state.decor = buildDecor(state.site);
    state.selection = null;
    state.occupancyFrac = 0.4;
    document.getElementById("occ").value = 40;
    document.getElementById("occ-val").textContent = 40;
    syncSelectionUI();
    resize(true);
    regen();
    updateTrafficStats();
  });

  function segBind(id, cb) {
    const seg = document.getElementById(id);
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      seg.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      cb(btn.dataset.v);
    });
  }
  function segSetActive(id, v) {
    const seg = document.getElementById(id);
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  }
  segBind("base-seg", (v) => setBasemap(v));

  // Active drawing tool. "bldg" (draw a polygon building) works via the Byggnader
  // panel; the rest are the layout drawing tools. Keeps the tool-seg and the
  // "Rita" button highlight in sync.
  function setTool(v) {
    state.tool = v;
    segSetActive("tool-seg", v); // clears highlight when v isn't in the seg (e.g. "bldg")
    document.getElementById("btn-draw-bldg").classList.toggle("primary", v === "bldg");
    state._draft = null;
    if (v !== "select") { state.selection = null; syncSelectionUI(); }
    requestDraw();
  }

  segBind("tool-seg", (v) => setTool(v));
  document.getElementById("btn-draw-bldg").addEventListener("click", () => setTool(state.tool === "bldg" ? "select" : "bldg"));

  function updateSelSection(key, val) {
    if (state.selection && state.selection.type === "section") {
      state.sections[state.selection.index][key] = val;
      if (key === "rot") document.getElementById("sec-rot-val").textContent = Math.round(val);
      if (key === "island") document.getElementById("sec-island-val").textContent = val;
      regen();
    }
  }
  segBind("sec-angle-seg", (v) => updateSelSection("angle", parseInt(v, 10)));
  segBind("sec-orient-seg", (v) => updateSelSection("orientation", v));
  document.getElementById("sec-rot").addEventListener("input", (e) => updateSelSection("rot", parseFloat(e.target.value)));
  document.getElementById("sec-island").addEventListener("input", (e) => updateSelSection("island", parseInt(e.target.value, 10)));
  document.getElementById("btn-clear-layout").addEventListener("click", () => {
    state.roads = []; state.sections = []; state.roundabouts = []; state._draft = null;
    state.selection = null; syncSelectionUI(); regen(); requestDraw();
  });

  function rangeBind(id, valId, cb) {
    const el = document.getElementById(id);
    const val = document.getElementById(valId);
    el.addEventListener("input", () => {
      val.textContent = el.value;
      cb(parseFloat(el.value));
    });
  }
  rangeBind("occ", "occ-val", (v) => {
    state.occupancyFrac = v / 100;
    applyOccupancy();
    if (sim.running) sim.rebuild();
    updateMetrics();
    requestDraw();
  });
  rangeBind("arr", "arr-val", (v) => { sim.arrivalRate = v; });
  rangeBind("dwell", "dwell-val", (v) => { sim.dwellMin = v; });
  rangeBind("speed", "speed-val", (v) => { sim.speedKmh = v; });
  rangeBind("tempo", "tempo-val", (v) => { sim.tempo = v; });
  rangeBind("aggr", "aggr-val", (v) => { sim.meanAggr = v / 100; });
  rangeBind("caut", "caut-val", (v) => { sim.meanCaution = v / 100; });
  rangeBind("spread", "spread-val", (v) => { sim.traitSpread = v / 100; });
  document.getElementById("chk-overtake").addEventListener("change", (e) => { sim.allowOvertake = e.target.checked; });

  // ---- analysis + report card ---------------------------------------------
  // Keep the bottleneck ping animating even when traffic isn't running (the sim
  // loop already redraws every frame when it is).
  let markerRAF = 0;
  function startMarkerAnim() {
    if (markerRAF) return;
    const tick = () => {
      if (!state._analysisWorst) { markerRAF = 0; return; }
      if (!sim.running) PS.draw(state);
      markerRAF = requestAnimationFrame(tick);
    };
    markerRAF = requestAnimationFrame(tick);
  }
  function renderReport(r) {
    const box = document.getElementById("report");
    box.hidden = false;
    if (!r || !r.ok) { state._report = null; state._analysisWorst = null; box.innerHTML = `<p class="rc-msg">${r ? r.message : "Analysen misslyckades."}</p>`; return; }
    state._report = { grade: r.grade, score: r.score, dims: r.dims, suggestions: r.suggestions, metrics: r.metrics };
    // Pin the worst bottleneck on the canvas (animated until the layout changes).
    state._analysisWorst = r.worstPt ? { pt: r.worstPt, cong: r.worstCong } : null;
    if (state._analysisWorst) startMarkerAnim();
    const dimHtml = r.dims.map((d) =>
      `<div class="rc-dim">
        <div class="rc-dim-top"><span>${d.label}</span><span class="rc-dg">${d.grade} · ${d.score}</span></div>
        <div class="rc-bar"><i style="width:${d.score}%"></i></div>
        <div class="rc-detail">${d.detail}</div>
      </div>`).join("");
    const tips = r.suggestions.map((t) => `<li>${t}</li>`).join("");
    box.innerHTML =
      `<div class="rc-head">
        <div class="rc-grade g-${r.grade}">${r.grade}</div>
        <div><div class="rc-title">Betyg ${r.grade} · ${r.score}/100</div>
        <div class="rc-sub">${r.metrics.arrivalRate} bilar/min · ${r.metrics.stalls.toLocaleString()} platser · 120 s test</div></div>
      </div>
      <div class="rc-dims">${dimHtml}</div>
      <ul class="rc-tips">${tips}</ul>`;
  }
  document.getElementById("btn-analyze").addEventListener("click", () => {
    const btn = document.getElementById("btn-analyze");
    btn.disabled = true; btn.textContent = "Analyserar…";
    // Let the button repaint before the (synchronous) benchmark blocks the thread.
    setTimeout(() => {
      try { renderReport(PS.analyze(state)); }
      catch (err) { console.error("[analyze]", err); renderReport({ ok: false, message: "Fel under analys: " + err.message }); }
      finally { btn.disabled = false; btn.textContent = "Analysera layouten"; requestDraw(); }
    }, 30);
  });

  // ---- optional LLM analysis (Claude via OpenRouter) ----------------------
  const OR_KEY_LS = "ps_openrouter_key";
  const aiKeyEl = document.getElementById("ai-key");
  const aiBtn = document.getElementById("btn-ai");
  const aiOut = document.getElementById("ai-out");
  function refreshAiBtn() { aiBtn.disabled = !((aiKeyEl.value || "").trim()); }
  aiKeyEl.value = localStorage.getItem(OR_KEY_LS) || "";
  refreshAiBtn();
  aiKeyEl.addEventListener("input", () => { localStorage.setItem(OR_KEY_LS, aiKeyEl.value.trim()); refreshAiBtn(); });

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  // Minimal, XSS-safe markdown: escape FIRST, then apply a few inline/block rules.
  function mdLite(src) {
    const lines = escapeHtml(src).split(/\r?\n/);
    let html = "", inList = false;
    const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*(?!\*)(.+?)\*/g, "$1<i>$2</i>");
    for (let ln of lines) {
      let t = ln.trim();
      if (/^#{1,6}\s/.test(t)) { if (inList) { html += "</ul>"; inList = false; } html += `<div class="ai-h">${inline(t.replace(/^#{1,6}\s/, ""))}</div>`; continue; }
      if (/^([-*]|\d+\.)\s+/.test(t)) { if (!inList) { html += '<ul class="ai-ul">'; inList = true; } html += `<li>${inline(t.replace(/^([-*]|\d+\.)\s+/, ""))}</li>`; continue; }
      if (!t) { if (inList) { html += "</ul>"; inList = false; } continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p class="ai-p">${inline(t)}</p>`;
    }
    if (inList) html += "</ul>";
    return html;
  }
  function aiPayload(r) {
    const gs = state.gates || [];
    const inG = gs.filter((x) => x.type === "in").length, outG = gs.filter((x) => x.type === "out").length;
    const m = r.metrics;
    return [
      "Layout: " + (state.layoutMode === "manual" ? "manuell (egna vägar/sektioner)" : "automatisk"),
      `Platser: ${m.stalls}, byggnader: ${(state.buildings || []).length}, infarter: ${inG}, utfarter: ${outG}` + ((state.roundabouts || []).length ? `, rondeller: ${state.roundabouts.length}` : ""),
      `Parkeringsvinkel: ${state.params.angle}°, orientering: ${state.params.orientation === "v" ? "nord–syd" : "öst–väst"}`,
      `Trafik: ${m.arrivalRate} bilar/min, uppehåll ${m.dwellMin} min, hastighet ${m.speedKmh} km/h`,
      "",
      `Betyg: ${r.grade} (${r.score}/100)`,
      "Delbetyg: " + r.dims.map((d) => `${d.label} ${d.grade}/${d.score} (${d.detail})`).join("; "),
      `Mätvärden: ${Math.round(m.rejectRate * 100)}% avvisade, ${Math.round(m.avgCong * 100)}% trängsel, ${Math.round(m.queueFrac * 100)}% i kö, ${Math.round(m.avgSearch)} s söktid, ${m.collisions} krockar, ${m.gaveUp} gav upp, ${m.unreachable} onåbara platser`,
      "Regelbaserade förslag: " + r.suggestions.join(" | "),
    ].join("\n");
  }
  const AI_SYS =
    "Du är en erfaren trafik- och parkeringsplanerare. Du får mätvärden från en mikrosimulering av en parkering (siffrorna är uppmätta, inte gissade). " +
    "Ge en kort, skarp bedömning och en prioriterad lista med konkreta, genomförbara åtgärder för bättre flöde och kapacitet. Bygg vidare på — upprepa inte — de regelbaserade förslagen. " +
    "Svara på svenska med korrekt å, ä och ö. Använd markdown: en kort rubrik, 1–2 meningars sammanfattning, sedan en punktlista med högst 5 åtgärder rangordnade efter effekt. Var konkret (t.ex. 'lägg en andra infart i norr', inte 'förbättra flödet').";

  async function askClaude() {
    const key = (aiKeyEl.value || "").trim();
    if (!key) return;
    // Make sure we have fresh metrics to send.
    let r = state._report;
    if (!r) { renderReport(PS.analyze(state)); r = state._report; }
    if (!r) { aiOut.hidden = false; aiOut.innerHTML = '<p class="rc-msg">Kunde inte ta fram mätvärden att analysera.</p>'; return; }
    aiBtn.disabled = true; const label = aiBtn.textContent; aiBtn.textContent = "Claude tänker…";
    aiOut.hidden = false; aiOut.innerHTML = '<p class="rc-msg">Frågar Claude (claude-sonnet-5)…</p>';
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "HTTP-Referer": location.origin, "X-Title": "Parkeringssimulator" },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-5",
          messages: [{ role: "system", content: AI_SYS }, { role: "user", content: aiPayload(r) }],
          max_tokens: 900, temperature: 0.4,
        }),
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error("HTTP " + resp.status + " — " + t.slice(0, 300)); }
      const data = await resp.json();
      const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      aiOut.innerHTML = '<span class="ai-badge">Claude · sonnet-5</span>' + (txt ? mdLite(txt) : '<p class="rc-msg">Tomt svar.</p>');
    } catch (err) {
      console.error("[askClaude]", err);
      aiOut.innerHTML = `<p class="rc-msg">Kunde inte nå Claude: ${escapeHtml(err.message)}</p>`;
    } finally {
      aiBtn.disabled = false; aiBtn.textContent = label;
    }
  }
  aiBtn.addEventListener("click", askClaude);

  // ---- export / import -----------------------------------------------------
  function download(name, url, revoke) {
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    if (revoke) URL.revokeObjectURL(url);
  }
  document.getElementById("btn-export-png").addEventListener("click", () => {
    PS.draw(state); // ensure a fresh frame is on the canvas
    download(`parkering-${state.siteName || "plan"}.png`, canvas.toDataURL("image/png"), false);
  });
  document.getElementById("btn-export-json").addEventListener("click", () => {
    const plan = {
      app: "parkeringssimulator", version: 1,
      siteName: state.siteName,
      site: state.site, buildings: state.buildings, gates: state.gates,
      layoutMode: state.layoutMode, params: state.params, occupancyFrac: state.occupancyFrac,
      roads: state.roads, sections: state.sections, roundabouts: state.roundabouts,
      traffic: {
        arrivalRate: sim.arrivalRate, dwellMin: sim.dwellMin, speedKmh: sim.speedKmh, tempo: sim.tempo,
        meanAggr: sim.meanAggr, meanCaution: sim.meanCaution, traitSpread: sim.traitSpread, allowOvertake: sim.allowOvertake,
      },
      report: state._report || null,
    };
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    download("parkering-plan.json", URL.createObjectURL(blob), true);
  });
  const importFile = document.getElementById("import-file");
  document.getElementById("btn-import-json").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { applyPlan(JSON.parse(reader.result)); }
      catch (err) { console.error("[import]", err); const box = document.getElementById("report"); box.hidden = false; box.innerHTML = `<p class="rc-msg">Kunde inte läsa filen: ${err.message}</p>`; }
      importFile.value = "";
    };
    reader.readAsText(f);
  });
  function setSlider(id, valId, v) { const el = document.getElementById(id); if (el != null && v != null) { el.value = v; document.getElementById(valId).textContent = v; } }
  function applyPlan(p) {
    if (!p || p.app !== "parkeringssimulator") throw new Error("okänt filformat");
    pauseTraffic();
    if (p.site) state.site = p.site;
    if (p.siteName) state.siteName = p.siteName;
    state.buildings = p.buildings || [];
    state.gates = p.gates || [];
    state.roads = p.roads || [];
    state.sections = p.sections || [];
    state.roundabouts = p.roundabouts || [];
    state.layoutMode = "manual";
    if (p.params) Object.assign(state.params, p.params);
    if (typeof p.occupancyFrac === "number") state.occupancyFrac = p.occupancyFrac;
    const t = p.traffic || {};
    if (t.arrivalRate != null) sim.arrivalRate = t.arrivalRate;
    if (t.dwellMin != null) sim.dwellMin = t.dwellMin;
    if (t.speedKmh != null) sim.speedKmh = t.speedKmh;
    if (t.tempo != null) sim.tempo = t.tempo;
    if (t.meanAggr != null) sim.meanAggr = t.meanAggr;
    if (t.meanCaution != null) sim.meanCaution = t.meanCaution;
    if (t.traitSpread != null) sim.traitSpread = t.traitSpread;
    if (t.allowOvertake != null) sim.allowOvertake = t.allowOvertake;
    // Sync all the panel controls to the imported values.
    segSetActive("tool-seg", "select"); state.tool = "select";
    document.getElementById("btn-draw-bldg").classList.remove("primary");
    setSlider("occ", "occ-val", Math.round(state.occupancyFrac * 100));
    setSlider("arr", "arr-val", sim.arrivalRate);
    setSlider("dwell", "dwell-val", sim.dwellMin);
    setSlider("speed", "speed-val", sim.speedKmh);
    setSlider("tempo", "tempo-val", sim.tempo);
    setSlider("aggr", "aggr-val", Math.round(sim.meanAggr * 100));
    setSlider("caut", "caut-val", Math.round(sim.meanCaution * 100));
    setSlider("spread", "spread-val", Math.round(sim.traitSpread * 100));
    document.getElementById("chk-overtake").checked = !!sim.allowOvertake;
    state.decor = buildDecor(state.site);
    state.selection = null; state._draft = null; state._report = null;
    retailCount = state.buildings.length;
    document.getElementById("report").hidden = true;
    syncSelectionUI();
    regen();
    resize(true);
    updateTrafficStats();
    requestDraw();
  }

  // Selected-car trait editing.
  function bindSelTrait(id, key) {
    document.getElementById(id).addEventListener("input", (e) => {
      if (sim.selectedCar) {
        sim.selectedCar.traits[key] = e.target.value / 100;
        document.getElementById(id + "-val").textContent = e.target.value;
        requestDraw();
      }
    });
  }
  bindSelTrait("sel-aggr", "aggr");
  bindSelTrait("sel-caut", "caution");
  bindSelTrait("sel-stress", "stress");
  document.getElementById("btn-follow").addEventListener("click", toggleFollow);
  document.getElementById("btn-crash").addEventListener("click", () => {
    if (sim.selectedCar) {
      sim.crash(sim.selectedCar);
      sim.stats.collisions = sim.collisions;
      refreshSelPanel();
      document.getElementById("t-coll").textContent = sim.collisions;
      requestDraw();
    }
  });
  document.getElementById("btn-deselect").addEventListener("click", deselectCar);
  rangeBind("floors", "floors-val", (v) => {
    if (state.selection && state.selection.type === "building") {
      state.buildings[state.selection.index].floors = v;
      updateMetrics();
      requestDraw();
    }
  });

  document.getElementById("chk-heat").addEventListener("change", (e) => {
    state.showHeat = e.target.checked;
    requestDraw();
  });
  document.getElementById("chk-peds").addEventListener("change", (e) => {
    state.showPeds = e.target.checked;
    requestDraw();
  });
  document.getElementById("chk-conflicts").addEventListener("change", (e) => {
    state.showConflicts = e.target.checked;
    requestDraw();
  });
  document.getElementById("chk-dims").addEventListener("change", (e) => {
    state.showDims = e.target.checked;
    requestDraw();
  });

  // ---- boot ---------------------------------------------------------------
  window.PSSTATE = state; // debug/testing handle
  syncSelectionUI();
  resize(true);
  regen();
  requestDraw();
})();
