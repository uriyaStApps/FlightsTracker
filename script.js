const SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TFMMqLxLWHatd3lXYrUlTQ_aO7MvaQ9";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: "tlv_osl_prices" },
});

const TRIP_YEAR = 2027;
const OUTBOUND_START = new Date(Date.UTC(TRIP_YEAR, 4, 1)); // May 1
const OUTBOUND_END = new Date(Date.UTC(TRIP_YEAR, 5, 30)); // June 30
const DURATIONS = [10, 11, 12, 13, 14];

const AIRLINES = [
  { key: "sas_price", label: "SAS", series: "--series-sas" },
  { key: "lufthansa_price", label: "Lufthansa", series: "--series-lufthansa" },
  { key: "lot_price", label: "LOT", series: "--series-lot" },
  { key: "austrian_price", label: "Austrian", series: "--series-austrian" },
];

function toISO(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function allDepartureDates() {
  const dates = [];
  let d = OUTBOUND_START;
  while (d <= OUTBOUND_END) {
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

// ---------- Latest snapshot (for overview + "totals now") ----------

let latestSampleDate = null;
let outboundLatest = {}; // flight_date -> row
let returnLatest = {}; // flight_date -> row

async function loadLatestSnapshot() {
  const { data: latestRows, error: latestErr } = await sb
    .from("one_way_prices")
    .select("sample_date")
    .order("sample_date", { ascending: false })
    .limit(1);

  if (latestErr || !latestRows || !latestRows.length) {
    document.getElementById("heatmapStatus").textContent =
      "No data yet -- the first daily fetch hasn't run, or hasn't been recorded yet.";
    return;
  }
  latestSampleDate = latestRows[0].sample_date;

  const { data, error } = await sb
    .from("one_way_prices")
    .select("flight_date,direction,sas_price,lufthansa_price,lot_price,austrian_price")
    .eq("sample_date", latestSampleDate);

  if (error) {
    document.getElementById("heatmapStatus").textContent = "Failed to load snapshot: " + error.message;
    return;
  }

  outboundLatest = {};
  returnLatest = {};
  for (const row of data) {
    (row.direction === "TLV_OSL" ? outboundLatest : returnLatest)[row.flight_date] = row;
  }
  document.getElementById("heatmapStatus").textContent = `Snapshot from ${latestSampleDate} (${data.length} one-way checks that day).`;
}

function totalFor(depDate, retDate, airlineKey) {
  const out = outboundLatest[depDate];
  const ret = returnLatest[retDate];
  if (!out || !ret || out[airlineKey] == null || ret[airlineKey] == null) return null;
  return out[airlineKey] + ret[airlineKey];
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

function renderHeatmap(nights) {
  const dates = allDepartureDates();
  const cellW = 900 / dates.length;
  const cellH = 30;
  const rowGap = 4;
  const labelW = 78;
  const height = rowGap * (AIRLINES.length + 1) + cellH * AIRLINES.length;
  const width = labelW + dates.length * cellW;

  const svg = document.getElementById("heatmap");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const totalsByAirlineDate = AIRLINES.map((a) =>
    dates.map((dep) => totalFor(dep, toISO(addDays(new Date(dep), nights)), a.key))
  );
  const allVals = totalsByAirlineDate.flat().filter((v) => v != null);
  const min = allVals.length ? Math.min(...allVals) : 0;
  const max = allVals.length ? Math.max(...allVals) : 1;

  const tooltip = document.getElementById("heatmapTooltip");

  AIRLINES.forEach((a, rIdx) => {
    const label = svgns("text");
    label.setAttribute("x", 0);
    label.setAttribute("y", rowGap * (rIdx + 1) + cellH * rIdx + cellH / 2 + 4);
    label.setAttribute("class", "heatmap-row-label");
    label.textContent = a.label;
    svg.appendChild(label);

    dates.forEach((dep, cIdx) => {
      const price = totalsByAirlineDate[rIdx][cIdx];
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
        tooltip.style.left = e.pageX + 12 + "px";
        tooltip.style.top = e.pageY + 12 + "px";
        tooltip.textContent = price != null ? `${a.label} - ${dep}: $${price} round trip` : `${a.label} - ${dep}: no price that day`;
      });
      rect.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });

      svg.appendChild(rect);
    });
  });
}

// ---------- Trip detail: totals now, history chart, samples table ----------

function renderTotalsNow(depDate, retDate) {
  const el = document.getElementById("totalsNow");
  const rows = AIRLINES.map((a) => ({ ...a, total: totalFor(depDate, retDate, a.key) }))
    .filter((r) => r.total != null)
    .sort((a, b) => a.total - b.total);

  if (!rows.length) {
    el.innerHTML = '<p class="empty-note">No airline has both legs priced for this trip in the latest snapshot yet.</p>';
    return;
  }

  el.innerHTML = rows
    .map(
      (r, i) => `
      <div class="totals-row ${i === 0 ? "totals-row-best" : ""}">
        <span class="swatch" style="background:${getVar(r.series)}"></span>
        <span class="totals-airline">${r.label}</span>
        <span class="totals-price">$${r.total}</span>
      </div>`
    )
    .join("");
}

