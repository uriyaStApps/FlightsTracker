const SUPABASE_URL = "https://pualpwrkztjzhgpaqudm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TFMMqLxLWHatd3lXYrUlTQ_aO7MvaQ9";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: "tlv_osl_prices" },
});

const TRIP_YEAR = 2027;
const MATRIX_START = new Date(Date.UTC(TRIP_YEAR, 4, 1)); // May 1
const MATRIX_END = new Date(Date.UTC(TRIP_YEAR, 5, 30)); // June 30
const DURATIONS = [10, 11, 12, 13, 14];

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function nightsBetween(dep, ret) {
  return Math.round((new Date(ret) - new Date(dep)) / 86400000);
}

function allDepartureDates() {
  const dates = [];
  let d = MATRIX_START;
  while (d <= MATRIX_END) {
    dates.push(toISO(d));
    d = addDays(d, 1);
  }
  return dates;
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

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function svgns(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

// ---------- Heatmap (latest snapshot, overview across all departure dates) ----------

let latestDayRows = []; // rows for the most recent sample_date, all durations

async function loadLatestSnapshot() {
  const { data: latestRows, error: latestErr } = await sb
    .from("price_samples")
    .select("sample_date")
    .order("sample_date", { ascending: false })
    .limit(1);

  if (latestErr || !latestRows || !latestRows.length) {
    document.getElementById("heatmapStatus").textContent =
      "No data yet -- the first daily fetch hasn't run, or hasn't been recorded yet.";
    return null;
  }

  const latestDate = latestRows[0].sample_date;
  const { data, error } = await sb
    .from("price_samples")
    .select("departure_date,return_date,query_status,lufthansa_price,sas_price")
    .eq("sample_date", latestDate);

  if (error) {
    document.getElementById("heatmapStatus").textContent = "Failed to load snapshot: " + error.message;
    return null;
  }

  latestDayRows = data;
  document.getElementById("heatmapStatus").textContent = `Snapshot from ${latestDate} (${data.length} date pairs checked that day).`;
  return latestDate;
}

function renderHeatmapLegend() {
  const el = document.getElementById("heatmapLegend");
  el.innerHTML = `
    <span><span class="swatch" style="background:${getVar("--seq-100")}"></span>Cheaper</span>
    <span><span class="swatch" style="background:${getVar("--seq-700")}"></span>More expensive</span>
    <span><span class="swatch" style="background:${getVar("--gridline")}"></span>No price shown that day</span>
  `;
}

function renderHeatmap(nights) {
  const dates = allDepartureDates();
  const cellW = 900 / dates.length;
  const cellH = 32;
  const rowGap = 4;
  const labelW = 78;
  const height = rowGap * 3 + cellH * 2;
  const width = labelW + dates.length * cellW;

  const svg = document.getElementById("heatmap");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const byDeparture = {};
  for (const row of latestDayRows) {
    if (nightsBetween(row.departure_date, row.return_date) !== nights) continue;
    byDeparture[row.departure_date] = row;
  }

  const prices = [];
  for (const dep of dates) {
    const row = byDeparture[dep];
    if (!row) continue;
    if (row.lufthansa_price != null) prices.push(row.lufthansa_price);
    if (row.sas_price != null) prices.push(row.sas_price);
  }
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 1;

  const tooltip = document.getElementById("heatmapTooltip");
  const rows = [
    { label: "Lufthansa", key: "lufthansa_price" },
    { label: "SAS", key: "sas_price" },
  ];

  rows.forEach((r, rIdx) => {
    const label = svgns("text");
    label.setAttribute("x", 0);
    label.setAttribute("y", rowGap * (rIdx + 1) + cellH * rIdx + cellH / 2 + 4);
    label.setAttribute("class", "heatmap-row-label");
    label.textContent = r.label;
    svg.appendChild(label);

    dates.forEach((dep, cIdx) => {
      const row = byDeparture[dep];
      const price = row ? row[r.key] : null;
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
        if (price != null) {
          tooltip.textContent = `${r.label} - ${dep}: $${price}`;
        } else if (!row) {
          tooltip.textContent = `${dep}: not checked yet`;
        } else {
          tooltip.textContent = `${r.label} - ${dep}: no price shown that day`;
        }
      });
      rect.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });

      svg.appendChild(rect);
    });
  });
}

// ---------- Line chart + table (one trip's full sampling history) ----------

async function renderTripHistory(departureDate, nights) {
  const returnDate = toISO(addDays(new Date(departureDate), nights));
  const statusEl = document.getElementById("lineStatus");
  statusEl.textContent = "Loading...";

  const { data, error } = await sb
    .from("price_samples")
    .select("sample_date,query_status,lufthansa_price,sas_price")
    .eq("departure_date", departureDate)
    .eq("return_date", returnDate)
    .order("sample_date", { ascending: true });

  if (error) {
    statusEl.textContent = "Failed to load: " + error.message;
    return;
  }
  if (!data.length) {
    statusEl.textContent = "No samples recorded yet for this trip.";
    document.getElementById("lineChart").innerHTML = "";
    document.getElementById("historyTableBody").innerHTML = "";
    return;
  }

  statusEl.textContent = `${data.length} daily samples from ${data[0].sample_date} to ${data[data.length - 1].sample_date}. Departing ${departureDate}, returning ${returnDate}.`;

  drawLineChart(data);
  renderHistoryTable(data);
}

function renderHistoryTable(rows) {
  const tbody = document.getElementById("historyTableBody");
  tbody.innerHTML = "";
  // most recent sample first, since that's what people actually check
  [...rows].reverse().forEach((row) => {
    const tr = document.createElement("tr");
    const lh = row.lufthansa_price != null ? `$${row.lufthansa_price}` : "-";
    const sk = row.sas_price != null ? `$${row.sas_price}` : "-";
    tr.innerHTML = `<td>${row.sample_date}</td><td>${lh}</td><td>${sk}</td>`;
    tbody.appendChild(tr);
  });
}

function drawLineChart(points) {
  const width = 900;
  const height = 320;
  const margin = { top: 16, right: 16, bottom: 28, left: 48 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = document.getElementById("lineChart");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const allPrices = points.flatMap((p) => [p.lufthansa_price, p.sas_price]).filter((v) => v != null);
  if (!allPrices.length) {
    const t = svgns("text");
    t.setAttribute("x", width / 2);
    t.setAttribute("y", height / 2);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "axis-label");
    t.textContent = "No Lufthansa/SAS price shown yet for this trip";
    svg.appendChild(t);
    return;
  }

  const minP = Math.min(...allPrices) * 0.95;
  const maxP = Math.max(...allPrices) * 1.05;

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

  function pathFor(key, color) {
    let d = "";
    let started = false;
    points.forEach((p, i) => {
      if (p[key] == null) {
        started = false;
        return;
      }
      const cmd = started ? "L" : "M";
      d += `${cmd}${x(i)},${y(p[key])} `;
      started = true;
    });
    const path = svgns("path");
    path.setAttribute("d", d.trim());
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", 2);
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
  }

  pathFor("lufthansa_price", getVar("--series-lufthansa"));
  pathFor("sas_price", getVar("--series-sas"));

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
    tooltip.innerHTML = `${p.sample_date}<br>Lufthansa: ${p.lufthansa_price != null ? "$" + p.lufthansa_price : "-"}<br>SAS: ${p.sas_price != null ? "$" + p.sas_price : "-"}`;
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
  const refresh = () => renderTripHistory(departureSelect.value, Number(durationSelect2.value));
  departureSelect.addEventListener("change", refresh);
  durationSelect2.addEventListener("change", refresh);
  refresh();
}

init();
