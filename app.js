// 농산물 도매가격 예보 화면. data.json 하나만 읽는다(내 PC 앱·공유 페이지 공용).
const ITEMS = ["배추", "무", "양파", "깐마늘", "건고추"];
const fmt = (v) => (v == null ? "-" : v.toLocaleString("ko-KR"));
const sign = (v) => (v == null ? "-" : `${v > 0 ? "▲" : v < 0 ? "▼" : ""}${Math.abs(v).toFixed(1)}%`);
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const $ = (id) => document.getElementById(id);

let DATA = null;
let current = localStorage.getItem("item") || "배추";
let rangeDays = 90;
const chart = echarts.init($("chart"));
window.addEventListener("resize", () => chart.resize());

async function load() {
  const r = await fetch(`data.json?t=${Date.now()}`);
  DATA = await r.json();
  $("origin").textContent = DATA.origin;
  $("generated").textContent = DATA.generated_at;
  $("model").textContent = DATA.model;
  if (!ITEMS.includes(current)) current = "배추";
  renderCards();
  renderItem();
  renderScore();
}

function renderCards() {
  $("cards").innerHTML = ITEMS.map((it) => {
    const c = DATA.items[it].card;
    const fresh = DATA.items[it].fresh ? "신선" : "저장";
    return `<div class="card ${it === current ? "on" : ""}" data-item="${it}">
      <div class="name">${it}<span class="tag">${fresh}</span></div>
      <div class="price">${fmt(c.last)} <small>원/kg</small></div>
      <div class="chg">${c.last_date.slice(5)} · 전일 <span class="${cls(c.d1)}">${sign(c.d1)}</span> · 전주 <span class="${cls(c.d7)}">${sign(c.d7)}</span></div>
      <div class="next">다음 거래일(${c.tomorrow_date.slice(5)}) 예측 <b>${fmt(c.tomorrow)}</b></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", () => {
      current = el.dataset.item;
      try { localStorage.setItem("item", current); } catch (e) {}
      renderCards();
      renderItem();
    })
  );
}

function pairs(d, p) {
  return d.map((x, i) => [x, p[i]]);
}

function renderItem() {
  const it = DATA.items[current];
  $("itemName").textContent = current;
  const s = it.series, f = it.forecast;
  const prov = DATA.provisional_from;
  const conf = [], provPts = [];
  s.d.forEach((d, i) => {
    if (d < prov) conf.push([d, s.p[i]]);
    else provPts.push([d, s.p[i]]);
  });
  const lastConf = conf[conf.length - 1];
  if (provPts.length) provPts.unshift(lastConf);
  const fcLine = [lastConf, ...pairs(f.d, f.q50)];
  const lo = pairs(f.d, f.q10);
  const width = f.d.map((d, i) => [d, f.q90[i] - f.q10[i]]);
  const ly = pairs(it.last_year.d, it.last_year.p).filter((x) => x[1] != null);
  const vol = pairs(s.d, s.v);
  const end = f.d[f.d.length - 1];
  const startVal = rangeDays ? new Date(new Date(end) - rangeDays * 864e5).toISOString().slice(0, 10) : s.d[0];

  chart.setOption({
    animation: false,
    grid: [{ left: 58, right: 16, top: 16, height: "62%" }, { left: 58, right: 16, top: "76%", height: "14%" }],
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
      formatter: (ps) => {
        const d = ps[0].axisValueLabel.slice(0, 10);
        const get = (n) => ps.find((p) => p.seriesName === n);
        const lines = [`<b>${d}</b>`];
        for (const [n, lab] of [["실제", "실제"], ["잠정", "잠정"], ["예측", "예측"], ["작년", "작년 같은 시기"], ["반입량", "반입량"]]) {
          const p = get(n);
          if (p && p.value[1] != null && !(n === "예측" && d === lastConf[0])) {
            lines.push(`${lab}: ${fmt(Math.round(p.value[1]))}${n === "반입량" ? " t" : " 원/kg"}`);
          }
        }
        const i = f.d.indexOf(d);
        if (i >= 0) lines.push(`예측 범위: ${fmt(f.q10[i])} ~ ${fmt(f.q90[i])}`);
        return lines.join("<br>");
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      { type: "time", gridIndex: 0, axisLabel: { show: false }, splitLine: { show: false } },
      { type: "time", gridIndex: 1, axisLabel: { color: "#7a8a99", fontSize: 11 } },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, axisLabel: { color: "#7a8a99", fontSize: 11 }, splitLine: { lineStyle: { color: "#eef1f4" } } },
      { type: "value", gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], startValue: startVal, endValue: end },
    ],
    series: [
      { name: "작년", type: "line", data: ly, showSymbol: false, lineStyle: { color: "#a9b4bf", width: 1.3, type: "dashed" }, z: 1 },
      { name: "범위하한", type: "line", data: lo, stack: "band", showSymbol: false, lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { name: "범위", type: "line", data: width, stack: "band", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: "#fbe3cb", opacity: 0.9 }, tooltip: { show: false } },
      { name: "실제", type: "line", data: conf, showSymbol: false, lineStyle: { color: "#1d2a36", width: 2 }, z: 3 },
      { name: "잠정", type: "line", data: provPts, symbolSize: 5, lineStyle: { color: "#8a97a4", width: 2, type: "dotted" }, itemStyle: { color: "#8a97a4" }, z: 3 },
      { name: "예측", type: "line", data: fcLine, showSymbol: false, lineStyle: { color: "#D9822B", width: 2.4, type: "dashed" }, z: 4,
        markLine: { symbol: "none", silent: true, label: { formatter: "예측 기준일", color: "#7a8a99", fontSize: 10.5 },
          lineStyle: { color: "#9aa7b3", type: "dashed" }, data: [{ xAxis: lastConf[0] }] } },
      { name: "반입량", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: vol, itemStyle: { color: "#d7e3ec" }, barMaxWidth: 6 },
    ],
  }, true);
  renderSide(it);
}

function renderSide(it) {
  const c = it.card;
  const width = c.t90 && c.t10 && c.tomorrow ? (c.t90 - c.t10) / c.tomorrow : null;
  const sunBox = (s) => {
    const diff = s.ly ? ((s.q50 / s.ly - 1) * 100) : null;
    return `<div class="box"><div class="k">${s.k}순 후 · ${s.label} 평균</div>
      <div class="v">${fmt(s.q50)} <small>원/kg</small></div>
      <div class="r">범위 ${fmt(s.q10)} ~ ${fmt(s.q90)}</div>
      <div class="r ${cls(diff)}">${diff == null ? "작년 자료 없음" : `작년 같은 순 대비 ${sign(diff)}`}</div></div>`;
  };
  let warn = "";
  if (width != null && width > 0.35) {
    warn = `<div class="box warn"><b>불확실성 높음</b> — 내일 예측 범위가 예측값의 ${Math.round(width * 100)}%로 넓어요. 참고용으로만 보세요.</div>`;
  }
  $("side").innerHTML = `
    <div class="box"><div class="k">다음 거래일(${c.tomorrow_date.slice(5)}) 예측</div>
      <div class="v">${fmt(c.tomorrow)} <small>원/kg</small></div>
      <div class="r">범위 ${fmt(c.t10)} ~ ${fmt(c.t90)}</div></div>
    ${it.sun.map(sunBox).join("")}${warn}`;
}

function renderScore() {
  const bt = DATA.backtest;
  if (bt) {
    $("btMeta").textContent = `(기준일 ${bt.n_origins}개, ${bt.from} ~ ${bt.to})`;
    const cols = ["1~3일", "4~10일", "2·3순", "all"];
    const best = Object.fromEntries(cols.map((k) => [k, Math.min(...bt.rows.map((r) => r[k]))]));
    $("btTable").innerHTML = `<tr><th>방법</th><th>1~3일</th><th>4~10일</th><th>2·3순</th><th>전체</th></tr>` +
      bt.rows.map((r) => `<tr><td>${r.model}</td>${cols.map((k) => `<td class="${r[k] === best[k] ? "best" : ""}">${r[k].toFixed(1)}%</td>`).join("")}</tr>`).join("");
  }
  const sb = DATA.scoreboard;
  if (!sb || !sb.n) {
    $("liveMeta").textContent = "";
    $("live").innerHTML = `<div class="empty">예측 기록이 쌓이는 중이에요. 예측한 날의 가격이 정산되면(약 3일 뒤) 여기에 채점 결과가 나타나요.</div>`;
    return;
  }
  $("liveMeta").textContent = `(채점 ${sb.n}건 · 평균 오차 ${sb.mape}% · 범위 적중 ${sb.hit}%)`;
  $("live").innerHTML = `<table><tr><th>품목</th><th>대상일</th><th>예측</th><th>실제</th><th>오차</th></tr>` +
    sb.recent.slice(0, 12).map((r) => `<tr><td>${r.item}</td><td>${r.target.slice(5)}</td><td>${fmt(r.pred)}</td><td>${fmt(r.actual)}</td><td>${r.err}%${r.hit ? "" : " *"}</td></tr>`).join("") +
    `</table><p class="note">* 실제값이 예측 범위(10~90%) 밖이었던 경우</p>`;
}

document.querySelectorAll("#range button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#range button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    rangeDays = +b.dataset.days;
    renderItem();
  })
);

// 내 PC 앱(FastAPI)에서만 버튼이 보인다. 공유 페이지에는 /api 가 없으므로 숨김 유지.
async function detectLocal() {
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    if (!r.ok) return;
    $("local").hidden = false;
    showStatus(await r.json());
  } catch (e) { /* 공유 페이지 */ }
}
function showStatus(st) {
  $("btnRefresh").disabled = st.running;
  $("status").textContent = st.running ? "수집·예측 중… (1~3분)" : st.last ? `마지막 실행 ${st.last}${st.ok === false ? " (실패)" : ""}` : "";
}
$("btnRefresh").addEventListener("click", async () => {
  await fetch("api/refresh", { method: "POST" });
  const poll = setInterval(async () => {
    const st = await (await fetch("api/status", { cache: "no-store" })).json();
    showStatus(st);
    if (!st.running) { clearInterval(poll); load(); }
  }, 3000);
  showStatus({ running: true });
});

load().then(detectLocal);
setInterval(load, 30 * 60 * 1000); // 30분마다 새 데이터 확인