async function renderHistory(depDate, retDate) {
  const statusEl = document.getElementById("lineStatus");
  statusEl.textContent = "Loading...";

  const [outRes, retRes] = await Promise.all([
    sb
      .from("one_way_prices")
      .select("sample_date,sas_price,lufthansa_price,lot_price,austrian_price")
      .eq("flight_date", depDate)
      .eq("direction", "TLV_OSL")
      .order("sample_date", { ascending: true }),
    sb
      .from("one_way_prices")
      .select("sample_date,sas_price,lufthansa_price,lot_price,austrian_price")
      .eq("flight_date", retDate)
      .eq("direction", "OSL_TLV")
      .order("sample_date", { ascending: true }),
  ]);

  if (outRes.error || retRes.error) {
    statusEl.textContent = "Failed to load: " + (outRes.error || retRes.error).message;
    return;
  }

  const byDate = {};
  for (const row of outRes.data) {
    byDate[row.sample_date] = { sample_date: row.sample_date, out: row };
  }
  for (const row of retRes.data) {
    byDate[row.sample_date] = byDate[row.sample_date] || { sample_date: row.sample_date };
    byDate[row.sample_date].ret = row;
  }

  const points = Object.values(byDate).sort((a, b) => (a.sample_date < b.sample_date ? -1 : 1));
  const rows = points.map((p) => {
    const row = { sample_date: p.sample_date };
    for (const a of AIRLINES) {
      const o = p.out ? p.out[a.key] : null;
      const r = p.ret ? p.ret[a.key] : null;
      row[a.key] = o != null && r != null ? o + r : null;
    }
    return row;
  });

  if (!rows.length) {
    statusEl.textContent = "No samples recorded yet for this trip.";
    document.getElementById("lineChart").innerHTML = "";
    document.getElementById("historyTableBody").innerHTML = "";
    return;
  }

  statusEl.textContent = `${rows.length} daily samples from ${rows[0].sample_date} to ${rows[rows.length - 1].sample_date}. Departing ${depDate}, returning ${retDate}.`;

  drawLineChart(rows);
  renderHistoryTable(rows);
}

function renderHistoryTable(rows) {
  const tbody = document.getElementById("historyTableBody");
  tbody.innerHTML = "";
  [...rows].reverse().forEach((row) => {
    const cells = AIRLINES.map((a) => `<td>${row[a.key] != null ? "$" + row[a.key] : "-"}</td>`).join("");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.sample_date}</td>${cells}`;
    tbody.appendChild(tr);
  });
}

function drawLineChart(points) {
  const width = 900;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 28, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = document.getElementById("lineChart");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const allVals = points.flatMap((p) => AIRLINES.map((a) => p[a.key])).filter((v) => v != null);
  if (!allVals.length) {
    const t = svgns("text");
    t.setAttribute("x", width / 2);
    t.setAttribute("y", height / 2);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "axis-label");
    t.textContent = "No airline has both legs priced yet for this trip";
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

  AIRLINES.forEach((a) => {
    let d = "";
    let started = false;
    points.forEach((p, i) => {
      if (p[a.key] == null) {
        started = false;
        return;
      }
      d += `${started ? "L" : "M"}${x(i)},${y(p[a.key])} `;
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

  const tooltip = document.getElementById("lineTooltip");
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
    tooltip.style.left = e.pageX + 12 + "px";
    tooltip.style.top = e.pageY + 12 + "px";
    tooltip.innerHTML =
      `${p.sample_date}<br>` + AIRLINES.map((a) => `${a.label}: ${p[a.key] != null ? "$" + p[a.key] : "-"}`).join("<br>");
  });
  hitArea.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
}

// ---------- Wiring ----------

function populateSelects() {
  const durationSelect = document.getElementById("durationSelect");
  const durationSelect2 = document.getElementById("durationSelect2");
  DURATIONS.forEach((n) => {
    [durationSelect, durationSelect2].forEach((sel) => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = `${n} nights`;
      sel.appendChild(opt);
    });
  });

  const departureSelect = document.getElementById("departureSelect");
  allDepartureDates().forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    departureSelect.appendChild(opt);
  });

  const legendEl = document.getElementById("tripLegend");
  legendEl.innerHTML = AIRLINES.map((a) => `<span><span class="swatch" style="background:${getVar(a.series)}"></span>${a.label}</span>`).join("");

  const tableHead = document.getElementById("historyTableHead");
  tableHead.innerHTML = `<tr><th>Date checked</th>${AIRLINES.map((a) => `<th>${a.label}</th>`).join("")}</tr>`;
}

async function init() {
  populateSelects();
  renderHeatmapLegend();

  await loadLatestSnapshot();
  renderHeatmap(Number(document.getElementById("durationSelect").value));

  document.getElementById("durationSelect").addEventListener("change", (e) => {
    renderHeatmap(Number(e.target.value));
  });

  const departureSelect = document.getElementById("departureSelect");
  const durationSelect2 = document.getElementById("durationSelect2");
  const refresh = () => {
    const dep = departureSelect.value;
    const ret = toISO(addDays(new Date(dep), Number(durationSelect2.value)));
    renderTotalsNow(dep, ret);
    renderHistory(dep, ret);
  };
  departureSelect.addEventListener("change", refresh);
  durationSelect2.addEventListener("change", refresh);
  refresh();
}

init();
