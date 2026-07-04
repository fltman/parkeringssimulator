/* render.js — draws the whole scene onto a 2D canvas.
 * Top-down "map" aesthetic: beige paper, neighbour blocks, named streets,
 * asphalt site, painted stalls, drive-aisle dashes, landscape trees, parked
 * cars, buildings with GFA labels, selection handles and dimension lines. */
(function () {
  const PS = (window.PS = window.PS || {});
  const g = PS.geom;

  const COLORS = {
    paper: "#e9e6df",
    neighbour: "#dbd6cc",
    neighbourEdge: "#cdc7bb",
    street: "#f5f3ef",
    streetEdge: "#d8d3c8",
    streetDash: "#c9c3b6",
    asphalt: "#949aa6",
    asphaltEdge: "#5f6470",
    stripe: "rgba(255,255,255,0.8)",
    aisleDash: "rgba(255,255,255,0.28)",
    tree: "#5aa152",
    treeDark: "#3f7a3a",
    treeShadow: "rgba(40,70,35,0.18)",
    siteLine: "#3b5bdb",
    label: "#3a3a3a",
    dim: "#7a7f8a",
  };
  const BUILDING_FILLS = ["#8ec89a", "#e3d98f", "#c9a9d6", "#9dc0e0", "#e0b48f"];
  const CAR_COLORS = [
    "#3f6fb5", "#5b8dd6", "#c9ced6", "#e8e9ec", "#8a94a6",
    "#b23f3f", "#4b4f57", "#d7dde6", "#6f7788", "#356b8f",
  ];

  // ---- Camera -------------------------------------------------------------
  PS.Camera = function () {
    return { scale: 1, tx: 0, ty: 0 };
  };
  PS.w2s = (cam, x, y) => [x * cam.scale + cam.tx, y * cam.scale + cam.ty];
  PS.s2w = (cam, x, y) => [(x - cam.tx) / cam.scale, (y - cam.ty) / cam.scale];

  PS.fitCamera = function (cam, site, W, H, margin) {
    const bb = g.bbox(site);
    // Leave room around the site for the decorative streets (metres).
    const pad = 30;
    const w = bb.w + pad * 2;
    const h = bb.h + pad * 2;
    const s = Math.min((W - margin * 2) / w, (H - margin * 2) / h);
    // Never allow a zero/negative scale (tiny/unlaid-out canvas) — it would make
    // s2w return NaN and ctx.arc throw on negative radii.
    cam.scale = Math.max(0.02, s || 0.02);
    const cx = bb.minX + bb.w / 2;
    const cy = bb.minY + bb.h / 2;
    cam.tx = W / 2 - cx * s;
    cam.ty = H / 2 - cy * s;
  };

  // ---- helpers ------------------------------------------------------------
  function polyPath(ctx, cam, pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [sx, sy] = PS.w2s(cam, pts[i][0], pts[i][1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }

  function line(ctx, cam, ax, ay, bx, by) {
    const a = PS.w2s(cam, ax, ay);
    const b = PS.w2s(cam, bx, by);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  // ---- scene layers -------------------------------------------------------
  function drawDecor(ctx, cam, decor) {
    // Neighbour house/parcel blocks around the site.
    ctx.fillStyle = COLORS.neighbour;
    ctx.strokeStyle = COLORS.neighbourEdge;
    ctx.lineWidth = 1;
    for (const b of decor.blocks) {
      const [sx, sy] = PS.w2s(cam, b.x, b.y);
      ctx.fillRect(sx, sy, b.w * cam.scale, b.h * cam.scale);
      ctx.strokeRect(sx, sy, b.w * cam.scale, b.h * cam.scale);
    }
  }

  function drawStreets(ctx, cam, decor) {
    for (const st of decor.streets) {
      polyPath(ctx, cam, st.poly);
      ctx.fillStyle = COLORS.street;
      ctx.fill();
      ctx.strokeStyle = COLORS.streetEdge;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Dashed centre line.
      ctx.save();
      ctx.strokeStyle = COLORS.streetDash;
      ctx.lineWidth = Math.max(1, 1.5 * cam.scale);
      ctx.setLineDash([10 * cam.scale, 10 * cam.scale]);
      line(ctx, cam, st.cx1, st.cy1, st.cx2, st.cy2);
      ctx.restore();
    }
    // Street name labels.
    ctx.fillStyle = COLORS.label;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const st of decor.streets) {
      const mid = PS.w2s(cam, (st.cx1 + st.cx2) / 2, (st.cy1 + st.cy2) / 2);
      ctx.save();
      ctx.translate(mid[0], mid[1]);
      if (st.vertical) ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      const tw = ctx.measureText(st.name).width;
      ctx.fillRect(-tw / 2 - 4, -8, tw + 8, 16);
      ctx.fillStyle = COLORS.label;
      ctx.fillText(st.name, 0, 0);
      ctx.restore();
    }
  }

  function drawSiteAsphalt(ctx, cam, site, alpha) {
    polyPath(ctx, cam, site);
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.asphalt;
    ctx.fill();
    ctx.restore();
  }

  function drawAisles(ctx, cam, aisles) {
    ctx.strokeStyle = COLORS.aisleDash;
    ctx.lineWidth = Math.max(1, 1.5 * cam.scale);
    ctx.setLineDash([6 * cam.scale, 10 * cam.scale]);
    for (const ai of aisles) {
      const p = ai.poly;
      // Dashed centre line down the length of the aisle.
      const mid1 = [(p[0][0] + p[3][0]) / 2, (p[0][1] + p[3][1]) / 2];
      const mid2 = [(p[1][0] + p[2][0]) / 2, (p[1][1] + p[2][1]) / 2];
      line(ctx, cam, mid1[0], mid1[1], mid2[0], mid2[1]);
    }
    ctx.setLineDash([]);
  }

  function drawStalls(ctx, cam, stalls) {
    ctx.save();
    ctx.strokeStyle = COLORS.stripe;
    ctx.lineWidth = Math.max(0.6, 1.1 * cam.scale);
    ctx.lineCap = "round";
    // One path + one stroke for ALL stalls (identical style) — per-stall
    // stroke() was 2500+ GPU flushes per frame on a big site. The w2s math is
    // inlined to avoid four array allocations per stall.
    const sc = cam.scale, tx = cam.tx, ty = cam.ty;
    ctx.beginPath();
    for (const s of stalls) {
      const c = s.corners; // 0 aisle-left, 1 aisle-right, 2 back-right, 3 back-left
      ctx.moveTo(c[0][0] * sc + tx, c[0][1] * sc + ty); // left side (aisle -> back)
      ctx.lineTo(c[3][0] * sc + tx, c[3][1] * sc + ty);
      ctx.lineTo(c[2][0] * sc + tx, c[2][1] * sc + ty); // back
      ctx.lineTo(c[1][0] * sc + tx, c[1][1] * sc + ty); // right side (back -> aisle)
    }
    ctx.stroke();
    ctx.restore();
  }

  function insetPoly(corners, f) {
    const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
    const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
    return corners.map((p) => [p[0] + (cx - p[0]) * f, p[1] + (cy - p[1]) * f]);
  }

  // Typed stalls (hc / ev / staff): tinted floor + a symbol when zoomed in.
  // Only the few percent of stalls that carry a type are touched — cheap.
  const TYPE_FILL = { hc: "rgba(37,99,235,0.30)", ev: "rgba(46,160,67,0.28)", staff: "rgba(110,115,125,0.30)" };
  const TYPE_INK = { hc: "#1d4ed8", ev: "#2b8a3e", staff: "#4b5563" };
  const TYPE_SYM = { hc: "♿", ev: "⚡", staff: "P" };
  function drawStallTypes(ctx, cam, stalls) {
    const zoomed = cam.scale > 2.2;
    ctx.save();
    for (const s of stalls) {
      if (!s.type) continue;
      polyPath(ctx, cam, insetPoly(s.corners, 0.1));
      ctx.fillStyle = TYPE_FILL[s.type] || "rgba(0,0,0,0.1)";
      ctx.fill();
      if (zoomed && !s.occupied) {
        const c = PS.w2s(cam, s.cx, s.cy);
        ctx.font = "700 " + Math.max(8, 1.7 * cam.scale) + "px system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = TYPE_INK[s.type] || "#333";
        ctx.fillText(TYPE_SYM[s.type] || "?", c[0], c[1]);
      }
    }
    ctx.restore();
  }

  // Marked pedestrian crossings: zebra stripes across the road. (dx,dy) is the
  // road direction at the crossing; stripes run ALONG the road, repeated across.
  PS.drawCrossings = function (ctx, cam, state) {
    const crs = state.crossings || [];
    if (!crs.length) return;
    const sel = state.selection;
    ctx.save();
    for (let i = 0; i < crs.length; i++) {
      const cr = crs[i];
      const dx = cr.dx != null ? cr.dx : 1, dy = cr.dy != null ? cr.dy : 0;
      const px = -dy, py = dx; // across the road
      const bandT = 3.0;       // walking-corridor thickness along the road (m)
      const halfW = 4.6;       // half covered road width (m)
      const sw = 0.6, gap = 0.55;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      for (let o = -halfW + sw / 2; o <= halfW - sw / 2; o += sw + gap) {
        const cx2 = cr.x + px * o, cy2 = cr.y + py * o;
        const ax = dx * (bandT / 2), ay = dy * (bandT / 2);
        const bx = px * (sw / 2), by = py * (sw / 2);
        const p1 = PS.w2s(cam, cx2 - ax - bx, cy2 - ay - by);
        const p2 = PS.w2s(cam, cx2 + ax - bx, cy2 + ay - by);
        const p3 = PS.w2s(cam, cx2 + ax + bx, cy2 + ay + by);
        const p4 = PS.w2s(cam, cx2 - ax + bx, cy2 - ay + by);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.closePath(); ctx.fill();
      }
      if (sel && sel.type === "cross" && sel.index === i) {
        const s = PS.w2s(cam, cr.x, cr.y);
        ctx.strokeStyle = "#3b5bdb"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(12, (halfW + 1.2) * cam.scale), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  };

  function drawCars(ctx, cam, stalls) {
    for (const s of stalls) {
      if (!s.occupied) continue;
      const body = insetPoly(s.corners, 0.22);
      polyPath(ctx, cam, body);
      ctx.fillStyle = s.color || "#4b6fa8";
      ctx.fill();
      // Windshield hint: a lighter band across the aisle end.
      const roof = [
        body[0],
        body[1],
        [body[1][0] + (body[2][0] - body[1][0]) * 0.45, body[1][1] + (body[2][1] - body[1][1]) * 0.45],
        [body[0][0] + (body[3][0] - body[0][0]) * 0.45, body[0][1] + (body[3][1] - body[0][1]) * 0.45],
      ];
      polyPath(ctx, cam, roof);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fill();
    }
  }

  function drawTrees(ctx, cam, trees) {
    for (const t of trees) {
      const [sx, sy] = PS.w2s(cam, t.x, t.y);
      const r = t.r * cam.scale;
      ctx.beginPath();
      ctx.arc(sx + r * 0.25, sy + r * 0.3, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.treeShadow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.tree;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx - r * 0.25, sy - r * 0.25, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fill();
      ctx.strokeStyle = COLORS.treeDark;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Visitor pill above a building (drawn upright in screen space): current
  // visitors now, total visits so far, and staff on site — "👤 3 · 42  👷 8".
  // Staff are counted separately: they arrive BEFORE opening by design, and
  // lumping them in as "visitors at a closed building" reads as a bug.
  function drawVisitorBadge(ctx, sx, sy, now, total, staff) {
    const txt = "👤 " + now + (total != null ? "  ·  " + total : "") + (staff > 0 ? "  👷 " + staff : "");
    ctx.font = "700 11px system-ui, sans-serif";
    const w = ctx.measureText(txt).width + 14, h = 17;
    ctx.fillStyle = "rgba(59,91,219,0.94)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(sx - w / 2, sy - h / 2, w, h, 8.5); ctx.fill(); }
    else ctx.fillRect(sx - w / 2, sy - h / 2, w, h);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(txt, sx, sy);
  }
  function drawBuildings(ctx, cam, buildings, selection, visitors, totals, hour, staffCnt) {
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      const sel = selection && selection.type === "building" && selection.index === i;
      const nv = visitors ? visitors[i] : 0;
      const tv = totals ? (totals[i] || 0) : 0;
      const st = staffCnt ? staffCnt[i] : 0;
      // Closed right now (per opening hours)? Dim it and tag the label.
      const closed = hour != null && PS.buildingOpen && !PS.buildingOpen(b, hour);
      if (b.poly && b.poly.length >= 3) {
        polyPath(ctx, cam, b.poly);
        ctx.save(); if (closed) ctx.globalAlpha = 0.45;
        ctx.fillStyle = b.fill || BUILDING_FILLS[i % BUILDING_FILLS.length];
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = sel ? COLORS.siteLine : "rgba(60,70,60,0.55)";
        ctx.lineWidth = sel ? 2.5 : 1.5; ctx.stroke();
        const c = g.centroid(b.poly), cs = PS.w2s(cam, c[0], c[1]);
        const gfa = Math.round(g.area(b.poly) * (b.floors || 1));
        ctx.fillStyle = "rgba(40,50,40,0.85)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "600 12px system-ui, sans-serif"; ctx.fillText(b.name || "Byggnad", cs[0], cs[1] - 8);
        ctx.font = "11px system-ui, sans-serif"; ctx.fillText(closed ? "Stängt" : "BTA " + gfa.toLocaleString() + " m²", cs[0], cs[1] + 8);
        if (nv > 0 || tv > 0 || st > 0) drawVisitorBadge(ctx, cs[0], cs[1] - 24, nv, tv, st);
        continue;
      }
      const s = PS.w2s(cam, b.x + b.w / 2, b.y + b.h / 2);
      const w = b.w * cam.scale, h = b.h * cam.scale;
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.rotate((b.rot || 0) * Math.PI / 180);
      if (closed) ctx.globalAlpha = 0.45;
      ctx.fillStyle = b.fill || BUILDING_FILLS[i % BUILDING_FILLS.length];
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = sel ? COLORS.siteLine : "rgba(60,70,60,0.55)";
      ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      const gfa = Math.round(b.w * b.h * (b.floors || 1));
      ctx.fillStyle = "rgba(40,50,40,0.85)";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillText(b.name || "Byggnad", 0, -8);
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(closed ? "Stängt" : "BTA " + gfa.toLocaleString() + " m²", 0, 8);
      ctx.restore();
      if (nv > 0 || tv > 0 || st > 0) drawVisitorBadge(ctx, s[0], s[1] - 24, nv, tv, st); // upright, in screen space
    }
  }

  // Edit handles for the current selection (resize corners + rotation for a
  // building/section; vertices for a road; centre/radius for a roundabout).
  function hsq(ctx, s) { ctx.fillStyle = "#fff"; ctx.strokeStyle = COLORS.siteLine; ctx.lineWidth = 1.5; ctx.fillRect(s[0] - 5, s[1] - 5, 10, 10); ctx.strokeRect(s[0] - 5, s[1] - 5, 10, 10); }
  function hci(ctx, s) { ctx.fillStyle = "#fff"; ctx.strokeStyle = COLORS.siteLine; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(s[0], s[1], 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  PS.drawHandles = function (ctx, cam, state) {
    const sel = state.selection;
    if (!sel) return;
    if (sel.type === "building" || sel.type === "section") {
      const item = sel.type === "building" ? state.buildings[sel.index] : state.sections[sel.index];
      if (item && item.poly && item.poly.length >= 3) { // polygon → anchor handles
        for (const p of item.poly) hsq(ctx, PS.w2s(cam, p[0], p[1]));
        return;
      }
      if (!item) return; // stale selection index (item just removed) — no handles
      let cx, cy, w, h, rot;
      if (sel.type === "building") { const b = state.buildings[sel.index]; cx = b.x + b.w / 2; cy = b.y + b.h / 2; w = b.w; h = b.h; rot = b.rot || 0; }
      else { const s = state.sections[sel.index]; cx = s.cx; cy = s.cy; w = s.w; h = s.h; rot = s.rot || 0; }
      const corners = g.rectPoints(cx, cy, w, h, rot, false);
      const a = rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
      const topMid = [cx - (-h / 2) * sn, cy + (-h / 2) * cs];
      const rotH = [cx - (-h / 2 - 6) * sn, cy + (-h / 2 - 6) * cs];
      const tS = PS.w2s(cam, topMid[0], topMid[1]), rS = PS.w2s(cam, rotH[0], rotH[1]);
      ctx.strokeStyle = COLORS.siteLine; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(tS[0], tS[1]); ctx.lineTo(rS[0], rS[1]); ctx.stroke();
      hci(ctx, rS);
      for (const c of corners) hsq(ctx, PS.w2s(cam, c[0], c[1]));
    } else if (sel.type === "road") {
      for (const p of state.roads[sel.index] || []) hsq(ctx, PS.w2s(cam, p[0], p[1]));
    } else if (sel.type === "round") {
      const rb = state.roundabouts[sel.index];
      if (rb) { hsq(ctx, PS.w2s(cam, rb.x, rb.y)); hci(ctx, PS.w2s(cam, rb.x + rb.r, rb.y)); }
    }
  };

  function drawSiteOutline(ctx, cam, site, editSite) {
    polyPath(ctx, cam, site);
    ctx.strokeStyle = COLORS.siteLine;
    ctx.lineWidth = editSite ? 2.5 : 2;
    ctx.stroke();
    if (editSite) {
      for (const v of site) {
        const [sx, sy] = PS.w2s(cam, v[0], v[1]);
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = COLORS.siteLine;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function drawDims(ctx, cam, site) {
    const bb = g.bbox(site);
    ctx.strokeStyle = COLORS.dim;
    ctx.fillStyle = COLORS.dim;
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const off = 26;
    // Width dimension along the bottom.
    const y = bb.maxY;
    line(ctx, cam, bb.minX, y + off, bb.maxX, y + off);
    line(ctx, cam, bb.minX, y + off - 5 / cam.scale, bb.minX, y + off + 5 / cam.scale);
    line(ctx, cam, bb.maxX, y + off - 5 / cam.scale, bb.maxX, y + off + 5 / cam.scale);
    const midW = PS.w2s(cam, (bb.minX + bb.maxX) / 2, y + off);
    ctx.save();
    ctx.fillStyle = "rgba(233,230,223,0.9)";
    const wt = Math.round(bb.w) + " m";
    const tw = ctx.measureText(wt).width;
    ctx.fillRect(midW[0] - tw / 2 - 3, midW[1] - 8, tw + 6, 16);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(wt, midW[0], midW[1]);
    ctx.restore();
    // Height dimension along the right.
    const x = bb.maxX;
    line(ctx, cam, x + off, bb.minY, x + off, bb.maxY);
    const midH = PS.w2s(cam, x + off, (bb.minY + bb.maxY) / 2);
    ctx.save();
    ctx.translate(midH[0], midH[1]);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(233,230,223,0.9)";
    const ht = Math.round(bb.h) + " m";
    const th = ctx.measureText(ht).width;
    ctx.fillRect(-th / 2 - 3, -8, th + 6, 16);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(ht, 0, 0);
    ctx.restore();
  }

  // ---- manual layout (roads + rotatable parking sections) -----------------
  PS.sectionCorners = function (sec) {
    const rot = (sec.rot || 0) * Math.PI / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    const hw = sec.w / 2, hh = sec.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map((p) => [sec.cx + p[0] * cos - p[1] * sin, sec.cy + p[0] * sin + p[1] * cos]);
  };
  function drawManualBase(ctx, cam, state, alpha) {
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.asphalt;
    for (const sec of state.sections || []) { polyPath(ctx, cam, sec.poly || PS.sectionCorners(sec)); ctx.fill(); }
    ctx.strokeStyle = COLORS.asphalt; ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Width follows the lane config: 4.875 m per lane ("1+1" = 9.75, as before).
    const laneCount = (s) => (s === "1" ? 1 : s === "2" ? 2 : s === "2+1" ? 3 : s === "2+2" ? 4 : 2);
    for (const r of state.roads || []) {
      if (r.length < 2) continue;
      ctx.lineWidth = Math.max(4, 4.875 * laneCount(r.lanes || "1+1") * cam.scale);
      ctx.beginPath();
      for (let i = 0; i < r.length; i++) { const s = PS.w2s(cam, r[i][0], r[i][1]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
      ctx.stroke();
    }
    for (const rb of state.roundabouts || []) {
      const s = PS.w2s(cam, rb.x, rb.y);
      const two = (rb.lanes || 1) >= 2;
      // Two-lane ring: wider carriageway centred between the two lane rings.
      const rad = (two ? rb.r - 1.6 : rb.r) * cam.scale;
      ctx.lineWidth = Math.max(4, (two ? 13 : 9.75) * cam.scale);
      ctx.beginPath(); ctx.arc(s[0], s[1], rad, 0, Math.PI * 2); ctx.stroke();
    }
    // One-way arrows: chevrons along the draw direction so enkelriktat is visible.
    for (const r of state.roads || []) {
      const cfg = r.lanes || "1+1";
      if (cfg !== "1" && cfg !== "2") continue;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = Math.max(1.2, 0.5 * cam.scale); ctx.lineCap = "round";
      const step = 22; // metres between chevrons
      let acc = step / 2;
      for (let i = 0; i < r.length - 1; i++) {
        const ax = r[i][0], ay = r[i][1], bx = r[i + 1][0], by = r[i + 1][1];
        const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
        for (let d = acc; d < L; d += step) {
          const px = ax + ux * d, py = ay + uy * d;
          const tip = PS.w2s(cam, px + ux * 1.4, py + uy * 1.4);
          const l1 = PS.w2s(cam, px - ux * 0.6 - uy * 1.0, py - uy * 0.6 + ux * 1.0);
          const l2 = PS.w2s(cam, px - ux * 0.6 + uy * 1.0, py - uy * 0.6 - ux * 1.0);
          ctx.beginPath(); ctx.moveTo(l1[0], l1[1]); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(l2[0], l2[1]); ctx.stroke();
        }
        acc = ((acc - L) % step + step) % step;
      }
      ctx.restore();
    }
    ctx.restore();
  }
  // The first anchor of an in-progress road/polygon: a clear target that fills in
  // with a pulse ring when the cursor is close enough to CLOSE it (see CLOSE_PX).
  function drawFirstAnchor(ctx, cam, d, col, minPts) {
    if (!d.pts || !d.pts.length) return;
    const s0 = PS.w2s(cam, d.pts[0][0], d.pts[0][1]);
    const cur = d.cursor ? PS.w2s(cam, d.cursor[0], d.cursor[1]) : null;
    const closeable = cur && d.pts.length >= minPts && Math.hypot(s0[0] - cur[0], s0[1] - cur[1]) <= 14;
    if (closeable) {
      ctx.beginPath(); ctx.arc(s0[0], s0[1], 12, 0, Math.PI * 2);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.arc(s0[0], s0[1], closeable ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = closeable ? col : "#fff"; ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = closeable ? 2.5 : 1.5; ctx.stroke();
  }
  function drawManualOverlay(ctx, cam, state) {
    const sel = state.selection;
    for (let i = 0; i < (state.sections || []).length; i++) {
      polyPath(ctx, cam, state.sections[i].poly || PS.sectionCorners(state.sections[i]));
      const on = sel && sel.type === "section" && sel.index === i;
      ctx.strokeStyle = on ? COLORS.siteLine : "rgba(59,91,219,0.55)";
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    // faint centre dashes on the roads
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = Math.max(1, 1.2 * cam.scale);
    ctx.setLineDash([5 * cam.scale, 7 * cam.scale]);
    for (const r of state.roads || []) {
      if (r.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < r.length; i++) { const s = PS.w2s(cam, r[i][0], r[i][1]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
      ctx.stroke();
    }
    // internal section drive aisles (the drivable ladder cars route along)
    const al = state.parking && state.parking.aisleLines;
    if (al && al.length) {
      ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = Math.max(1, 1 * cam.scale);
      ctx.beginPath(); // one path + one stroke for all ladder lines (same style)
      for (const ln of al) { const a = PS.w2s(cam, ln[0][0], ln[0][1]), b = PS.w2s(cam, ln[1][0], ln[1][1]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // draft feedback while drawing
    const d = state._draft;
    if (d && d.type === "road" && d.pts && d.pts.length) {
      ctx.strokeStyle = "#3b5bdb"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < d.pts.length; i++) { const s = PS.w2s(cam, d.pts[i][0], d.pts[i][1]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
      if (d.cursor) { const s = PS.w2s(cam, d.cursor[0], d.cursor[1]); ctx.lineTo(s[0], s[1]); }
      ctx.stroke();
      for (const p of d.pts) { const s = PS.w2s(cam, p[0], p[1]); ctx.fillStyle = "#3b5bdb"; ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, Math.PI * 2); ctx.fill(); }
      drawFirstAnchor(ctx, cam, d, "#3b5bdb", 2);
    } else if (d && d.type === "poly" && d.pts && d.pts.length) {
      // polygon being clicked out (section = blue, building = green, trace = orange)
      const col = d.kind === "bldg" ? "#2f9e44" : d.kind === "trace" ? "#e8590c" : "#3b5bdb";
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < d.pts.length; i++) { const s = PS.w2s(cam, d.pts[i][0], d.pts[i][1]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
      if (d.cursor) { const s = PS.w2s(cam, d.cursor[0], d.cursor[1]); ctx.lineTo(s[0], s[1]); }
      ctx.stroke();
      if (d.pts.length >= 2) { // dashed edge closing back to the first anchor
        const tail = d.cursor || d.pts[d.pts.length - 1];
        const a = PS.w2s(cam, tail[0], tail[1]), b0 = PS.w2s(cam, d.pts[0][0], d.pts[0][1]);
        ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b0[0], b0[1]); ctx.stroke(); ctx.setLineDash([]);
      }
      for (const p of d.pts) { const s = PS.w2s(cam, p[0], p[1]); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2); ctx.fill(); }
      drawFirstAnchor(ctx, cam, d, col, 3);
    } else if (d && d.type === "round" && d.center && d.r != null) {
      const s = PS.w2s(cam, d.center[0], d.center[1]);
      ctx.strokeStyle = "#3b5bdb"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(2, d.r * cam.scale), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ---- top-level draw -----------------------------------------------------
  // Connection overlay (manual mode): shows the user what is wired together.
  //  · red dashed  = drive-network fragment NOT reachable from any gate → draw a road to link it
  //  · green dots  = junctions where roads / roundabouts / spurs actually meet
  //  · orange rings= gaps the app auto-welded (a hint you may want a real road there)
  function drawConnections(ctx, cam, state) {
    const net = state.traffic && state.traffic.net;
    if (!net) return;
    ctx.save();
    // isolated fragments
    ctx.lineWidth = Math.max(2, 3 * cam.scale);
    ctx.strokeStyle = "rgba(224,49,49,0.9)";
    const dash = Math.max(3, 4 * cam.scale);
    ctx.setLineDash([dash, dash]);
    for (const e of net.edges) {
      if (e.connected) continue;
      const A = net.nodes[e.a], B = net.nodes[e.b];
      const a = PS.w2s(cam, A.x, A.y), b = PS.w2s(cam, B.x, B.y);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.setLineDash([]);
    // auto-weld markers (link + ring)
    if (net.welds && net.welds.length) {
      ctx.strokeStyle = "rgba(240,140,0,0.95)"; ctx.lineWidth = Math.max(1.5, 1.4 * cam.scale);
      const wr = Math.max(3, 2.4 * cam.scale);
      for (const w of net.welds) {
        const a = PS.w2s(cam, w[0][0], w[0][1]), b = PS.w2s(cam, w[1][0], w[1][1]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        const s = PS.w2s(cam, (w[0][0] + w[1][0]) / 2, (w[0][1] + w[1][1]) / 2);
        ctx.beginPath(); ctx.arc(s[0], s[1], wr, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // junction dots
    if (net.junctions && net.junctions.length) {
      ctx.fillStyle = "rgba(47,158,68,0.95)"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      const r = Math.max(2, 1.5 * cam.scale);
      for (const p of net.junctions) {
        const s = PS.w2s(cam, p[0], p[1]);
        ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }

  PS.draw = function (state) {
    const { ctx, canvas, cam } = state;
    const W = canvas.width / (state.dpr || 1);
    const H = canvas.height / (state.dpr || 1);
    ctx.save();
    ctx.setTransform(state.dpr || 1, 0, 0, state.dpr || 1, 0, 0);

    if (state.mapMode) {
      ctx.clearRect(0, 0, W, H); // transparent so the real map shows through
    } else {
      ctx.fillStyle = COLORS.paper;
      ctx.fillRect(0, 0, W, H);
      if (state.decor) {
        drawDecor(ctx, cam, state.decor);
        drawStreets(ctx, cam, state.decor);
      }
    }

    const manual = state.layoutMode === "manual";
    if (manual) drawManualBase(ctx, cam, state, state.mapMode ? 0.55 : 1);
    else drawSiteAsphalt(ctx, cam, state.site, state.mapMode ? 0.5 : 1);
    if (PS.drawCrossings) PS.drawCrossings(ctx, cam, state); // zebras sit on the roads, under the cars
    if (state.parking) {
      // Clip lot content to the parcel (auto) so aisle dashes / overlays never
      // bleed onto the surroundings. In manual mode content is already confined.
      ctx.save();
      if (!manual) { polyPath(ctx, cam, state.site); ctx.clip(); }
      drawAisles(ctx, cam, state.parking.aisles);
      drawStalls(ctx, cam, state.parking.stalls);
      drawStallTypes(ctx, cam, state.parking.stalls);
      if (state.traffic && PS.drawTrafficHeat) PS.drawTrafficHeat(ctx, cam, state);
      drawCars(ctx, cam, state.parking.stalls);
      drawTrees(ctx, cam, state.parking.trees);
      if (state.traffic && PS.drawConflicts) PS.drawConflicts(ctx, cam, state);
      if (state.traffic && PS.drawTrafficAgents) PS.drawTrafficAgents(ctx, cam, state);
      if (state.traffic && PS.drawPeds) PS.drawPeds(ctx, cam, state);
      ctx.restore();
    }
    // Live visitor counts: cars currently parked-and-visiting each building.
    // Staff are tallied separately — they show up pre-opening on purpose.
    let visitors = null, staffCnt = null;
    if (state.traffic && state.traffic.cars && state.buildings && state.buildings.length) {
      visitors = new Array(state.buildings.length).fill(0);
      staffCnt = new Array(state.buildings.length).fill(0);
      for (const c of state.traffic.cars) {
        if (c.state !== "parked" || c.destB == null || c.destB < 0 || c.destB >= visitors.length) continue;
        if (c.staff) staffCnt[c.destB]++; else visitors[c.destB]++;
      }
    }
    const visitTotals = state.traffic && state.traffic.visitTotals;
    drawBuildings(ctx, cam, state.buildings, state.selection, visitors, visitTotals,
      state.traffic && state.traffic.hourNow ? state.traffic.hourNow() : null, staffCnt);
    // Entrance markers: where each building's visitors walk in (this is the
    // point parking is drawn toward). Small door-coloured dot on the edge.
    if (state.traffic && state.traffic.net && state.traffic.net.doors) {
      for (const d of state.traffic.net.doors) {
        if (!d) continue;
        const s = PS.w2s(cam, d[0], d[1]);
        ctx.beginPath(); ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e8590c"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    if (manual) drawManualOverlay(ctx, cam, state);
    if (manual && state.showConn) drawConnections(ctx, cam, state);
    if (state.traffic && PS.drawGates) PS.drawGates(ctx, cam, state);
    if (PS.drawHandles) PS.drawHandles(ctx, cam, state);
    if (state._analysisWorst) drawAnalysisMarker(ctx, cam, state._analysisWorst);
    if (state.showDims && !manual) drawDims(ctx, cam, state.site);

    // Empty-state hint: the app opens as a blank parcel with all guidance
    // buried in the panel. Until the first element is drawn (and no draft is
    // in progress), show a "start here" line centred on the canvas.
    const empty = manual && !state._draft &&
      !(state.roads || []).length && !(state.sections || []).length &&
      !(state.buildings || []).length && !(state.gates || []).length &&
      !(state.roundabouts || []).length;
    if (empty) {
      ctx.save();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "600 17px system-ui, sans-serif";
      ctx.fillStyle = "rgba(15,17,22,0.45)";
      ctx.fillText("Börja här: 1. Rita en Sektion (parkering)   2. Rita en Väg   3. Lägg till Infart och Utfart", W / 2, H / 2 - 14);
      ctx.font = "400 14px system-ui, sans-serif";
      ctx.fillStyle = "rgba(15,17,22,0.35)";
      ctx.fillText("Verktygen finns under Konstruera till höger — eller byt till Karta och traca en riktig plats.", W / 2, H / 2 + 14);
      ctx.restore();
    }

    ctx.restore();
  };

  // Attention marker for the worst bottleneck found by PS.analyze. Animated ping
  // rings + a labelled pin at the world point of the most congested edge.
  function drawAnalysisMarker(ctx, cam, m) {
    if (!m || !m.pt) return;
    const s = PS.w2s(cam, m.pt[0], m.pt[1]);
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    const ph = (now % 1500) / 1500;
    ctx.save();
    ctx.textAlign = "center";
    for (let k = 0; k < 2; k++) {
      const p = (ph + k * 0.5) % 1;
      ctx.beginPath();
      ctx.arc(s[0], s[1], 9 + p * 34, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(224,49,49,${(1 - p) * 0.55})`;
      ctx.lineWidth = 3; ctx.stroke();
    }
    // label pill above the pin
    const pct = m.cong != null ? " · " + Math.round(m.cong * 100) + "%" : "";
    const txt = "Flaskhals" + pct;
    ctx.font = "700 12px system-ui, sans-serif"; ctx.textBaseline = "middle";
    const w = ctx.measureText(txt).width + 16, h = 20, ly = s[1] - 34;
    ctx.fillStyle = "rgba(201,42,42,0.96)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(s[0] - w / 2, ly - h / 2, w, h, 6); ctx.fill(); }
    else ctx.fillRect(s[0] - w / 2, ly - h / 2, w, h);
    ctx.strokeStyle = "rgba(201,42,42,0.96)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(s[0], ly + h / 2); ctx.lineTo(s[0], s[1] - 9); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText(txt, s[0], ly);
    // solid core pin
    ctx.beginPath(); ctx.arc(s[0], s[1], 8, 0, Math.PI * 2);
    ctx.fillStyle = "#e03131"; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "800 12px system-ui, sans-serif";
    ctx.fillText("!", s[0], s[1] + 0.5);
    ctx.restore();
  }

  PS.BUILDING_FILLS = BUILDING_FILLS;
  PS.CAR_COLORS = CAR_COLORS;
})();
