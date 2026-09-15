const SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TFMMqLxLWHatd3lXYrUlTQ_aO7MvaQ9";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: "flight_tracker" },
});

const DURATIONS = [10, 11, 12, 13, 14];

// Each destination owns its own trip window -- must mirror
// scraper/fetch_prices.py's DESTINATIONS dict. Add a new destination here
// (with whatever month fits it) and it works immediately, independent of
// every other destination's dates.
const DESTINATIONS = [
  { code: "OSL", label: "Norway (Oslo)", outboundStart: "2027-05-01", outboundEnd: "2027-06-30" },
  { code: "YYC", label: "Western Canada (Calgary)", outboundStart: "2027-05-01", outboundEnd: "2027-06-30" },
  { code: "YVR", label: "Western Canada (Vancouver)", outboundStart: "2027-05-01", outboundEnd: "2027-06-30" },
  { code: "ANC", label: "Alaska (Anchorage)", outboundStart: "2027-05-01", outboundEnd: "2027-06-30" },
  { code: "ORD", label: "Chicago", outboundStart: "2027-05-01", outboundEnd: "2027-06-30" },
];

function destInfo(code) {
  return DESTINATIONS.find((d) => d.code === code);
}

// Fixed categorical hue order -- assigned to airlines in the order they're
// first seen for the selected destination, so identity stays stable while a
// destination is open but isn't hardcoded per-airline (different
// destinations have different real carriers).
const SERIES_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6"];

// Airlines chosen to feature per destination (real single-carrier itineraries
// confirmed via research/testing -- see project notes). Shown first, in this
// order, ahead of any other single-carrier airline the scraper happens to
// find. Destinations not listed here fall back to whatever's discovered.
const FEATURED_AIRLINES = {
  OSL: ["Scandinavian Airlines", "Lufthansa", "LOT", "Austrian Airlines"],
};

let currentDestination = DESTINATIONS[0].code;
let currentAirlines = []; // [{name, series}] discovered for currentDestination

