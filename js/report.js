/* report.js — the traffic analyst + A–F report card.
 *
 * PS.analyze(state) runs a short, DETERMINISTIC benchmark of the current layout
 * under the current traffic settings, on a throwaway sim so the live view is not
 * disturbed (stall occupancy is snapshotted and restored). It grades four
 * dimensions — genomströmning (throughput), flöde (congestion), åtkomst (search)
 * and säkerhet (safety) — into an overall letter grade, and emits concrete,
 * data-driven suggestions for improving the plan.
 *
 * It is a rule-based expert analyst (no external API): instant, offline and
 * reproducible — the same layout + settings always grade the same.
 */
(function () {
  const PS = (window.PS = window.PS || {});
  const g = PS.geom;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function letter(s) { return s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : s >= 50 ? "E" : "F"; }

  // Rough compass label for a world point relative to the site centroid.
  function where(pt, site) {
    const c = g.centroid(site), bb = g.bbox(site);
    const dx = (pt[0] - c[0]) / (bb.w || 1), dy = (pt[1] - c[1]) / (bb.h || 1);
    let ns = dy < -0.2 ? "norra" : dy > 0.2 ? "södra" : "";
    let ew = dx < -0.2 ? "västra" : dx > 0.2 ? "östra" : "";
    if (ns && ew) return ns + " " + ew + " delen";
    if (ns) return ns + " delen";
    if (ew) return ew + " delen";
    return "mitten";
  }

  PS.analyze = function (state) {
    if (!state.parking || !state.parking.stalls.length)
      return { ok: false, message: "Ingen parkering att analysera. Lägg till platser först." };

    const stalls = state.parking.stalls;
    // Snapshot occupancy so the throwaway benchmark can't corrupt the live view.
    const snap = stalls.map((s) => ({ o: s.occupied, r: s.reserved, c: s.color }));

    const live = state.traffic;
    const sim = PS.createTraffic(state);
    // Mirror the current tuning so the grade reflects what the user set.
    if (live) {
      sim.arrivalRate = live.arrivalRate; sim.dwellMin = live.dwellMin; sim.speedKmh = live.speedKmh;
      // With a day curve, grade the DESIGN CASE: rush hour (the curve's peak),
      // with the clock pinned at that hour so opening hours apply correctly.
      if (Array.isArray(live.arrivalCurve) && live.arrivalCurve.length === 24) {
        let pk = 0, ph = 15;
        for (let i = 0; i < 24; i++) if (live.arrivalCurve[i] > pk) { pk = live.arrivalCurve[i]; ph = i; }
        sim.arrivalRate = Math.max(1, pk); sim.clockStart = ph;
      }
      sim.meanAggr = live.meanAggr; sim.meanCaution = live.meanCaution;
      sim.traitSpread = live.traitSpread; sim.allowOvertake = live.allowOvertake;
    }
    sim.reseed(1337);
    sim.rebuild();

    if (!sim.net || !sim.net.edges || !sim.net.edges.length) {
      stalls.forEach((s, i) => { s.occupied = snap[i].o; s.reserved = snap[i].r; s.color = snap[i].c; });
      return { ok: false, message: "Inget körnät. Rita minst en väg och lägg en in- och en utfart." };
    }
    if (!sim.net.entrances.length || !sim.net.exits.length) {
      stalls.forEach((s, i) => { s.occupied = snap[i].o; s.reserved = snap[i].r; s.color = snap[i].c; });
      return { ok: false, message: "Saknar in- eller utfart. Lägg till minst en infart och en utfart." };
    }

    const dt = sim.dt;
    const warm = Math.round(45 / dt), meas = Math.round(120 / dt);
    for (let i = 0; i < warm; i++) sim.step(dt);
    const base = { t: sim.t, parked: sim.parkedTotal, away: sim.turnedAway, coll: sim.collisions, gave: sim.gaveUp || 0 };

    // Sample congestion + queueing through the measurement window.
    let congAcc = 0, queueAcc = 0, circAcc = 0, sampN = 0, worstC = 0, worstEdge = -1;
    for (let i = 0; i < meas; i++) {
      sim.step(dt);
      if (i % 8 === 0) {
        let lw = 0, ld = 0;
        for (const e of sim.net.edges) { if (e.load > 0) { lw += e.cong * e.load; ld += e.load; if (e.cong > worstC) { worstC = e.cong; worstEdge = e.id; } } }
        congAcc += ld ? lw / ld : 0;
        queueAcc += sim.stats.queuing; circAcc += sim.stats.circulating; sampN++;
      }
    }
    const dMin = Math.max(1e-6, (sim.t - base.t) / 60);
    const served = sim.parkedTotal - base.parked;
    const away = sim.turnedAway - base.away;
    const coll = sim.collisions - base.coll;
    const gave = (sim.gaveUp || 0) - base.gave;
    const arrivals = Math.max(1, sim.arrivalRate * dMin);

    // Stalls that no entrance can reach (a disconnected section / missing driveway).
    let unreachable = 0;
    for (let k = 0; k < stalls.length; k++) {
      const sa = sim.net.stallAccess[k]; if (!sa) { unreachable++; continue; }
      const ed = sim.net.edges[sa.aisleIndex]; if (!ed) { unreachable++; continue; }
      let ok = false;
      for (const dj of sim.net.fromIn) { if (isFinite(dj.dist[ed.a]) || isFinite(dj.dist[ed.b])) { ok = true; break; } }
      if (!ok) unreachable++;
    }

    const worstPt = worstEdge >= 0 ? (() => { const e = sim.net.edges[worstEdge]; return [(sim.net.nodes[e.a].x + sim.net.nodes[e.b].x) / 2, (sim.net.nodes[e.a].y + sim.net.nodes[e.b].y) / 2]; })() : null;

    // Restore the live view's occupancy.
    stalls.forEach((s, i) => { s.occupied = snap[i].o; s.reserved = snap[i].r; s.color = snap[i].c; });

    // ---- metrics ----
    const rejectRate = clamp(away / arrivals, 0, 1);
    const servedRate = served / dMin;                         // cars parked / min
    const avgCong = sampN ? congAcc / sampN : 0;              // load-weighted 0..1
    const queueFrac = sampN && circAcc ? clamp(queueAcc / Math.max(1, circAcc), 0, 1) : 0;
    const avgSearch = sim.stats.avgSearch;                     // s
    const incidentRate = served > 0 ? (coll + gave) / served : (coll + gave > 0 ? 1 : 0);

    // ---- dimension scores (0..100) ----
    const sThroughput = Math.round(100 * (1 - rejectRate));
    const sFlow = Math.round(clamp(100 * (1 - 0.6 * avgCong - 0.4 * queueFrac), 0, 100));
    const sAccess = Math.round(clamp(100 * (120 - avgSearch) / (120 - 15), 0, 100));
    let sSafety = Math.round(clamp(100 - incidentRate * 400, 0, 100));
    if (unreachable > 0) sSafety = Math.min(sSafety, 45); // a plan defect, not just risk

    const dims = [
      { key: "throughput", label: "Genomströmning", score: sThroughput, detail: `${Math.round(rejectRate * 100)}% avvisade · ${servedRate.toFixed(1)} bilar/min in` },
      { key: "flow", label: "Flöde", score: sFlow, detail: `${Math.round(avgCong * 100)}% trängsel · ${Math.round(queueFrac * 100)}% i kö` },
      { key: "access", label: "Åtkomst", score: sAccess, detail: `${Math.round(avgSearch)} s snitt söktid` },
      { key: "safety", label: "Säkerhet", score: sSafety, detail: `${coll} krock · ${gave} gav upp${unreachable ? ` · ${unreachable} onåbara` : ""}` },
    ];
    dims.forEach((d) => (d.grade = letter(d.score)));

    let overall = Math.round(0.35 * sThroughput + 0.30 * sFlow + 0.20 * sAccess + 0.15 * sSafety);
    if (unreachable > 0) overall = Math.min(overall, 55); // cap when platser can't be reached

    // ---- suggestions (specific, data-driven) ----
    const tips = [];
    if (unreachable > 0)
      tips.push(`${unreachable} p-platser går inte att nå från infarten — dra en väg närmare den frånkopplade sektionen (spuren når ~30 m).`);
    if (rejectRate > 0.15)
      tips.push(`Nätet är mättat (${Math.round(rejectRate * 100)}% avvisade). Lägg till en infart eller bredda huvudstråket — annars sänk ankomsttakten.`);
    if (worstPt && worstC > 0.5)
      tips.push(`Flaskhals i ${where(worstPt, state.site)} (${Math.round(worstC * 100)}% trängsel). Lägg en parallell körväg eller extra tvärkoppling där.`);
    if (avgSearch > 40)
      tips.push(`Lång söktid (${Math.round(avgSearch)} s). Placera infarten närmare platserna eller lägg fler infarter mot sektionerna.`);
    if (queueFrac > 0.35)
      tips.push(`Mycket köbildning (${Math.round(queueFrac * 100)}% står stilla). Separera in- och utfart eller lägg till en andra infart.`);
    if (coll > 0)
      tips.push(`${coll} krockar under mätningen. Sänk aggressiviteten, bredda körgångarna eller separera mötande trafik.`);
    if (gave > 0)
      tips.push(`${gave} bilar gav upp (fast i kö/återvändsgränd). Kontrollera att alla körgångar når en utfart.`);
    if (state.layoutMode === "auto" && sThroughput < 70 && (state.gates || []).filter((x) => x.type === "in").length < 2)
      tips.push(`Prova en andra infart på motsatt sida — auto-nätet fördelar då trafiken över två grindar.`);
    if (!tips.length)
      tips.push("Bra flöde! Layouten klarar den nuvarande belastningen utan flaskhalsar. Testa att höja ankomsttakten för att hitta taket.");

    return {
      ok: true,
      grade: letter(overall),
      score: overall,
      dims,
      suggestions: tips,
      worstPt,
      worstCong: +worstC.toFixed(3),
      metrics: {
        servedRate: +servedRate.toFixed(2), rejectRate: +rejectRate.toFixed(3),
        avgCong: +avgCong.toFixed(3), queueFrac: +queueFrac.toFixed(3),
        avgSearch: +avgSearch.toFixed(1), collisions: coll, gaveUp: gave,
        unreachable, stalls: stalls.length, windowSec: 120,
        arrivalRate: sim.arrivalRate, dwellMin: sim.dwellMin, speedKmh: sim.speedKmh,
      },
    };
  };
})();