function toISO(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function allDepartureDates(destinationCode) {
  const info = destInfo(destinationCode);
  const start = new Date(info.outboundStart + "T00:00:00Z");
  const end = new Date(info.outboundEnd + "T00:00:00Z");
  const dates = [];
  let d = start;
  while (d <= end) {
    dates.push(toISO(d));
    d = addDays(d, 1);
  }
  return dates;
}

function allReturnDates(destinationCode) {
  const info = destInfo(destinationCode);
  const start = addDays(new Date(info.outboundStart + "T00:00:00Z"), Math.min(...DURATIONS));
  const end = addDays(new Date(info.outboundEnd + "T00:00:00Z"), Math.max(...DURATIONS));
  const dates = [];
  let d = start;
  while (d <= end) {
    dates.push(toISO(d));
    d = addDays(d, 1);
  }
  return dates;
}
function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function svgns(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}
function lerpColor(hexA, hexB, t) {
  const a = hexA.match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = hexB.match(/\w\w/g).map((h) => parseInt(h, 16));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function priceToColor(price, min, max) {
  if (min === max) return getVar("--seq-400");
  const t = Math.max(0, Math.min(1, (price - min) / (max - min)));
  return lerpColor(getVar("--seq-100"), getVar("--seq-700"), t);
}
function shortName(name, max = 14) {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// ---------- Latest snapshot (for overview + "totals now") ----------

let latestSampleDate = null;
let outboundLatest = {}; // flight_date -> prices jsonb
let returnLatest = {}; // flight_date -> prices jsonb

async function loadLatestSnapshot(destination) {
  const { data: latestRows, error: latestErr } = await sb
    .from("one_way_prices")
    .select("sample_date")
    .eq("destination", destination)
    .order("sample_date", { ascending: false })
    .limit(1);

  if (latestErr || !latestRows || !latestRows.length) {
    document.getElementById("heatmapStatus").textContent =
      "No data yet for this destination -- the daily fetch hasn't run, or hasn't been recorded yet.";
    outboundLatest = {};
    returnLatest = {};
    currentAirlines = [];
    return;
  }
  latestSampleDate = latestRows[0].sample_date;

  const { data, error } = await sb
    .from("one_way_prices")
    .select("flight_date,direction,prices")
    .eq("destination", destination)
    .eq("sample_date", latestSampleDate);

  if (error) {
    document.getElementById("heatmapStatus").textContent = "Failed to load snapshot: " + error.message;
    return;
  }

  outboundLatest = {};
  returnLatest = {};
  const seenAirlines = [];
  for (const row of data) {
    const target = row.direction === "OUTBOUND" ? outboundLatest : returnLatest;
    target[row.flight_date] = row.prices || {};
    for (const name of Object.keys(row.prices || {})) {
      if (!seenAirlines.includes(name)) seenAirlines.push(name);
    }
  }
  const featured = (FEATURED_AIRLINES[destination] || []).filter((name) => seenAirlines.includes(name));
  const rest = seenAirlines.filter((name) => !featured.includes(name)).sort();
  const ordered = [...featured, ...rest].slice(0, SERIES_COLORS.length);
  currentAirlines = ordered.map((name, i) => ({ name, series: SERIES_COLORS[i] }));

  document.getElementById("heatmapStatus").textContent = `Snapshot from ${latestSampleDate} (${data.length} one-way checks that day).`;
}

function latestFor(direction) {
  return direction === "OUTBOUND" ? outboundLatest : returnLatest;
}

// ---------- Quick stats (cheapest ever seen, full history) ----------

async function renderQuickStats(destination) {
  const el = document.getElementById("quickStats");
  el.innerHTML = '<p class="empty-note">Loading...</p>';

  const { data, error } = await sb
    .from("one_way_prices")
    .select("flight_date,direction,prices")
    .eq("destination", destination)
    .not("prices", "is", null);

  if (error || !data || !data.length) {
    el.innerHTML = '<p class="empty-note">No data yet for this destination.</p>';
    return;
  }

  const best = {}; // name -> {price, date, direction}
  for (const row of data) {
    for (const [name, price] of Object.entries(row.prices || {})) {
      if (!best[name] || price < best[name].price) {
        best[name] = { price, date: row.flight_date, direction: row.direction };
      }
    }
  }

  const featured = FEATURED_AIRLINES[destination] || [];
  const names = Object.keys(best).sort((a, b) => {
    const fa = featured.indexOf(a);
    const fb = featured.indexOf(b);
    if (fa !== -1 || fb !== -1) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);
    return best[a].price - best[b].price;
  });
  const shown = names.slice(0, 8);

  el.innerHTML = shown
    .map((name) => {
      const b = best[name];
      const airline = currentAirlines.find((a) => a.name === name);
      const color = airline ? getVar(airline.series) : getVar("--accent");
      const dirLabel = b.direction === "OUTBOUND" ? "outbound" : "return";
      return `
        <div class="stat-tile" style="--tile-color:${color}">
          <div class="stat-tile-label">${name}</div>
          <div class="stat-tile-value">$${b.price}</div>
          <div class="stat-tile-sub">${dirLabel} &middot; ${b.date}</div>
        </div>`;
    })
    .join("");
}

// ---------- Heatmap overview ----------

function renderHeatmapLegend() {
  const el = document.getElementById("heatmapLegend");
  el.innerHTML = `
    <span><span class="swatch" style="background:${getVar("--seq-100")}"></span>Cheaper</span>
    <span><span class="swatch" style="background:${getVar("--seq-700")}"></span>More expensive</span>
    <span><span class="swatch" style="background:${getVar("--gridline")}"></span>No price that day</span>
  `;
}

function renderOneWayHeatmap(svgId, dates, dataByDate, directionLabel) {
  const cellW = 900 / dates.length;
  const cellH = 30;
  const rowGap = 4;
  const labelW = 128;
  const svg = document.getElementById(svgId);

  if (!currentAirlines.length) {
    svg.setAttribute("viewBox", `0 0 900 60`);
    svg.innerHTML = "";
    const t = svgns("text");
    t.setAttribute("x", 10);
    t.setAttribute("y", 30);
    t.setAttribute("class", "axis-label");
    t.textContent = "No airline data yet for this destination.";
    svg.appendChild(t);
    return;
  }

  const height = rowGap * (currentAirlines.length + 1) + cellH * currentAirlines.length;
  const width = labelW + dates.length * cellW;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const pricesByAirlineDate = currentAirlines.map((a) =>
    dates.map((d) => (dataByDate[d] ? dataByDate[d][a.name] : null) ?? null)
  );
  const allVals = pricesByAirlineDate.flat().filter((v) => v != null);
  const min = allVals.length ? Math.min(...allVals) : 0;
  const max = allVals.length ? Math.max(...allVals) : 1;

  const tooltip = document.getElementById("heatmapTooltip");

  currentAirlines.forEach((a, rIdx) => {
    const label = svgns("text");
    label.setAttribute("x", 0);
    label.setAttribute("y", rowGap * (rIdx + 1) + cellH * rIdx + cellH / 2 + 4);
    label.setAttribute("class", "heatmap-row-label");
    label.textContent = shortName(a.name, 17);
    svg.appendChild(label);

    dates.forEach((d, cIdx) => {
      const price = pricesByAirlineDate[rIdx][cIdx];
      const x = labelW + cIdx * cellW;
      const y = rowGap * (rIdx + 1) + cellH * rIdx;

      const rect = svgns("rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", Math.max(cellW - 1, 1));
      rect.setAttribute("height", cellH);
      rect.setAttribute("rx", 2);
      rect.setAttribute("fill", price != null ? priceToColor(price, min, max) : getVar("--gridline"));

      rect.addEventListener("mousemove", (e) => {
        tooltip.style.display = "block";
        tooltip.style.left = e.clientX + 12 + "px";
        tooltip.style.top = e.clientY + 12 + "px";
        tooltip.textContent = price != null ? `${a.name} - ${directionLabel} ${d}: $${price}` : `${a.name} - ${directionLabel} ${d}: no price that day`;
      });
      rect.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });

      svg.appendChild(rect);
    });
  });
}

// ---------- Flight detail (outbound and return handled identically, each on its own) ----------

function renderOneWayTotals(containerId, direction, date) {
  const el = document.getElementById(containerId);
  const prices = latestFor(direction)[date] || {};
  const all = currentAirlines.map((a) => ({ ...a, price: prices[a.name] ?? null }));
  const rows = all.filter((r) => r.price != null).sort((a, b) => a.price - b.price);
  const missing = all.filter((r) => r.price == null);

  if (!rows.length) {
    el.innerHTML = '<p class="empty-note">No airline has a price for this date in the latest snapshot yet.</p>';
    return;
  }

  const rowsHtml = rows
    .map(
      (r, i) => `
      <div class="totals-row ${i === 0 ? "totals-row-best" : ""}">
        <span class="totals-rank">${i + 1}</span>
        <span class="swatch" style="background:${getVar(r.series)}"></span>
        <span class="totals-airline">${r.name}</span>
        <span class="totals-price">$${r.price}</span>
      </div>`
    )
    .join("");

  // Airlines tracked overall but with no price for THIS specific date need to
  // say so explicitly -- silently omitting them reads as "not tracked at
  // all", not "no data for this exact date yet" (real confusion Uriya hit:
  // SAS looked completely absent from Norway when it was actually priced on
  // 91% of days, just not this one).
  const missingNote = missing.length
    ? `<p class="status-line" style="margin-top:10px">No price yet for this date: ${missing.map((r) => r.name).join(", ")}.</p>`
    : "";

  el.innerHTML = rowsHtml + missingNote;
}

async function renderOneWayHistory(direction, date, ids) {
  const statusEl = document.getElementById(ids.status);
  statusEl.textContent = "Loading...";

  const { data, error } = await sb
    .from("one_way_prices")
    .select("sample_date,prices")
    .eq("destination", currentDestination)
    .eq("flight_date", date)
    .eq("direction", direction)
    .order("sample_date", { ascending: true });

  if (error) {
    statusEl.textContent = "Failed to load: " + error.message;
    return;
  }

  const rows = data.map((row) => {
    const r = { sample_date: row.sample_date };
    for (const a of currentAirlines) r[a.name] = row.prices ? row.prices[a.name] ?? null : null;
    return r;
  });

  if (!rows.length) {
    statusEl.textContent = "No samples recorded yet for this date.";
    document.getElementById(ids.chart).innerHTML = "";
    document.getElementById(ids.tableBody).innerHTML = "";
    return;
  }

  statusEl.textContent = `${rows.length} daily samples from ${rows[0].sample_date} to ${rows[rows.length - 1].sample_date}.`;

  drawLineChart(rows, ids);
  renderHistoryTable(rows, ids);
}

function renderHistoryTable(rows, ids) {
  const tbody = document.getElementById(ids.tableBody);
  tbody.innerHTML = "";
  [...rows].reverse().forEach((row) => {
    const cells = currentAirlines.map((a) => `<td>${row[a.name] != null ? "$" + row[a.name] : "-"}</td>`).join("");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.sample_date}</td>${cells}`;
    tbody.appendChild(tr);
  });
}

function drawLineChart(points, ids) {
  const width = 900;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 28, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = document.getElementById(ids.chart);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const allVals = points.flatMap((p) => currentAirlines.map((a) => p[a.name])).filter((v) => v != null);
  if (!allVals.length) {
    const t = svgns("text");
    t.setAttribute("x", width / 2);
    t.setAttribute("y", height / 2);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "axis-label");
    t.textContent = "No airline has a price yet for this date";
    svg.appendChild(t);
    return;
  }

  const minP = Math.min(...allVals) * 0.95;
  const maxP = Math.max(...allVals) * 1.05;
  const x = (i) => margin.left + (innerW * i) / Math.max(points.length - 1, 1);
  const y = (v) => margin.top + innerH - (innerH * (v - minP)) / (maxP - minP);

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = minP + ((maxP - minP) * i) / ticks;
    const gy = y(val);
    const line = svgns("line");
    line.setAttribute("x1", margin.left);
    line.setAttribute("x2", width - margin.right);
    line.setAttribute("y1", gy);
    line.setAttribute("y2", gy);
    line.setAttribute("class", "gridline");
    svg.appendChild(line);

    const label = svgns("text");
    label.setAttribute("x", margin.left - 8);
    label.setAttribute("y", gy + 3);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "axis-label");
    label.textContent = `$${Math.round(val)}`;
    svg.appendChild(label);
  }

  [0, Math.floor((points.length - 1) / 2), points.length - 1].forEach((i) => {
    const label = svgns("text");
    label.setAttribute("x", x(i));
    label.setAttribute("y", height - margin.bottom + 16);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "axis-label");
    label.textContent = points[i].sample_date;
    svg.appendChild(label);
  });

  currentAirlines.forEach((a) => {
    let d = "";
    let started = false;
    points.forEach((p, i) => {
      if (p[a.name] == null) {
        started = false;
        return;
      }
      d += `${started ? "L" : "M"}${x(i)},${y(p[a.name])} `;
      started = true;
    });
    if (!d) return;
    const path = svgns("path");
    path.setAttribute("d", d.trim());
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", getVar(a.series));
    path.setAttribute("stroke-width", 2);
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
  });

  const tooltip = document.getElementById(ids.tooltip);
  const hitArea = svgns("rect");
  hitArea.setAttribute("x", margin.left);
  hitArea.setAttribute("y", margin.top);
  hitArea.setAttribute("width", innerW);
  hitArea.setAttribute("height", innerH);
  hitArea.setAttribute("fill", "transparent");
  svg.appendChild(hitArea);

  hitArea.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((relX - margin.left) / innerW) * (points.length - 1));
    const p = points[Math.max(0, Math.min(points.length - 1, i))];
    if (!p) return;
    tooltip.style.display = "block";
    tooltip.style.left = e.clientX + 12 + "px";
    tooltip.style.top = e.clientY + 12 + "px";
    tooltip.innerHTML =
      `${p.sample_date}<br>` + currentAirlines.map((a) => `${a.name}: ${p[a.name] != null ? "$" + p[a.name] : "-"}`).join("<br>");
  });
  hitArea.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
}

// ---------- Wiring ----------

const FLIGHT_DIRECTIONS = [
  {
    direction: "OUTBOUND",
    dateSelect: "outboundDateSelect",
    dates: () => allDepartureDates(currentDestination),
    ids: { totals: "outboundTotals", legend: "outboundLegend", status: "outboundStatus", chart: "outboundChart", tooltip: "outboundTooltip", tableHead: "outboundTableHead", tableBody: "outboundTableBody" },
  },
  {
    direction: "RETURN",
    dateSelect: "returnDateSelect",
    dates: () => allReturnDates(currentDestination),
    ids: { totals: "returnTotals", legend: "returnLegend", status: "returnStatus", chart: "returnChart", tooltip: "returnTooltip", tableHead: "returnTableHead", tableBody: "returnTableBody" },
  },
];

function populateStaticSelects() {
  const destSelect = document.getElementById("destinationSelect");
  DESTINATIONS.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.code;
    opt.textContent = d.label;
    destSelect.appendChild(opt);
  });
}

function populateDateSelect(selectId, dates) {
  const select = document.getElementById(selectId);
  select.innerHTML = "";
  dates.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  });
}

function renderFlightLegend(legendId) {
  const el = document.getElementById(legendId);
  el.innerHTML =
    currentAirlines.map((a) => `<span><span class="swatch" style="background:${getVar(a.series)}"></span>${a.name}</span>`).join("") ||
    '<span class="empty-note">No airlines yet</span>';
}

function renderFlightTableHead(theadId) {
  document.getElementById(theadId).innerHTML = `<tr><th>Date checked</th>${currentAirlines.map((a) => `<th>${a.name}</th>`).join("")}</tr>`;
}

async function refreshFlight(fd) {
  const date = document.getElementById(fd.dateSelect).value;
  renderOneWayTotals(fd.ids.totals, fd.direction, date);
  await renderOneWayHistory(fd.direction, date, fd.ids);
}

// Land on a date that actually has a priced airline instead of always the
// first one in the range (which is very likely empty and makes the whole
// section look broken on first load).
function pickDefaultDate(fd) {
  const dates = fd.dates();
  const data = latestFor(fd.direction);
  for (const d of dates) {
    if (data[d] && currentAirlines.some((a) => data[d][a.name] != null)) return d;
  }
  return dates[0];
}

function renderHeatmaps() {
  renderOneWayHeatmap("heatmapOutbound", allDepartureDates(currentDestination), outboundLatest, "outbound");
  renderOneWayHeatmap("heatmapReturn", allReturnDates(currentDestination), returnLatest, "return");
}

async function loadDestination(destination) {
  currentDestination = destination;
  await loadLatestSnapshot(destination);
  renderHeatmaps();
  renderQuickStats(destination);

  for (const fd of FLIGHT_DIRECTIONS) {
    populateDateSelect(fd.dateSelect, fd.dates());
    renderFlightLegend(fd.ids.legend);
    renderFlightTableHead(fd.ids.tableHead);
    document.getElementById(fd.dateSelect).value = pickDefaultDate(fd);
    await refreshFlight(fd);
  }
}

async function init() {
  populateStaticSelects();
  renderHeatmapLegend();

  document.getElementById("destinationSelect").addEventListener("change", (e) => loadDestination(e.target.value));
  FLIGHT_DIRECTIONS.forEach((fd) => {
    document.getElementById(fd.dateSelect).addEventListener("change", () => refreshFlight(fd));
  });

  await loadDestination(currentDestination);
}

init();
