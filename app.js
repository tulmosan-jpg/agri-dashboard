// 농산물 도매가격 예보 화면. data.json 하나만 읽는다(내 PC 앱·공유 페이지 공용).
// 화면 구성은 예선 03 화면과 같은 순서: 머리 → 조회 조건 → 품목 탭 → 앞으로의 가격 → 그래프 → 불확실성 알림 → 왜 이렇게 예측했나요? → 성적표 → 면책.
// 색은 모두 style.css의 :root 토큰에서 읽고, 화면 밝기가 바뀌면 그래프를 다시 그린다.
"use strict";

const ITEMS = ["배추", "무", "양파", "깐마늘", "건고추"];
const GROUPS = [
  { fresh: true, name: "신선 채소", desc: "날씨에 따라 값이 크게 흔들려요" },
  { fresh: false, name: "저장 품목", desc: "저장 물량과 수입에 따라 비교적 천천히 움직여요" },
];
const GRADES = ["좁음", "보통", "넓음"];
// [긴 이름, 설명, 좁은 화면용 짧은 이름]. 하이픈은 줄바꿈 없는 하이픈(U+2011)
const MODEL_NAMES = {
  "최근 가격 유지": ["마지막 확정 가격 그대로", "단순 비교", "확정가 유지"],
  "최근 7일 평균": ["최근 7일 평균", "단순 비교", "7일 평균"],
  "LightGBM": ["LightGBM", "다른 AI 모형", "LightGBM"],
  "Chronos-2": ["Chronos‑2", "이 화면의 AI", "Chronos‑2"],
};
// 추석(달력 날짜). 작년 선은 364일 뒤로 옮겨 그리므로 작년 추석도 같은 만큼 옮긴다.
const CHUSEOK = { 2019: "2019-09-13", 2020: "2020-10-01", 2021: "2021-09-21", 2022: "2022-09-10", 2023: "2023-09-29", 2024: "2024-09-17", 2025: "2025-10-06", 2026: "2026-09-25", 2027: "2027-09-15" };
// 설날(달력 날짜). '명절까지 남은 날' 카드에만 쓴다
const SEOLLAL = { 2026: "2026-02-17", 2027: "2027-02-07" };
const LY_SHIFT = 364;

const DAY = 864e5;
const WD = "일월화수목금토";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v == null || !isFinite(v) ? "–" : Math.round(v).toLocaleString("ko-KR"));
const fmtT = (v) => (v == null || !isFinite(v) ? "–" : v > 0 && v < 10 ? v.toFixed(1) : fmt(v)); // 반입량(t): 건고추처럼 작은 값은 소수 한 자리
const ts = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const ds = (ms) => { const t = new Date(ms + 12 * 3600e3); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const addDays = (s, n) => ds(ts(s) + n * DAY);
const wd = (s) => WD[new Date(ts(s)).getDay()];
const isSun = (s) => new Date(ts(s)).getDay() === 0;
const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
const mdw = (s) => `${md(s)}(${wd(s)})`;
const longD = (s) => `${+s.slice(5, 7)}월 ${+s.slice(8, 10)}일(${wd(s)})`;
const monthDay = (s) => `${+s.slice(5, 7)}월 ${+s.slice(8, 10)}일`;
const dotD = (s) => `${s.slice(0, 4)}. ${+s.slice(5, 7)}. ${+s.slice(8, 10)}.(${wd(s)})`;
const median = (a) => { const b = a.filter((x) => isFinite(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const pct1 = (v) => Math.abs(v).toFixed(1);
// 받침 있으면 a(은·과·이), 없으면 b(는·와·가)
const josa = (w, a, b) => {
  const s = String(w).replace(/[^가-힣]+$/, "");
  const c = s.charCodeAt(s.length - 1);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return a;
  return (c - 0xac00) % 28 ? a : b;
};
// '으로/로': 받침이 없거나 ㄹ받침이면 '로'
const josaRo = (w) => {
  const c = String(w).charCodeAt(String(w).length - 1);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return "로";
  const j = (c - 0xac00) % 28;
  return j === 0 || j === 8 ? "로" : "으로";
};
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 불가(사생활 보호 창 등) */ } },
};

let DATA = null;
let MC = new Map(); // 품목별 모형 계산 결과(자료를 새로 받으면 비운다)
let current = store.get("item") || "배추";
// 03 화면처럼 '최근 실제 + 앞으로의 예측'이 크게 보이게 6주로 시작한다(고른 기간은 품목을 바꿔도 유지)
let rangeDays = 42;
let tableShown = false;
let chart = null;
let kbIdx = null;
let lastLayoutKey = "";
let pollTimer = null;
let isLocal = false;
let serverName = ""; // data.json 응답의 server 머리글(내 PC 앱은 uvicorn)
const coarse = window.matchMedia("(pointer: coarse)").matches;

// ── 방향 표시: 오름 빨강▲, 내림 파랑▼(방향만 뜻한다) ─────────────────
function dirHtml(v, digits = 1) {
  if (v == null || !isFinite(v)) return `<span class="flat">–</span>`;
  const abs = Math.abs(v).toFixed(digits);
  if (+abs === 0) return `<span class="flat">0%</span>`;
  if (v > 0) return `<span class="up"><span class="sr">오름 </span><span aria-hidden="true">▲ </span>${abs}%</span>`;
  return `<span class="down"><span class="sr">내림 </span><span aria-hidden="true">▼ </span>${abs}%</span>`;
}
const dirWord = (v) => (v > 0 ? "오름" : v < 0 ? "내림" : "같음");

// ── 휴장일: 일요일 + 추석 당일·다음 날(자료가 없는 날만). 전날은 이미 지났고 자료가 없을 때만 ──
function closedSet(series) {
  const have = new Set(series.d.filter((d, i) => series.p[i] != null));
  const s = new Set();
  for (const c of Object.values(CHUSEOK)) {
    for (const off of [-1, 0, 1]) {
      const d = addDays(c, off);
      if (have.has(d)) continue;
      if (off === -1 && (!DATA.today || d > DATA.today)) continue;
      s.add(d);
    }
  }
  return s;
}
function holidayName(d) {
  for (const c of Object.values(CHUSEOK)) {
    if (d === c) return "추석";
    if (d === addDays(c, -1)) return "추석 전날";
    if (d === addDays(c, 1)) return "추석 다음 날";
  }
  return "";
}

// ── 품목별 모형(계산해 두는 값) ─────────────────────────
function model(name) {
  if (MC.has(name)) return MC.get(name);
  const it = DATA.items[name];
  const s = it.series, f = it.forecast, c = it.card;
  const prov = DATA.provisional_from;
  const conf = [], provPts = [];
  s.d.forEach((d, i) => {
    if (s.p[i] == null) return;
    const row = { d, t: ts(d), p: s.p[i], v: s.v[i] };
    (prov && d >= prov ? provPts : conf).push(row);
  });
  const last = conf[conf.length - 1];
  const closed = closedSet(s);
  const fcAll = f.d.map((d, i) => ({ d, t: ts(d), q10: f.q10[i], q50: f.q50[i], q90: f.q90[i] })).filter((x) => x.q50 != null);
  const fcByDate = new Map(fcAll.map((x) => [x.d, x]));
  const fcDays = fcAll.filter((x) => !isSun(x.d) && !closed.has(x.d)); // 경매 없는 날은 그리지 않는다
  const tmr = c.tomorrow_date || (fcDays.find((x) => x.d > DATA.today) || {}).d;
  const upcoming = fcDays.filter((x) => tmr && x.d >= tmr); // 이미 지난 날짜는 요약·표에서 뺀다
  // 작년 같은 때: 작년 그날(364일 전, 요일 맞춤)에 실제로 거래가 있던 날만 쓴다.
  // 방어: data.json이 휴장일을 앞 값으로 채운 옛 방식이어도, 작년 그날 거래 기록이 없으면 버린다. 중복 날짜도 한 번만.
  const actMap = new Map();
  s.d.forEach((d, i) => { if (s.p[i] != null) actMap.set(d, s.p[i]); });
  const lyDates = new Set(), ly = [];
  it.last_year.d.forEach((d, i) => {
    if (lyDates.has(d)) return;
    lyDates.add(d);
    const p = it.last_year.p[i];
    const d0 = addDays(d, -LY_SHIFT);
    const covered = s.d.length && d0 >= s.d[0];
    if (p != null && (!covered || actMap.has(d0))) ly.push({ d, t: ts(d), p });
  });
  const lyMap = new Map(ly.map((x) => [x.d, x.p]));
  // 작년 같은 순 평균도 거래가 있던 날만으로(자료가 있으면 다시 계산)
  const lySeg = (a, b) => {
    const v = [];
    for (let d = addDays(a, -LY_SHIFT), e = addDays(b, -LY_SHIFT); d <= e; d = addDays(d, 1)) if (actMap.has(d)) v.push(actMap.get(d));
    return v.length ? Math.round(v.reduce((u, x) => u + x, 0) / v.length) : null;
  };
  const sun = (it.sun || []).filter((x) => x.q50 != null).map((x, i) => ({
    ...x, k: x.k || i + 2,
    ly: s.d.length && addDays(x.start, -LY_SHIFT) >= s.d[0] ? lySeg(x.start, x.end) : x.ly,
    t0: ts(x.start), t1: ts(x.end) + DAY - 1,
    short: x.label.replace(/^\d+월\s*/, ""),
    range: `${md(x.start)}~${md(x.end)}`,
  }));

  // 예측 범위 등급: w = (90% 값 − 10% 값) / 가운데 값. 좁음 < 15%, 보통 15~35%, 넓음 > 35% (임시 기준)
  const w = c.t90 != null && c.t10 != null && c.tomorrow ? (c.t90 - c.t10) / c.tomorrow : null;
  const g = w == null ? null : w < 0.15 ? 0 : w <= 0.35 ? 1 : 2;
  // 자료 이상 점검: 최근 10거래일의 하루 변동(중간값)이 크고 범위 폭의 절반보다 크면 '자료 점검 중'(등급과 별도 상태)
  const recent = conf.slice(-11).map((x) => x.p);
  const swing = median(recent.slice(1).map((p, i) => Math.abs(p / recent[i] - 1)));
  const jumpy = w != null && swing != null && swing >= 0.15 && swing > w / 2;

  // 잠정 값 점검: 반입량이 최근 30일 중간값의 절반 미만, 그날 예측 범위 밖, 또는 확정가와 25% 이상 차이
  const vMed = median(conf.filter((x) => x.d >= addDays(last.d, -30)).map((x) => x.v));
  // 오름·내림 비교 기준(ref): 마지막 확정일의 반입량이 평소(최근 30일 중간값)의 절반도 안 되면(명절 전날 소량 거래 등)
  // 그날 값은 평소 시세와 달라 방향을 거꾸로 보여 줄 수 있다 → 반입량이 평소의 절반 이상인 가장 최근 확정일(14일 안)과 비교한다.
  // 그런 날이 없으면 기준은 그대로 두고 방향 색·동사를 빼고 '소량 거래일 기준'으로 적는다(refWeak).
  const lastLow = !!(vMed && last && last.v != null && isFinite(last.v) && last.v < vMed / 2);
  let ref = last;
  if (lastLow) {
    for (let i = conf.length - 2; i >= 0 && conf[i].d >= addDays(last.d, -14); i--) {
      if (conf[i].v != null && conf[i].v >= vMed / 2) { ref = conf[i]; break; }
    }
  }
  const refSkip = lastLow && ref !== last;
  const refWeak = lastLow && ref === last;
  const skipped = refSkip ? conf.filter((x) => x.d > ref.d) : []; // 비교에서 뺀 확정일(마지막 날 포함)
  const lowVol = provPts.filter((x) => vMed && x.v != null && x.v < vMed / 2);
  const provOdd = provPts.map((x) => {
    const fx = fcByDate.get(x.d);
    const outside = !!fx && (x.p < fx.q10 || x.p > fx.q90);
    const chg = (x.p / ref.p - 1) * 100;
    const low = lowVol.includes(x);
    return outside || Math.abs(chg) >= 25 || low ? { ...x, outside, chg, low, hol: holidayName(x.d) } : null;
  }).filter(Boolean);

  // 표·툴팁용 날짜별 값
  const byDate = new Map();
  const put = (d, k, v) => { if (!byDate.has(d)) byDate.set(d, { d }); byDate.get(d)[k] = v; };
  conf.forEach((x) => { put(x.d, "act", x.p); put(x.d, "vol", x.v); });
  provPts.forEach((x) => { put(x.d, "prov", x.p); put(x.d, "vol", x.v); });
  fcDays.forEach((x) => { put(x.d, "fc", x); });

  const xMin = conf.length ? conf[0].t : fcDays[0].t;
  const ends = [last ? last.t : 0, fcDays.length ? fcDays[fcDays.length - 1].t : 0, ...sun.map((x) => x.t1)];
  const xMax = Math.max(...ends) + DAY / 2;

  const M = { name, it, c, conf, provPts, last, ref, lastLow, refSkip, refWeak, skipped, closed, fcAll, fcDays, upcoming, tmr, ly, lyMap, lyDates, sun, w, g, swing, jumpy, lowVol, provOdd, vMed, byDate, xMin, xMax };
  MC.set(name, M);
  return M;
}
const allModels = () => ITEMS.filter((x) => DATA.items[x]).map(model);

// 비교에서 뺀 소량 거래일: '9/24(추석 전날)' 또는 '9/21~9/23'
function skipDays(M) {
  const s = M.skipped;
  if (!s.length) return "";
  if (s.length === 1) { const h = holidayName(s[0].d); return `${md(s[0].d)}${h ? `(${h})` : ""}`; }
  return `${md(s[0].d)}~${md(s[s.length - 1].d)}`;
}
// '9/24(추석 전날)은 반입량이 평소의 26%뿐이라 비교에서 뺐어요'
function skipNote(M) {
  const pctOf = (v) => Math.round((v / M.vMed) * 100);
  if (M.refSkip) {
    const w = skipDays(M);
    const why = M.skipped.length === 1 ? `반입량이 평소의 ${pctOf(M.last.v)}%뿐이라` : "반입량이 평소의 절반도 안 돼";
    return `${w}${josa(w, "은", "는")} ${why} 비교에서 뺐어요`;
  }
  if (M.refWeak) return `${md(M.last.d)}은 반입량이 평소의 ${pctOf(M.last.v)}%뿐인 날이라 방향은 참고만 하세요`;
  return "";
}

// 작년 그날 거래가 없었던 까닭(툴팁·표 문구). 일요일은 올해도 휴장이라 따로 쓰지 않는다
function lyClosedNote(M, d) {
  if (M.lyMap.has(d) || !M.lyDates.has(d) || isSun(d)) return "";
  const d0 = ts(addDays(d, -LY_SHIFT));
  const nearChuseok = Object.values(CHUSEOK).some((c) => Math.abs(ts(c) - d0) <= 4 * DAY);
  return nearChuseok ? "작년 이날은 추석 연휴라 거래가 없었어요." : "작년 이날은 휴장이라 거래가 없었어요.";
}

// ── 불러오기 ────────────────────────────────────────
async function load() {
  let data;
  try {
    const r = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    serverName = r.headers.get("server") || "";
    data = await r.json();
  } catch (e) {
    if (!DATA) $("tabs").innerHTML = `<p class="loading">자료를 불러오지 못했어요. 잠시 뒤 새로고침해 보세요.</p>`;
    return;
  }
  // 다시 그리기 전에 키보드 위치를 기억해 두고, 그린 뒤 되돌린다
  const ae = document.activeElement;
  const focusItem = ae && ae.classList && ae.classList.contains("tab") ? ae.dataset.item : null;
  const focusTable = ae && $("tableView").contains(ae);

  DATA = data;
  MC = new Map();
  if (!ITEMS.includes(current) || !DATA.items[current]) current = ITEMS.find((x) => DATA.items[x]) || ITEMS[0];
  renderHeader();
  renderTabs();
  renderDetail();
  renderScore();
  renderFooter();

  if (focusItem) { const el = document.querySelector(`.tab[data-item="${CSS.escape(focusItem)}"]`); if (el) el.focus(); }
  if (focusTable) { const el = $("tableView").querySelector(".table-scroll"); if (el) el.focus(); }
}

function parseStamp(s) { // "2026-09-26 22:42"
  if (!s) return null;
  const [d, t = "00:00"] = s.split(" ");
  const [h, m] = t.split(":").map(Number);
  return ts(d) + (h * 60 + m) * 60e3;
}
const stampText = (s) => (s ? `${monthDay(s)} ${s.slice(11, 16)}` : "–");

function sunLabels() {
  const any = DATA.items[current] || Object.values(DATA.items)[0];
  const ls = (any && any.sun ? any.sun : []).map((x) => x.label);
  if (!ls.length) return "";
  const month = (l) => (l.match(/^\d+월/) || [""])[0];
  return ls.map((l, i) => (i && month(l) === month(ls[i - 1]) ? l.replace(/^\d+월\s*/, "") : l)).join("·");
}
function mostCommon(arr) {
  const m = new Map(); arr.forEach((x) => x && m.set(x, (m.get(x) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ── 머리 + 조회 조건 ─────────────────────────────────
const ICON_INFO = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10.5v6.5M12 7v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
function renderHeader() {
  const models = allModels();
  $("origin").textContent = DATA.origin ? dotD(DATA.origin) : "–";
  $("generated").textContent = stampText(DATA.generated_at);
  const sl = sunLabels();
  $("sub").textContent = `앞으로 10일과 2·3순 뒤${sl ? `(${sl})` : ""} 도매가격을 미리 알려 드려요`;
  $("lgSun").textContent = sl ? `${sl} 열흘 평균` : "열흘 평균 예측";
  // 대상 기간: 다음 거래일 ~ 마지막 예측일(날짜별), 2·3순 열흘 평균
  const tmrD = mostCommon(models.map((m) => m.tmr));
  const endD = mostCommon(models.map((m) => (m.upcoming.length ? m.upcoming[m.upcoming.length - 1].d : null)));
  $("period").textContent = tmrD && endD ? `${md(tmrD)} ~ ${md(endD)} 날짜별` : "–";
  $("periodSun").textContent = sl ? `${sl} 열흘 평균` : "";
  // 잠정 가격이 실제로 있을 때만 한 줄 설명
  const prov = DATA.provisional_from;
  const anyProv = prov && models.some((m) => m.provPts.length);
  $("basis").hidden = !anyProv;
  if (anyProv) $("basis").textContent = `${md(prov)}부터는 아직 최종 집계 전인 잠정 가격이에요(보통 3일 안에 확정돼요). 예측에는 ${md(DATA.origin)}까지 확정된 가격만 썼어요.`;
  const g = parseStamp(DATA.generated_at);
  const stale = g && Date.now() - g > 36 * 3600e3;
  $("stale").hidden = !stale;
  if (stale) {
    const msg = isLocal
      ? "자료가 하루 넘게 지났어요. 「최신 가격 받고 다시 예측」을 눌러 주세요."
      : `${stampText(DATA.generated_at)} 자료예요. 그 뒤 가격은 아직 반영되지 않았어요.`;
    $("stale").innerHTML = `${ICON_INFO}<span>${esc(msg)}</span>`;
  }
}

// ── ① 품목 탭 ─────────────────────────────────────────
function renderTabs() {
  const models = allModels();
  const tmrD = mostCommon(models.map((m) => m.tmr));
  $("tabsDate").textContent = tmrD ? ` ${mdw(tmrD)}` : "";
  $("tabs").innerHTML = models.map((m) => {
    const c = m.c;
    const on = m.name === current;
    const r = c.tomorrow != null && m.ref ? (c.tomorrow / m.ref.p - 1) * 100 : null;
    const label = [
      `${m.name}.`,
      `${m.tmr ? longD(m.tmr) : "다음 거래일"} 예측 ${fmt(c.tomorrow)}원.`,
      m.jumpy ? "자료 점검 중이라 참고용이에요." : r != null ? `${longD(m.ref.d)} 확정 경락가 ${fmt(m.ref.p)}원보다 ${pct1(r)}% ${m.refWeak ? (r > 0 ? "높음" : r < 0 ? "낮음" : "같음") : dirWord(r)}.` : "",
      !m.jumpy && (m.refSkip || m.refWeak) ? `${skipNote(m)}.` : "",
      `예측 범위 ${fmt(c.t10)}~${fmt(c.t90)}원.`,
    ].filter(Boolean).join(" ");
    // 소량 거래일밖에 비교할 날이 없으면(refWeak) 방향 색·화살표 없이 숫자만
    const chg = m.jumpy ? `<span class="t-note">자료 점검 중</span>`
      : m.refWeak ? `<span class="t-note">${r == null ? "–" : `${r > 0 ? "+" : r < 0 ? "−" : ""}${pct1(r)}% · 참고`}</span>`
      : `<span class="t-chg">${dirHtml(r)}</span>`;
    return `<button type="button" class="tab${m.jumpy ? " jumpy" : ""}" data-item="${esc(m.name)}" aria-pressed="${on}" aria-label="${esc(label)}">
      <span class="t-name">${esc(m.name)}</span>
      <span class="t-price">${fmt(c.tomorrow)}원</span>
      ${chg}
      ${m.tmr && m.tmr !== tmrD ? `<span class="t-date">${esc(mdw(m.tmr))}</span>` : ""}
    </button>`;
  }).join("");
  // 비교 기준을 바꾼 품목이 있으면 탭 아래에 한 줄로 밝힌다: '배추·무·양파는 9/24(추석 전날) 반입량이 … 9/23 값과 비교했어요.'
  const grp = new Map();
  models.filter((m) => !m.jumpy && (m.refSkip || m.refWeak)).forEach((m) => {
    const k = m.refSkip ? `s|${skipDays(m)}|${m.ref.d}` : `w|${m.last.d}`;
    if (!grp.has(k)) grp.set(k, []);
    grp.get(k).push(m);
  });
  const lines = [...grp.values()].map((ms) => {
    const m = ms[0], names = ms.map((x) => x.name).join("·");
    const who = `${names}${josa(names, "은", "는")}`;
    if (m.refWeak) return `${who} ${md(m.last.d)} 거래가 평소보다 아주 적었지만 비교할 다른 날이 없어 이날 값과 견줬어요(참고만 하세요).`;
    const w = skipDays(m);
    return `${who} ${w} 반입량이 평소의 절반도 안 돼 그 전 ${md(m.ref.d)} 확정 가격과 비교했어요.`;
  });
  $("tabsRef").hidden = !lines.length;
  $("tabsRef").textContent = lines.join(" ");
  // 마우스·터치(detail > 0)로 고르면 바뀐 가격 상자로 스크롤, 키보드로 고르면 초점을 그대로 두고 소리로만 알린다
  $("tabs").querySelectorAll(".tab").forEach((el) => el.addEventListener("click", (e) => selectItem(el.dataset.item, e.detail > 0 ? "pointer" : "key")));
}

function selectItem(name, how) {
  if (!DATA.items[name]) return;
  current = name;
  store.set("item", current);
  document.querySelectorAll(".tab").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.item === current)));
  kbIdx = null;
  const M = renderDetail();
  // 좁은 화면 + 마우스·터치: 바뀐 「앞으로의 가격」이 화면 밖이면 그쪽으로 옮긴다
  if (how === "pointer" && window.matchMedia("(max-width: 959px)").matches) {
    const box = $("future");
    const top = box.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) box.scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
  }
  if (how === "key" && M) {
    const grade = M.jumpy ? "자료 점검 중" : M.g == null ? "" : `범위 ${GRADES[M.g]}`;
    $("boardLive").textContent = `${M.name}${josaRo(M.name)} 바꿨어요. ${M.tmr ? md(M.tmr) : "다음 거래일"} 예측 ${fmt(M.c.tomorrow)}원${grade ? `, ${grade}` : ""}.`;
  }
}

// ── 상세: ③ 앞으로의 가격, ② 그래프, ⑤ 알림, ④ 설명 ─────────────
function renderDetail() {
  const M = model(current);
  document.querySelectorAll(".js-item").forEach((el) => { el.textContent = current; });
  renderFuture(M);
  renderAlert(M);
  renderWhy(M);
  renderNotes(M);
  if (tableShown) renderTable(M);
  else renderChart(M);
  return M;
}

const halfPct = (M) => Math.round((M.w || 0) * 50);
function gradeSentence(M) {
  if (M.w == null) return "";
  if (M.g === 1) return `가운데 값에서 위아래로 약 ${halfPct(M)}% 안에서 오르내릴 수 있어요.`;
  if (M.g === 0) return `범위가 좁은 편이에요. 가운데 값에서 위아래로 약 ${halfPct(M)}% 안이에요.`;
  return "";
}

// 확정 경락가 대비(기준 = M.ref: 소량 거래일은 건너뛴 가장 최근 확정일). 자료 점검 중·소량 거래일 기준이면 색·화살표 없이 '참고용'
function vsConf(M, v, full) {
  const r = (v / M.ref.p - 1) * 100;
  const a = Math.round(Math.abs(r));
  const base = full ? `${md(M.ref.d)} 확정 ${fmt(M.ref.p)}원` : "확정 경락가";
  const why = full && (M.refSkip || M.refWeak) ? `<span class="vsc-note">${esc(skipNote(M))}.</span>` : "";
  if (a < 1) return `${base}${josa(base, "과", "와")} 거의 같게 봐요${M.jumpy || M.refWeak ? "(참고용)" : ""}${why}`;
  if (M.jumpy || M.refWeak) return `${base}보다 ${a}% ${r > 0 ? "높게" : "낮게"} 나왔지만 참고용이에요${why}`;
  const cls = r > 0 ? "up" : "down";
  return `${base}보다 <span class="${cls}"><span aria-hidden="true">${r > 0 ? "▲ " : "▼ "}</span>${a}% ${r > 0 ? "높게" : "낮게"}</span> 봐요${why}`;
}
// 작년 같은 순 대비(03 화면처럼 방향 색). 자료 점검 중이면 색 없이 참고용
function vsLyHtml(M, v, ly) {
  if (ly == null || v == null) return `<span class="muted">작년 같은 순 자료가 없어요</span>`;
  const r = (v / ly - 1) * 100, a = Math.round(Math.abs(r));
  const base = `작년 같은 순(${fmt(ly)}원)`;
  if (a < 1) return `<span class="muted">${base}과 비슷해요</span>`;
  if (M.jumpy) return `<span class="muted">${base}보다 ${a}% ${r > 0 ? "높지만" : "낮지만"} 참고용이에요</span>`;
  return `${base}보다 <span class="${r > 0 ? "up" : "down"}"><span class="sr">${r > 0 ? "높게" : "낮게"} </span><span aria-hidden="true">${r > 0 ? "▲" : "▼"} </span>${a}%</span>`;
}
// 앞으로의 흐름 한 줄(가장 먼저 읽는 답). 자료 점검 중이면 방향을 말하지 않는다
function trendHtml(M) {
  if (M.jumpy) return `<p class="trend">${esc(M.name)}${josa(M.name, "은", "는")} 자료를 점검하는 중이라 방향을 말하기 어려워요.</p>`;
  const base = M.ref.p; // 소량 거래일은 건너뛴 기준(vsConf와 같음)
  const vals = [M.c.tomorrow, ...M.sun.map((s) => s.q50)].filter((v) => v != null && isFinite(v));
  if (!vals.length) return "";
  const far = M.sun[M.sun.length - 1];
  const path = far
    ? `${fmt(base)}원(${md(M.ref.d)} 확정) → ${M.tmr ? md(M.tmr) : "다음 거래일"} ${fmt(M.c.tomorrow)}원 → ${far.label} 평균 ${fmt(far.q50)}원`
    : `${fmt(base)}원(${md(M.ref.d)} 확정) → ${M.tmr ? md(M.tmr) : "다음 거래일"} ${fmt(M.c.tomorrow)}원`;
  // 비교할 날이 소량 거래일뿐이면 방향 동사를 쓰지 않는다
  if (M.refWeak) return `<p class="trend">최근 거래가 적어 오를지 내릴지 말하기 어려워요.<span class="path">${esc(path)}</span></p>`;
  const dirs = vals.map((v) => { const r = v / base - 1; return r >= 0.03 ? 1 : r <= -0.03 ? -1 : 0; });
  const up = dirs.includes(1), down = dirs.includes(-1);
  const verb = up && down ? "오르내릴" : up ? "오를" : down ? "내릴" : "지금과 비슷할";
  const until = far ? `${far.label.endsWith("하순") ? far.label.replace(/하순$/, "말") : far.label}까지는` : "앞으로 열흘은";
  return `<p class="trend">${esc(until)} ${verb} 것으로 봐요.<span class="path">${esc(path)}</span></p>`;
}

function renderFuture(M) {
  const c = M.c;
  const grp = GROUPS.find((g) => g.fresh === !!M.it.fresh);
  const dim = M.jumpy ? " dim" : "";
  const note = M.jumpy || M.g == null || M.g === 2 ? "" : `<p class="g-note">${esc(gradeSentence(M))}</p>`;
  const sunCard = (s) => `<div class="card sun">
      <p class="card-k2">${s.k}순 뒤 · 열흘 평균</p>
      <p class="card-p">${esc(s.label)} <span class="rg">(${esc(s.range)})</span></p>
      <p class="big${dim}"><span class="n">${fmt(s.q50)}</span><span class="u">원/kg</span></p>
      <div class="card-foot">
        <p class="rng-line${dim}">범위 ${fmt(s.q10)} ~ ${fmt(s.q90)}원${M.jumpy ? " · 참고용" : ""}</p>
        <p class="vly">${vsLyHtml(M, s.q50, s.ly)}</p>
      </div>
    </div>`;
  $("future").innerHTML = `
    <div class="sec-row"><h2 class="sec-h" id="futureTitle"><span>${esc(M.name)}</span> <span class="bar" aria-hidden="true">|</span> <span>앞으로의 가격 한눈에 보기</span></h2>${grp ? `<p class="grp">${esc(grp.name)} · ${esc(grp.desc)}</p>` : ""}</div>
    ${trendHtml(M)}
    <div class="cards">
      <div class="card main">
        <p class="card-k">다음 거래일 ${M.tmr ? esc(mdw(M.tmr)) : ""}</p>
        <p class="big hero${dim}"><span class="n">${fmt(c.tomorrow)}</span><span class="u">원/kg</span></p>
        <p class="vsc">${vsConf(M, c.tomorrow, true)}</p>
        <div class="card-foot">
          <p class="rng-k">${M.jumpy ? "예측 범위 · 자료 점검 중이라 참고용" : "예측 범위 · 10번 중 8번은 이 안에 들어요"}</p>
          <p class="rng-v${dim}">${fmt(c.t10)} ~ ${fmt(c.t90)}원</p>
          ${note}
        </div>
      </div>
      ${M.sun.map(sunCard).join("")}
    </div>`;
}

// ── ⑤ 불확실성 알림: 범위가 넓거나 자료 점검 중일 때만. 원인은 단정하지 않고 행동만 안내 ──
const ICON_WARN = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5L1.5 21h21L12 2.5z" fill="currentColor"/><path d="M11 9.5h2v5.5h-2zM11 17h2v2h-2z" fill="var(--bg)"/></svg>`;
function renderAlert(M) {
  const el = $("alert");
  const c = M.c;
  if (M.w == null || !(M.jumpy || M.g === 2)) { el.hidden = true; el.innerHTML = ""; return; }
  const day = M.tmr ? md(M.tmr) : "다음 거래일";
  let h, body;
  if (M.jumpy) {
    h = `${M.name}${josa(M.name, "은", "는")} 가격 자료를 점검하고 있어요`;
    body = `최근 가격이 하루는 높고 하루는 낮게 번갈아 나와요(하루 차이 약 ${Math.round(M.swing * 100)}%). 이 화면의 예측은 믿기 어려우니 <strong>거래 판단에는 쓰지 말고, 전주 대비와 작년 같은 때 값을 함께 보세요.</strong> 자료가 바로잡히면 예측도 다시 계산돼요.`;
  } else {
    h = `${M.name}${josa(M.name, "은", "는")} 예측 범위가 넓어요`;
    body = `${esc(day)} 가격은 10번 중 8번은 <span class="rng">${fmt(c.t10)} ~ ${fmt(c.t90)}원</span> 사이로 폭이 커요. 이보다 더 벗어날 수도 있어요. <strong>사거나 팔 양은 한 번에 정하지 말고 며칠에 나눠 정하세요.</strong> 예보는 새 가격이 들어오면 다시 계산돼요.`;
  }
  el.hidden = false;
  el.innerHTML = `${ICON_WARN}<div><p class="alert-h">${esc(h)}</p><p class="alert-b">${body}</p></div>`;
}

// ── ④ 왜 이렇게 예측했나요? 모두 data.json 값으로 계산하고, 계산할 수 없으면 그 카드는 뺀다 ──
// 예측 반영: 최근 가격 흐름(이 화면의 모형은 과거 가격만 본다)
function trendFacts(M) {
  const last = M.last;
  if (!last) return null;
  if (M.jumpy) {
    const rec = M.conf.slice(-10).map((x) => x.p);
    return {
      body: `최근 가격이 하루는 높고 하루는 낮게 번갈아 나와요(하루 차이 약 <b>${Math.round(M.swing * 100)}%</b>). 예측도 이 흐름을 따라가 믿기 어려워요.`,
      subs: [`최근 10거래일 ${fmt(Math.min(...rec))}~${fmt(Math.max(...rec))}원${M.c.d7 != null && (!M.c.last_date || M.c.last_date === last.d) ? ` · 전주보다 ${dirHtml(M.c.d7)}` : ""}`],
    };
  }
  // 30일 비교도 탭·가격 상자와 같은 기준(M.ref: 소량 거래일은 건너뛴 가장 최근 확정일)으로 끝낸다
  const end = M.ref;
  const from = addDays(end.d, -30);
  let base = null;
  for (let i = M.conf.length - 1; i >= 0; i--) if (M.conf[i].d <= from) { base = M.conf[i]; break; }
  if (!base) return null;
  const r = (end.p / base.p - 1) * 100, a = Math.round(Math.abs(r));
  const span = M.refSkip ? `${md(end.d)}까지 30일 동안` : "최근 30일 동안";
  const body = a < 3
    ? `${span} 큰 변화 없이 <b>${fmt(end.p)}원</b>이 됐어요`
    : `${span} ${a}% ${r > 0 ? "올라" : "내려"} <b>${fmt(end.p)}원</b>이 됐어요`;
  const chg = []; // 전일·전주 대비는 data.json 카드 값(마지막 확정일 기준): 카드 기준일이 마지막 확정일과 같고, 그날이 소량 거래일이 아닐 때만 쓴다
  const same = (!M.c.last_date || M.c.last_date === last.d) && !M.lastLow;
  if (same && M.c.d1 != null) chg.push(`<span class="nw">전일보다 ${dirHtml(M.c.d1)}</span>`);
  if (same && M.c.d7 != null) chg.push(`<span class="nw">전주보다 ${dirHtml(M.c.d7)}</span>`);
  const subs = [`${md(base.d)} ${fmt(base.p)}원 → ${md(end.d)} ${fmt(end.p)}원${chg.length ? ` · ${chg.join(" · ")}` : ""}`];
  if (M.lastLow && M.skipped.length > 1) {
    const w = skipDays(M);
    subs.push(`${esc(w)}${josa(w, "은", "는")} 반입량이 평소의 절반도 안 돼 이 며칠 값(마지막 ${md(last.d)} ${fmt(last.p)}원)은 평소 시세와 다를 수 있어요. 그래서 오름·내림 비교에서 뺐어요.`);
  } else if (M.lastLow) {
    const hol = holidayName(last.d);
    const tail = M.refSkip ? " 그래서 오름·내림 비교에서 뺐어요." : "";
    subs.push(`${md(last.d)}${hol ? `(${esc(hol)})` : ""}은 반입량이 평소의 ${Math.round((last.v / M.vMed) * 100)}%뿐이라 이날 값(${fmt(last.p)}원)은 평소 시세와 다를 수 있어요.${tail}`);
  }
  // 모형(scripts/build_data.py forecast_all)은 기준일까지의 확정 가격을 모두 입력으로 받는다. 화면에서 뺀 날도 모형에는 들어갔다는 사실을 밝힌다
  if (M.refSkip || M.refWeak) {
    const w = M.skipped.length > 1 ? skipDays(M) : md(last.d);
    const val = M.skipped.length > 1 ? `마지막 ${md(last.d)} ${fmt(last.p)}원` : `${fmt(last.p)}원`;
    subs.push(`예측 모형에는 ${esc(w)} 값(${val})까지 그대로 들어갔어요.${M.refSkip ? " 뺀 것은 이 화면의 ▲▼ 비교뿐이에요." : ""}`);
  }
  return { body, subs };
}
// 모형이 본 가격 기록 길이: 기준일까지 최대 2,048일(scripts/build_data.py forecast_all의 [-2048:]와 같게)
const CTX_DAYS = 2048;
function ctxSpan() {
  const any = DATA.items[current] || Object.values(DATA.items)[0];
  const d0 = any && any.series && any.series.d[0];
  if (!d0 || !DATA.origin) return "";
  const days = Math.min(CTX_DAYS, Math.round((ts(DATA.origin) - ts(d0)) / DAY) + 1);
  const yrs = days / 365.25;
  let y = Math.floor(yrs), mo = Math.round((yrs - y) * 12);
  if (mo === 12) { y += 1; mo = 0; }
  return y ? `${y}년${mo ? ` ${mo}개월` : ""}` : `${mo}개월`;
}
// 참고 카드(반입량·작년 가격)의 끝 날짜: 가격 카드·품목 탭과 같은 기준(M.ref)으로 맞춘다.
// 마지막 확정일이 소량 거래일이라 비교에서 뺐으면(refSkip) 그 전 확정일까지, 뺄 날이 없으면 마지막 확정일까지
const factEnd = (M) => (M.refSkip ? M.ref.d : M.last.d);
const recent7 = (M) => (M.refSkip ? `${md(factEnd(M))}까지 7일` : "최근 7일");
// 참고: 반입량 최근 7일 vs 그 전 7일(거래일 하루 평균, 확정 자료만)
function volFacts(M) {
  const end = factEnd(M);
  const pick = (a, b) => M.conf.filter((x) => x.d > a && x.d <= b && x.v != null && isFinite(x.v));
  const A = pick(addDays(end, -7), end), B = pick(addDays(end, -14), addDays(end, -7));
  if (A.length < 3 || B.length < 3) return null;
  const a = mean(A.map((x) => x.v)), b = mean(B.map((x) => x.v));
  if (!(b > 0)) return null;
  const r = (a / b - 1) * 100, k = Math.round(Math.abs(r));
  const span = recent7(M);
  const body = k < 3
    ? `${span} 하루 평균 <b>${fmtT(a)}t</b>, 그 전 7일(${fmtT(b)}t)과 비슷해요`
    : `${span} 하루 평균 <b>${fmtT(a)}t</b>, 그 전 7일(${fmtT(b)}t)보다 ${k}% ${r > 0 ? "많아요" : "적어요"}`;
  const hol = [];
  for (let d = addDays(end, -6); d <= end; d = addDays(d, 1)) { const h = holidayName(d); if (h) hol.push(h); }
  const subs = [`${md(A[0].d)}~${md(A[A.length - 1].d)} ${A.length}거래일 대 ${md(B[0].d)}~${md(B[B.length - 1].d)} ${B.length}거래일`];
  if (M.refSkip || M.refWeak) subs.push(`${esc(skipNote(M))}.`);
  if (hol.length) subs.push(`${span}에 ${esc(hol.join("·"))}${josa(hol[hol.length - 1], "이", "가")} 끼어 있어요.`);
  return { body, subs };
}
// 참고: 작년 같은 때 가격(작년 같은 요일, 거래가 있던 날끼리 최근 7일 평균)
function lyFacts(M) {
  const end = factEnd(M), from = addDays(end, -6);
  const pairs = M.conf.filter((x) => x.d >= from && x.d <= end && M.lyMap.has(x.d));
  if (pairs.length < 3) return null;
  const now = mean(pairs.map((x) => x.p)), ly = mean(pairs.map((x) => M.lyMap.get(x.d)));
  if (!(ly > 0)) return null;
  const r = (now / ly - 1) * 100, k = Math.round(Math.abs(r));
  const span = recent7(M);
  const body = k < 3
    ? `${span} 평균 <b>${fmt(now)}원</b>, 작년 같은 때(${fmt(ly)}원)와 비슷해요`
    : `${span} 평균 <b>${fmt(now)}원</b>, 작년 같은 때(${fmt(ly)}원)보다 ${k}% ${r > 0 ? "높아요" : "낮아요"}`;
  const subs = [`작년 같은 요일끼리 비교 (${md(pairs[0].d)}~${md(pairs[pairs.length - 1].d)}, ${pairs.length}거래일)`];
  if (M.refSkip || M.refWeak) subs.push(`${esc(skipNote(M))}.`);
  const t = M.tmr ? M.lyMap.get(M.tmr) : null;
  if (t != null) subs.push(`작년 이맘때(${md(M.tmr)} 무렵) 가격은 ${fmt(t)}원이었어요.`);
  return { body, subs };
}
// 참고: 설·추석·김장철까지 남은 날(오늘 = data.json의 today)
function calFacts() {
  const base = DATA.today || DATA.origin;
  if (!base) return null;
  const days = (d) => Math.round((ts(d) - ts(base)) / DAY);
  const when = (d) => (d.slice(0, 4) === base.slice(0, 4) ? monthDay(d) : `${d.slice(0, 4)}년 ${monthDay(d)}`);
  const ev = [];
  let nowKimjang = null;
  const y = +base.slice(0, 4);
  for (const yy of [y, y + 1]) { // 김장철: 대략 11/15~12/10
    const a = `${yy}-11-15`, b = `${yy}-12-10`;
    if (b < base) continue;
    if (a <= base) nowKimjang = b;
    else ev.push({ name: "김장철", label: "김장철(대략 11월 중순)", d: a });
    break;
  }
  const nextOf = (tbl, name) => { const d = Object.values(tbl).sort().find((x) => x > base); if (d) ev.push({ name, label: `${name}(${when(d)})`, d }); };
  nextOf(SEOLLAL, "설");
  nextOf(CHUSEOK, "추석");
  ev.sort((a, b) => (a.d < b.d ? -1 : 1));
  const today = Object.values(CHUSEOK).includes(base) ? "오늘은 추석이에요" : "";
  const past = Object.values(CHUSEOK).filter((x) => x < base && days(x) >= -14).pop();
  let body;
  const rest = [...ev];
  if (today) body = today;
  else if (nowKimjang) body = `지금은 김장철이에요(대략 ${monthDay(nowKimjang)}까지)`;
  else if (rest.length) { const e = rest.shift(); body = `${e.label}까지 <b>${days(e.d)}일</b> 남았어요`; }
  else return null;
  const subs = [];
  if (past) subs.push(`추석(${monthDay(past)})이 ${-days(past)}일 전에 지났어요.`);
  if (rest.length) subs.push(rest.map((e) => `${e.label}까지 ${days(e.d)}일`).join(" · "));
  return { body, subs, base };
}
function renderWhy(M) {
  const card = (used, name, src, f) => `<div class="why-card${used ? " used" : ""}">
      <h3 class="why-top"><span class="chip${used ? " used" : ""}">${used ? "예측 반영" : "참고"}</span><span class="why-name">${esc(name)}</span>${src ? `<span class="why-src">${esc(src)}</span>` : ""}</h3>
      <p class="why-body">${f.body}</p>
      ${f.subs.filter(Boolean).map((s) => `<p class="why-sub">${s}</p>`).join("")}
    </div>`;
  const out = [];
  const t = trendFacts(M); if (t) out.push(card(true, "지난 가격 기록", "(최근 흐름 포함)", t));
  const v = volFacts(M); if (v) out.push(card(false, "도매시장 반입량", "(전국, 거래일 하루 평균)", v));
  const l = lyFacts(M); if (l) out.push(card(false, "작년 같은 때 가격", "", l));
  const k = calFacts(); if (k) out.push(card(false, "김장철·명절 달력", `(${md(k.base)} 기준)`, k));
  $("whyGrid").innerHTML = out.join("");
  // '예측 반영'의 뜻: 모형이 본 것은 최근 흐름만이 아니라 지난 가격 기록 전체(작년 값 포함)
  const cs = ctxSpan();
  $("whyKeyUsed").textContent = `모형이 본 정보(지난 ${cs ? `약 ${cs} ` : ""}가격 기록, 작년 값 포함)`;
}

function renderNotes(M) {
  const notes = [];
  const chuseokClosed = M.fcAll.some((x) => M.closed.has(x.d));
  notes.push(`<p>일요일${chuseokClosed ? "과 추석 당일·다음 날은 경매가 쉬어" : "은 경매가 없어"} 예측을 그리지 않았어요. 아래 작은 막대는 날마다 시장에 들어온 양(반입량)이에요.</p>`);
  const { Y } = extents(M, windowFor(M));
  for (const x of M.provOdd) {
    const off = x.p < Y.min || x.p > Y.max;
    const offTxt = off ? ` 눈금 밖이라 그래프 ${x.p < Y.min ? "아래" : "위"} 끝에 ${x.p < Y.min ? "▼" : "▲"}로 표시했어요.` : "";
    if (x.low) {
      notes.push(`<p><i class="k k-prov"></i>${esc(md(x.d))} 잠정 ${fmt(x.p)}원은 ${x.hol ? `${esc(x.hol)}이라 ` : ""}시장에 들어온 양(반입량)이 ${fmtT(x.v)}t으로 평소(${fmtT(M.vMed)}t)의 절반도 안 되던 날 값이라 평소 시세와 다를 수 있어요.${offTxt}</p>`);
    } else {
      notes.push(`<p><i class="k k-prov"></i>${esc(md(x.d))} 잠정 ${fmt(x.p)}원은 ${esc(md(M.ref.d))} 확정 경락가보다 ${Math.round(Math.abs(x.chg))}% ${x.chg < 0 ? "낮아요" : "높아요"}${x.hol ? `(${esc(x.hol)})` : ""}. 확정되면 바뀔 수 있어요.${offTxt}</p>`);
    }
  }
  if (M.jumpy) notes.push(`<p>※ 최근 값이 하루걸러 크게 오르내려 예측선도 톱니 모양이라, 예측은 회색으로 흐리게 그렸어요.</p>`);
  $("chartNotes").innerHTML = notes.join("");
}

// ── ② 그래프 ─────────────────────────────────────────
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: g("--surface"), ink: g("--navy"), text: g("--text"), muted: g("--muted"), line: g("--line"), grid: g("--grid"),
    fc: g("--accent-ink"), band: g("--band"), bandEdge: g("--band-edge"), ly: g("--ly-line"), lyMark: g("--ly-mark"), vol: g("--vol"),
    boundary: g("--boundary"), pointer: g("--pointer"), font: g("--font"),
  };
}

function layout() {
  const w = $("chart").clientWidth || $("chartWrap").clientWidth || 800;
  const narrow = w < 560;
  // 그래프 글자: 넓은 화면 16px(03 그림과 같음), 좁은 화면 14px. 모든 눈금·라벨이 이 한 크기를 쓴다
  const L = { narrow, w, fs: narrow ? 14 : 16, top: 32, left: narrow ? 52 : 66, right: narrow ? 18 : 20, priceH: narrow ? 250 : 330, stripH: 18, volH: narrow ? 56 : 64 };
  // 마지막 예측일의 '범위 위·아래' 직접 라벨(03 그림처럼): 그래프 폭이 넉넉할 때(화면 약 768px 이상)만
  L.rangeLab = !narrow && w >= 660;
  L.stripTop = L.top + L.priceH + 8;
  L.volTop = L.stripTop + L.stripH + 28;
  L.h = L.volTop + L.volH + 30;
  L.key = `${narrow}|${L.priceH}`;
  return L;
}

// 마지막 예측일의 '범위 위·아래' 라벨을 달지: 넓은 화면, 자료 정상, 그리고 예측 구간(기준일~마지막 예측일)이
// 라벨 폭보다 넓을 때만(1년·전체 보기처럼 예측 구간이 좁으면 값은 가격 상자에 맡긴다)
function rangeLabOn(M, win, L) {
  const fcEnd = M.fcDays[M.fcDays.length - 1];
  if (!L || !L.rangeLab || M.jumpy || !fcEnd || fcEnd.q90 == null || fcEnd.q10 == null || !M.last) return false;
  if (fcEnd.t < win.x0 || fcEnd.t > win.x1) return false;
  const pxPerDay = (L.w - L.left - L.right) / Math.max(1, (win.x1 - win.x0) / DAY);
  return (fcEnd.t - M.last.t) / DAY * pxPerDay >= textW("범위 아래", L.fs) + 12;
}

// 기간 버튼 = 실제 가격을 몇 달 보여 줄지. 예측 구간은 그 뒤에 덧붙인다
function windowFor(M) {
  const x1 = M.xMax;
  const x0 = rangeDays ? Math.max(M.xMin, M.last.t - rangeDays * DAY) : M.xMin;
  return { x0, x1 };
}

// 세로 눈금: 간격 후보(1·2·2.5·5 × 10^k) 중 '빈 공간 비율 + 목표 칸 수(n)에서 벗어난 정도'가 가장 작은 것.
// maxCells: 칸이 너무 촘촘해지지 않게(한 칸 최소 약 34px). 선 그래프라 0에서 시작하지 않아도 된다(0 아래로만 내려가지 않게 막는다)
function niceScale(lo, hi, n, maxCells = n + 2) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let best = null;
  for (const m of [mag / 10, mag, mag * 10]) {
    for (const k of [1, 2, 2.5, 5]) {
      const step = k * m;
      const min = Math.max(0, Math.floor(lo / step) * step), max = Math.ceil(hi / step) * step;
      const cells = Math.round((max - min) / step);
      if (cells < Math.max(2, n - 1) || cells > Math.max(n + 2, maxCells)) continue;
      const score = ((max - min) - (hi - lo)) / (hi - lo) + 0.05 * Math.abs(cells - n);
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && cells < best.cells)) best = { min, max, step, cells, score };
    }
  }
  if (!best) { // 후보가 없으면 예전 방식
    const r = raw / mag;
    const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
    return { min: Math.max(0, Math.floor(lo / step) * step), max: Math.ceil(hi / step) * step, step };
  }
  return { min: best.min, max: best.max, step: best.step };
}

// 반입량: 보이는 기간이 길면 주·월 평균으로 묶는다(바코드처럼 번쩍이지 않게)
function volAgg(M, days) {
  const unit = days > 800 ? "월" : days > 200 ? "주" : "일";
  const all = [...M.conf, ...M.provPts].filter((x) => x.v != null);
  if (unit === "일") {
    const low = new Set(M.lowVol.map((x) => x.d)), prov = new Set(M.provPts.map((x) => x.d));
    return { unit, rows: all.map((x) => ({ t: x.t, v: x.v, low: low.has(x.d), prov: prov.has(x.d) })) };
  }
  // 주·월 묶음은 합계가 아니라 거래일 평균(t/일): 창 끝의 덜 찬 주가 줄어든 것처럼 보이지 않게
  const prov = new Set(M.provPts.map((x) => x.d));
  const m = new Map();
  for (const x of all) {
    const dt = new Date(x.t);
    const k = unit === "주" ? x.t - ((dt.getDay() + 6) % 7) * DAY + 3 * DAY : new Date(dt.getFullYear(), dt.getMonth(), 15).getTime();
    const o = m.get(k) || { s: 0, n: 0, prov: false };
    o.s += x.v; o.n += 1; o.prov = o.prov || prov.has(x.d);
    m.set(k, o);
  }
  return { unit, rows: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, o]) => ({ t, v: o.s / o.n, prov: o.prov })) };
}

// 세로축 범위는 확정·잠정·예측 범위·열흘 평균(작년 같은 순 포함)으로 정한다.
// 작년 같은 때 선은 참고선이라, 지금 눈금 위·아래로 15% 안쪽만 넘치는 값만 넣는다(더 튀는 봉우리는 그래프 끝에서 잘린다)
function extents(M, win, L) {
  const inW = (t) => t >= win.x0 - 3 * DAY && t <= win.x1 + 3 * DAY;
  const odd = new Set(M.provOdd.map((x) => x.d)); // 믿기 어려운 잠정 값은 세로 눈금 계산에서 뺀다
  const v = [];
  M.conf.forEach((x) => inW(x.t) && v.push(x.p));
  M.provPts.forEach((x) => inW(x.t) && !odd.has(x.d) && v.push(x.p));
  M.fcDays.forEach((x) => inW(x.t) && v.push(x.q10, x.q90));
  const sunIn = M.sun.filter((s) => s.t1 >= win.x0 && s.t0 <= win.x1);
  sunIn.forEach((s) => v.push(s.q10, s.q90, s.ly));
  const vv = v.filter((x) => x != null && isFinite(x));
  const lo = Math.min(...vv);
  const hi = Math.max(...vv), span = hi - lo || hi * 0.1 || 1;
  const priceH = L ? L.priceH : 330;
  const n = Math.max(4, Math.min(7, Math.round(priceH / 80)));
  const maxCells = Math.floor(priceH / 36);
  // 열흘 평균 블록의 이름표(두 줄, 약 38px)가 그림 안에 들어가게 자리를 남긴다.
  // 작년 표시가 가운데 값보다 위면 이름표는 막대 아래, 아니면 막대 위
  const tops = sunIn.filter((s) => !(s.ly != null && s.ly > s.q50)).map((s) => s.q90);
  const bots = sunIn.filter((s) => s.ly != null && s.ly > s.q50).map((s) => s.q10);
  // 마지막 예측일의 '범위 위·아래' 라벨(두 줄)도 그림 안에 들어가게 자리를 남긴다
  const fcEnd = M.fcDays[M.fcDays.length - 1];
  if (rangeLabOn(M, win, L)) { tops.push(fcEnd.q90); bots.push(fcEnd.q10); }
  const NEED = 40;
  const solve = (lo0, hi0) => {
    let Y = null;
    for (let i = 0; i < 4; i++) {
      Y = niceScale(lo0, hi0, n, maxCells);
      const px = priceH / (Y.max - Y.min);
      let ok = true;
      if (tops.length && (Y.max - Math.max(...tops)) * px < NEED - 6) { hi0 = Math.max(...tops) + NEED / px; ok = false; }
      if (bots.length && (Math.min(...bots) - Y.min) * px < NEED - 6 && Y.min > 0) { lo0 = Math.min(...bots) - NEED / px; ok = false; }
      if (ok) break;
    }
    return Y;
  };
  let Y = solve(lo - span * 0.03, hi + span * 0.03);
  // 작년 같은 때: 보이는 구간에서 지금 눈금을 15% 안쪽으로만 넘치는 값은 눈금에 넣어 잘리지 않게 한다
  const lyIn = M.ly.filter((x) => x.t >= win.x0 && x.t <= win.x1).map((x) => x.p);
  const r0 = Y.max - Y.min;
  const over = lyIn.filter((p) => p > Y.max && p <= Y.max + 0.15 * r0);
  const under = lyIn.filter((p) => p < Y.min && p >= Y.min - 0.15 * r0);
  if (over.length || under.length) {
    const hi1 = over.length ? Math.max(hi, ...over) : hi, lo1 = under.length ? Math.min(lo, ...under) : lo;
    const span1 = hi1 - lo1 || span;
    Y = solve(lo1 - span1 * 0.03, hi1 + span1 * 0.03);
  }
  const agg = volAgg(M, (win.x1 - win.x0) / DAY);
  const vols = agg.rows.filter((r) => inW(r.t)).map((r) => r.v);
  const V = { max: niceScale(0, vols.length ? Math.max(...vols) : 1, 3).max };
  return { Y, V, agg };
}

function xInterval(win, narrow) {
  const days = (win.x1 - win.x0) / DAY;
  if (days > 800) return 365 * DAY;
  if (days > 200) return (narrow ? 91 : 30) * DAY;
  return (narrow ? 30 : 28) * DAY;
}
// 짧은 기간(130일 이하)은 매월 1일·15일에 눈금: '8/15, 9월, 9/15, 10월'.
// 15일 간격이 약 56px보다 좁으면(좁은 화면의 3개월 등) 글자가 붙으므로 매월 1일만
function tickValues(win, L) {
  const days = (win.x1 - win.x0) / DAY;
  if (days > 130) return null;
  const pxPerDay = L ? (L.w - L.left - L.right) / Math.max(1, days) : 10;
  const marks = 15 * pxPerDay < 56 ? [1] : [1, 15];
  const out = [];
  const d = new Date(win.x0); d.setDate(1);
  while (d.getTime() <= win.x1) {
    for (const day of marks) {
      const t = new Date(d.getFullYear(), d.getMonth(), day).getTime();
      if (t >= win.x0 && t <= win.x1) out.push(t);
    }
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

// x축 눈금: 해가 바뀌면 '2026년', 달이 바뀌면 '9월', 그 밖은 '9/15'. 자료 끝 뒤 눈금은 비운다
function tickLabel(v, xMax) {
  if (v > xMax) return "";
  const d = new Date(v);
  if (d.getMonth() === 0 && d.getDate() === 1) return `${d.getFullYear()}년`;
  if (d.getDate() === 1) return `${d.getMonth() + 1}월`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 툴팁·키보드 읽기 공용: 날짜 하나의 값 목록
function tipRows(M, d) {
  const r = M.byDate.get(d) || {};
  const s = M.sun.find((x) => d >= x.start && d <= x.end);
  const ly = M.lyMap.get(d);
  const U = " 원/kg";
  if (s && !r.fc && r.act == null && r.prov == null) {
    return {
      head: `${s.label} 평균(${s.range})`,
      rows: [
        ["k-line k-fc", `${fmt(s.q50)}${U}`, "열흘 평균 예측"],
        ["k-tband", `${fmt(s.q10)}~${fmt(s.q90)}${U}`, "예측 범위"],
        ...(s.ly != null ? [["k-lysun", `${fmt(s.ly)}${U}`, "작년 같은 순 평균"]] : []),
      ],
      notes: M.jumpy ? ["자료 점검 중이라 참고만 하세요."] : [],
    };
  }
  const rows = [], notes = [];
  if (r.act != null) rows.push(["k-line k-act", `${fmt(r.act)}${U}`, "실제 경락가"]);
  if (r.prov != null) rows.push(["k-prov", `${fmt(r.prov)}${U}`, "잠정"]);
  if (r.fc) {
    rows.push(["k-line k-fc", `${fmt(r.fc.q50)}${U}`, "예측(가운데 값)"]);
    rows.push(["k-tband", `${fmt(r.fc.q10)}~${fmt(r.fc.q90)}${U}`, "예측 범위"]);
  }
  if (ly != null) rows.push(["k-line k-ly", `${fmt(ly)}${U}`, "작년 같은 때"]);
  if (r.vol != null) rows.push(["k-tvol", `${fmtT(r.vol)} t`, "반입량"]);
  if (r.act == null && r.prov == null && !r.fc) {
    if (isSun(d)) notes.push("일요일이라 경매가 없어요.");
    else if (M.closed.has(d)) notes.push(`${holidayName(d) || "휴장일"}이라 경매가 없는 날로 봤어요.`);
    else notes.push("이날은 거래 자료가 없어요.");
  }
  const lyNote = lyClosedNote(M, d);
  if (lyNote) notes.push(lyNote);
  const odd = M.provOdd.find((x) => x.d === d);
  if (odd) notes.push(odd.low ? "거래가 적은 날의 잠정 값이라 평소 시세와 다를 수 있어요." : "잠정 값이라 확정되면 바뀔 수 있어요.");
  if (r.fc && M.jumpy) notes.push("자료 점검 중이라 예측은 참고만 하세요.");
  return { head: longD(d), rows, notes };
}
function tipHtml(M, params) {
  const p = Array.isArray(params) ? params[0] : params;
  if (!p) return "";
  const d = ds(typeof p.axisValue === "number" ? p.axisValue : ts(String(p.axisValue)));
  const T = tipRows(M, d);
  return `<div class="tt-d">${esc(T.head)}</div>` +
    T.rows.map(([k, v, n]) => `<div class="tt-r"><i class="k ${k}"></i><b>${esc(v)}</b><span>${esc(n)}</span></div>`).join("") +
    T.notes.map((n) => `<div class="tt-note">${esc(n)}</div>`).join("");
}
function tipText(M, d) {
  const T = tipRows(M, d);
  return [T.head, ...T.rows.map(([, v, n]) => `${n} ${v}`), ...T.notes].join(". ");
}

// 대략의 글자 폭(px): 한글은 글자 크기, 숫자는 0.6배, 나머지 0.35배
function textW(s, size) {
  let w = 0;
  for (const ch of String(s)) w += /[가-힣]/.test(ch) ? size : /[0-9]/.test(ch) ? size * 0.6 : size * 0.35;
  return w;
}

// 기간·확대에 따라 바뀌는 부분(세로 눈금, 가로 눈금, 잠정 점, 반입량)
function dynamicParts(M, win, L, T) {
  const { Y, V, agg } = extents(M, win, L);
  const text = (x = {}) => ({ color: T.muted, fontFamily: T.font, fontSize: L.fs, fontWeight: 500, ...x });
  const halo = { textBorderColor: T.surface, textBorderWidth: 4 };
  const pxPerDay = (L.w - L.left - L.right) / Math.max(1, (win.x1 - win.x0) / DAY);
  const prov = M.provPts.map((x, i, a) => {
    const off = x.p < Y.min ? -1 : x.p > Y.max ? 1 : 0;
    const odd = M.provOdd.find((o) => o.d === x.d);
    // 그래프 안에는 '잠정 975'만. 이유(추석 전날·소량 거래)는 그래프 아래 주석에 있다
    const txt = `잠정 ${fmt(x.p)}${off < 0 ? " ↓" : off > 0 ? " ↑" : ""}`;
    const roomRight = (win.x1 - x.t) / DAY * pxPerDay;
    const fitsRight = textW(txt, L.fs) + 6 <= roomRight;
    const show = !!odd || i === a.length - 1;
    // 라벨은 예측 쪽(오른쪽)에 붙인다: 그쪽은 옅은 범위 면뿐이라 선을 지우지 않는다.
    // 그림 아래쪽 15% 안이면 점 위로(달력 줄과 겹치지 않게), 오른쪽 자리가 모자라면 점 바로 위로
    const nearBottom = off < 0 || (x.p - Y.min) / Math.max(1, Y.max - Y.min) < 0.15;
    return {
      value: [x.t, off < 0 ? Y.min : off > 0 ? Y.max : x.p],
      symbol: off ? "triangle" : "circle", symbolRotate: off < 0 ? 180 : 0, symbolSize: off ? 11 : 9,
      itemStyle: off ? { color: T.muted, borderColor: T.surface, borderWidth: 1 } : { color: T.surface, borderColor: T.muted, borderWidth: 2 },
      label: show ? {
        show: true, position: fitsRight && !nearBottom ? "bottom" : "top", distance: 6,
        align: fitsRight ? "left" : "center", offset: [fitsRight ? -4 : 0, 0],
        formatter: txt, ...text(), ...halo,
      } : { show: false },
    };
  });
  // 반입량: 잠정(정산 전)은 흐린 막대. 거래가 적었던 잠정일은 막대 위에 잠정과 같은 빈 원 + 't' 라벨
  const vol = agg.rows.map((r) => ({ value: [r.t, r.v], itemStyle: r.prov ? { opacity: 0.45 } : undefined }));
  const low = new Set(M.lowVol.map((x) => x.d));
  const volMarks = agg.unit === "일"
    ? M.provPts.filter((x) => low.has(x.d) && x.v != null).map((x) => ({
      value: [x.t, x.v],
      label: { show: true, position: "top", distance: 3, formatter: `${fmtT(x.v)}t`, ...text(), ...halo },
    }))
    : [];
  const hasProv = agg.rows.some((r) => r.prov);
  return {
    Y, V, prov, vol, volMarks,
    volTitle: agg.unit === "일" ? `반입량(t)${hasProv ? " · 흐린 막대는 잠정" : ""}` : `반입량(t/일, ${agg.unit} 평균)${hasProv ? " · 흐린 막대는 잠정 포함" : ""}`,
    ticks: tickValues(win, L),
    minInterval: xInterval(win, L.narrow),
  };
}

function renderChart(M) {
  M = M || model(current);
  const el = $("chart");
  const T = tokens();
  const L = layout();
  lastLayoutKey = L.key;
  el.style.height = `${L.h}px`;
  if (!chart) {
    chart = echarts.init(el, null, { renderer: "svg" });
    chart.on("datazoom", onZoom);
    // 그래프 속 글자 조각(눈금·라벨)은 화면 낭독기에서 숨긴다. 같은 값은 가격 상자·알림·「표로 보기」에 있다
    const root = chart.getDom().firstElementChild;
    if (root) root.setAttribute("aria-hidden", "true");
  } else {
    // 떠 있는 툴팁을 먼저 닫는다: 안 닫으면 resize가 '툴팁 다시 띄우기'를 예약하고, 곧바로 아래 setOption(…, true)이
    // 툴팁 부품을 새로 만들면서 옛 부품을 지워 예약이 빈 부품을 건드린다(콘솔 TypeError). 30분 자동 갱신·기간 버튼·밝기 전환 때 생김
    chart.dispatchAction({ type: "hideTip" });
    chart.resize();
  }
  const win = windowFor(M);
  const D = dynamicParts(M, win, L, T);
  const text = (x = {}) => ({ color: T.muted, fontFamily: T.font, fontSize: L.fs, fontWeight: 500, ...x });
  const halo = { textBorderColor: T.surface, textBorderWidth: 4 };
  const last = M.last;
  const fcEnd = M.fcDays[M.fcDays.length - 1];
  const year = +DATA.origin.slice(0, 4);
  // 자료 점검 중(톱니 예측): 예측선·범위를 회색으로 흐리게 그려 알림의 '믿기 어려워요'와 말을 맞춘다
  const J = M.jumpy;
  $("lgLySun").hidden = !M.sun.some((s) => s.ly != null);
  const fcColor = J ? T.muted : T.fc;
  const bandColor = J ? T.grid : T.band;
  const edge = J ? T.line : T.bandEdge; // 예측 범위 가장자리 1px
  const DASH = [7, 5];

  const xAxis = [0, 1, 2].map((i) => ({
    type: "time", gridIndex: i, min: M.xMin, max: M.xMax,
    minInterval: D.minInterval,
    axisTick: { show: false }, splitLine: { show: false },
    axisLine: { show: i === 2, lineStyle: { color: T.line } },
    axisPointer: { show: true, type: "line", snap: true, lineStyle: { color: T.pointer, width: 1, type: "solid" }, label: { show: false } },
    axisLabel: i === 2
      ? { ...text(), hideOverlap: true, margin: 10, customValues: D.ticks, formatter: (v) => tickLabel(v, M.xMax) }
      : { show: false },
  }));

  const plotW = L.w - L.left - L.right;
  const pxPerDay = plotW / Math.max(1, (win.x1 - win.x0) / DAY);

  // 달력 줄: 추석(올해 ● 남색, 작년 ● 회색 — 회색은 화면 전체에서 '작년'), 김장철(대략 11/15~12/10, 해마다)
  const cal = [];
  let lyName = "";
  if (CHUSEOK[year - 1]) {
    const t = ts(addDays(CHUSEOK[year - 1], LY_SHIFT));
    const room = (win.x1 - t) / DAY * pxPerDay; // 오른쪽 자리에 맞춰 '작년 추석' → '작년' → (올해 라벨에 합침)
    lyName = room >= textW("작년 추석", L.fs) + 10 ? "작년 추석" : room >= textW("작년", L.fs) + 8 ? "작년" : "";
    cal.push({ value: [t, 0], name: lyName, itemStyle: { color: T.lyMark, borderColor: T.surface, borderWidth: 2 }, label: { position: "right", show: !!lyName } });
  }
  if (CHUSEOK[year]) cal.unshift({ value: [ts(CHUSEOK[year]), 0], name: CHUSEOK[year - 1] && !lyName ? "추석(회색 점은 작년)" : "추석", itemStyle: { color: T.ink, borderColor: T.surface, borderWidth: 2 }, label: { position: "left" } });
  const y0 = new Date(M.xMin).getFullYear(), y1 = new Date(M.xMax).getFullYear();
  const kimjangPx = 25 * pxPerDay;
  const kimjang = [];
  for (let y = y0; y <= y1; y++) {
    const a = ts(`${y}-11-15`), b = ts(`${y}-12-10`);
    if (b < M.xMin || a > M.xMax) continue;
    kimjang.push([{ xAxis: a, name: "김장철(대략)", label: { show: kimjangPx >= 30 } }, { xAxis: b }]);
  }

  // 기준일 라벨: 넓으면 '9/24까지 확정 · 9/25 잠정 · 9/28부터 예측', 좁으면 '9/24 기준일'
  const pv = M.provPts;
  const provTxt = pv.length ? (pv.length === 1 ? md(pv[0].d) : `${md(pv[0].d)}~${md(pv[pv.length - 1].d)}`) : "";
  const bLabel = L.narrow ? `${md(last.d)} 기준일`
    : `${md(last.d)}까지 확정${provTxt ? ` · ${provTxt} 잠정` : ""} · ${M.tmr ? `${md(M.tmr)}부터 예측` : "이후 예측"}`;
  const bRoom = (win.x1 - last.t) / DAY * pxPerDay; // 기준선 오른쪽 자리
  const fcLine = [[last.t, last.p], ...M.fcDays.map((x) => [x.t, x.q50])];
  const roomy = fcEnd && (fcEnd.t - last.t) / DAY * pxPerDay >= 60; // 예측 구간이 좁으면 끝 라벨은 가격 상자에 맡긴다
  if (fcEnd) {
    // 끝 라벨: 오른쪽(첫 열흘 평균 블록 전까지)에 자리가 있으면 점의 오른쪽 위 — 예측선은 왼쪽에서 들어오므로 글자를 가로지르지 않는다.
    // 자리가 없으면 선이 들어오는 반대쪽(직전 점이 더 높으면 아래, 아니면 위)
    const endTxt = `${md(fcEnd.d)} ${fmt(fcEnd.q50)}`;
    const nextBlock = M.sun.length ? M.sun[0].t0 : M.xMax;
    const rightRoom = (nextBlock - fcEnd.t) / DAY * pxPerDay;
    const prevFc = M.fcDays.length > 1 ? M.fcDays[M.fcDays.length - 2].q50 : last.p;
    const endPos = rightRoom >= textW(endTxt, L.fs) + 8
      ? { position: "right", verticalAlign: "bottom", distance: 3, offset: [0, -3] }
      : { position: prevFc > fcEnd.q50 ? "bottom" : "top", distance: 8, align: "right", offset: [4, 0] }; // 점 왼쪽으로(오른쪽은 곧 2순 블록)
    fcLine[fcLine.length - 1] = {
      value: [fcEnd.t, fcEnd.q50], symbol: "circle", symbolSize: 9,
      itemStyle: { color: fcColor, borderColor: T.surface, borderWidth: 2 },
      label: { show: roomy && !J, ...endPos, formatter: endTxt, ...text({ color: T.fc, fontWeight: 700 }), ...halo },
    };
  }
  // '작년 같은 때' 선: 작년 그날 거래가 없던 날(명절 연휴 등)이 이틀 넘게 이어지면 선을 끊는다.
  // 일요일 하루 틈은 실제 경락가 선처럼 건너뛰어 잇는다
  const lyData = [];
  M.ly.forEach((x, i) => {
    const prev = M.ly[i - 1];
    if (prev && x.t - prev.t > 2 * DAY + 2 * 3600e3) lyData.push([prev.t + DAY, null]);
    lyData.push([x.t, x.p]);
  });
  // 직접 라벨 '작년 같은 때': 보이는 구간(기준일 전)에서 잘리지 않은 봉우리에만 단다.
  // 조건: 라벨 폭 안의 작년 값이 모두 이 점 이하(=그 근처 선이 눈금 밖으로 나가지 않음), 위로 라벨 높이만큼 빈자리,
  // 실제 경락가 선이 라벨 자리를 지나가지 않음. 그런 곳 중 가장 높은 곳
  const LY_TXT = "작년 같은 때";
  const pxPerVal = L.priceH / Math.max(1, D.Y.max - D.Y.min);
  const halfT = ((textW(LY_TXT, L.fs) / 2 + 6) / Math.max(pxPerDay, 0.01)) * DAY;
  const labV = (L.fs + 10) / pxPerVal; // 라벨 높이(값 단위)
  // 라벨 오른쪽 끝이 기준일 세로선보다 10px 넘게 왼쪽에 오게(예측 구간·범위 라벨과 겹치지 않게)
  const lyT0 = win.x0 + halfT, lyT1 = Math.min(last.t - halfT - (10 / Math.max(pxPerDay, 0.01)) * DAY, win.x1 - halfT);
  let peakT = null, peakP = -Infinity;
  for (const x of M.ly) {
    if (x.t < lyT0 || x.t > lyT1 || x.p <= peakP || x.p < D.Y.min || x.p + labV + 6 / pxPerVal > D.Y.max) continue;
    const near = (a) => Math.abs(a.t - x.t) <= halfT + DAY;
    if (M.ly.some((y) => near(y) && y.p > x.p)) continue;
    // 실제 경락가 선(점과 점 사이 선분)이 라벨 자리(가로 ±halfT, 세로 x.p ~ x.p+labV)를 지나가면 뺀다
    const bLo = x.p - 4 / pxPerVal, bHi = x.p + labV + 4 / pxPerVal;
    let hit = false;
    for (let i = 1; i < M.conf.length && !hit; i++) {
      const a = M.conf[i - 1], b = M.conf[i];
      if (b.t < x.t - halfT || a.t > x.t + halfT) continue;
      hit = Math.max(a.p, b.p) >= bLo && Math.min(a.p, b.p) <= bHi;
    }
    if (hit) continue;
    peakP = x.p; peakT = x.t;
  }
  if (peakT != null) {
    const k = lyData.findIndex((v) => Array.isArray(v) && v[0] === peakT);
    if (k >= 0) lyData[k] = { value: lyData[k], symbol: "circle", symbolSize: 1, itemStyle: { color: "transparent", borderWidth: 0 }, label: { show: true, position: "top", distance: 4, formatter: LY_TXT, ...text(), ...halo } };
  }

  // '마지막 확정' 라벨: 선이 들어오는 반대쪽(직전이 더 높으면 왼쪽 아래, 아니면 왼쪽 위). 촘촘한 기간·좁은 화면에서는 뺀다(값은 가격 상자에)
  const prevP = M.conf.length > 1 ? M.conf[M.conf.length - 2].p : last.p;
  const showLast = !L.narrow && pxPerDay >= 3;
  // 그림 아래쪽 15% 안이면 늘 점 위로(아래로 가면 달력 줄의 '추석' 글자와 겹친다)
  const lastNearBottom = (last.p - D.Y.min) / Math.max(1, D.Y.max - D.Y.min) < 0.15;
  const lastPos = lastNearBottom ? "top" : prevP > last.p ? "bottom" : "top";

  // 마지막 예측일의 '범위 위·아래' 직접 라벨(03 그림처럼 파랑 글씨, 두 줄). 넓은 화면·자료 정상일 때만.
  // 점의 왼쪽으로 붙인다(오른쪽은 곧바로 2순 블록이 온다). 범위 띠는 왼쪽으로 갈수록 좁아지므로 글자가 띠 밖에 놓인다
  const rangeMarks = [];
  if (rangeLabOn(M, win, L)) {
    const lab = (pos, name, v) => ({ show: true, position: pos, align: "right", offset: [4, 0], distance: 6, lineHeight: L.fs + 3,
      formatter: `${name}\n${fmt(v)}원`, ...text({ color: T.fc, fontWeight: 700 }), ...halo });
    rangeMarks.push({ value: [fcEnd.t, fcEnd.q90], label: lab("top", "범위 위", fcEnd.q90) });
    rangeMarks.push({ value: [fcEnd.t, fcEnd.q10], label: lab("bottom", "범위 아래", fcEnd.q10) });
  }

  const option = {
    animation: false,
    textStyle: { fontFamily: T.font },
    grid: [
      { left: L.left, right: L.right, top: L.top, height: L.priceH },
      { left: L.left, right: L.right, top: L.stripTop, height: L.stripH },
      { left: L.left, right: L.right, top: L.volTop, height: L.volH },
    ],
    xAxis,
    yAxis: [
      { type: "value", gridIndex: 0, min: D.Y.min, max: D.Y.max, interval: D.Y.step, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { ...text(), formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: T.grid, width: 1, type: [4, 4] } } },
      { type: "value", gridIndex: 1, min: -1, max: 1, show: false },
      { type: "value", gridIndex: 2, min: 0, max: D.V.max, interval: D.V.max, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { ...text(), formatter: (v) => fmtT(v) }, splitLine: { show: false } },
    ],
    dataZoom: [{
      type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none", startValue: win.x0, endValue: win.x1,
      zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true, preventDefaultMouseMove: false,
      disabled: coarse, minValueSpan: 21 * DAY,
    }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis", confine: true, transitionDuration: 0, triggerOn: "mousemove|click",
      backgroundColor: T.surface, borderColor: T.line, borderWidth: 1, padding: [10, 12],
      textStyle: { color: T.text, fontFamily: T.font, fontSize: 16 },
      extraCssText: "box-shadow:none;border-radius:10px;",
      // 툴팁은 포인터 반대편 위쪽 모서리에 고정: 세로 십자선이 날짜를 짚으니 따라다닐 필요가 없고, 주석·예측 구간을 가리지 않는다
      position: (point, params, dom, rect, size) => {
        const w = size.contentSize[0];
        const plotL = L.left, plotR = chart.getWidth() - L.right;
        const x = point[0] > (plotL + plotR) / 2 ? plotL + 8 : plotR - w - 8;
        return [Math.max(0, x), L.top + 4];
      },
      formatter: (ps) => tipHtml(M, ps),
    },
    graphic: [{ id: "volTitle", type: "text", left: L.left, top: L.volTop - 22, silent: true, style: { text: D.volTitle, fill: T.muted, font: `500 ${L.fs}px ${T.font}` } }],
    series: [
      { name: "범위하한", type: "line", data: [[last.t, last.p], ...M.fcDays.map((x) => [x.t, x.q10])], stack: "band", symbol: "none",
        lineStyle: { color: edge, width: 1 }, silent: true, z: 2, emphasis: { disabled: true } },
      { name: "범위", type: "line", data: [[last.t, 0], ...M.fcDays.map((x) => [x.t, x.q90 - x.q10])], stack: "band", symbol: "none",
        lineStyle: { color: edge, width: 1 }, areaStyle: { color: bandColor, opacity: 1 }, silent: true, z: 2, emphasis: { disabled: true } },
      { name: "순 평균", type: "custom", clip: true, z: 2, silent: true,
        data: M.sun.map((s) => [s.t0, s.t1, s.q10, s.q90, s.q50]), encode: { x: [0, 1], y: [2, 3] },
        renderItem: (params, api) => {
          const s = M.sun[params.dataIndex];
          const xa = api.coord([s.t0, s.q50])[0] + 1, xb = api.coord([s.t1, s.q50])[0] - 1; // 이웃 순 사이 2px 틈
          const w = xb - xa, cx = (xa + xb) / 2;
          const yTop = api.coord([s.t0, s.q90])[1], yBot = api.coord([s.t0, s.q10])[1], yMid = api.coord([s.t0, s.q50])[1];
          const rw = Math.max(6, w * 0.45);
          const kids = [
            { type: "rect", shape: { x: cx - rw / 2 + 0.5, y: yTop + 0.5, width: rw - 1, height: yBot - yTop - 1 }, style: { fill: bandColor, stroke: edge, lineWidth: 1 } },
            { type: "line", shape: { x1: xa, y1: yMid, x2: xb, y2: yMid }, style: { stroke: fcColor, lineWidth: J ? 1.5 : 2.5 } },
          ];
          // 작년 같은 순: 회색 점선 가로줄(색만이 아니라 선 모양으로도 파란 예측 줄과 구분). 범례 '작년 같은 순'과 같다
          const lyAbove = s.ly != null && s.ly > s.q50;
          if (s.ly != null) {
            const yl = api.coord([s.t0, s.ly])[1];
            kids.push({ type: "line", shape: { x1: xa + 2, y1: yl, x2: xb - 2, y2: yl }, style: { stroke: T.lyMark, lineWidth: 2, lineDash: [3, 3] } });
          }
          // 라벨 모양은 모든 순 블록에 같게: 한 줄 → 두 줄 → 이름만 → 없음(값은 툴팁·가격 상자·표에)
          const ws = M.sun.map((x) => api.coord([x.t1, x.q50])[0] - api.coord([x.t0, x.q50])[0] - 2);
          const fits = (f) => M.sun.every((x, i) => f(x) <= ws[i] + 4);
          const fs = L.fs;
          const mode = fits((x) => textW(`${x.short} ${fmt(x.q50)}`, fs)) ? 1
            : fits((x) => Math.max(textW(x.short, fs), textW(fmt(x.q50), fs))) ? 2
            : fits((x) => textW(x.short, fs)) ? 3 : 0;
          const label = mode === 1 ? `${s.short} ${fmt(s.q50)}` : mode === 2 ? `${s.short}\n${fmt(s.q50)}` : mode === 3 ? s.short : null;
          if (label) {
            // 라벨은 늘 범위 막대에 붙이고, 작년 표시의 반대쪽에 단다(작년이 위면 막대 아래, 아니면 막대 위)
            kids.push({ type: "text", x: cx, y: lyAbove ? yBot + 5 : yTop - 5, style: {
              text: label, fill: J ? T.muted : T.fc, font: `700 ${fs}px ${T.font}`, lineHeight: fs + 3,
              align: "center", verticalAlign: lyAbove ? "top" : "bottom", stroke: T.surface, lineWidth: 4,
            } });
          }
          return { type: "group", children: kids };
        } },
      // 작년 같은 때: 실제선보다 한 단계 옅고 가늘게, 예측 범위 띠 아래에(z 1) 그린다
      { name: "작년", type: "line", data: lyData, connectNulls: false, showSymbol: true, showAllSymbol: true, symbol: "none", lineStyle: { color: T.ly, width: 1.25 }, z: 1,
        labelLayout: { hideOverlap: true }, emphasis: { disabled: true } },
      { name: "확정", type: "line", data: M.conf.map((x) => [x.t, x.p]), showSymbol: false, symbol: "none",
        lineStyle: { color: T.ink, width: 2.5, cap: "round", join: "round" }, z: 4, emphasis: { disabled: true } },
      { id: "prov", name: "잠정", type: "line", data: D.prov, showSymbol: true, lineStyle: { opacity: 0, width: 0 }, z: 5, emphasis: { disabled: true } },
      { name: "예측", type: "line", data: fcLine, symbol: "none", showSymbol: true,
        lineStyle: { color: fcColor, width: J ? 1.5 : 2.5, type: DASH, cap: "round", join: "round" }, z: 5, emphasis: { disabled: true },
        markLine: { symbol: "none", silent: true, animation: false,
          lineStyle: { color: T.boundary, width: 1.5, type: [6, 4] },
          label: { show: true, position: "end", formatter: bLabel, ...text({ color: T.text, fontWeight: 500 }), distance: 8, ...(bRoom < textW(bLabel, L.fs) / 2 + 4 ? { align: "right", offset: [Math.max(0, bRoom - 2), 0] } : {}) },
          data: [{ xAxis: last.t }] },
        // 자료 점검 중이면 예측 구간 위에 직접 라벨
        markArea: J ? { silent: true, itemStyle: { color: "transparent" },
          // 1년·전체 보기처럼 예측 구간이 좁으면 글자가 오른쪽 끝에서 잘리므로 구간 오른쪽 끝에 맞춰 왼쪽으로 늘인다
          label: { show: true, position: bRoom >= textW("자료 점검 중 · 참고만", L.fs) + 12 ? "insideTopLeft" : "insideTopRight", distance: 6, formatter: "자료 점검 중 · 참고만", ...text({ color: T.text, fontWeight: 700 }), ...halo },
          data: [[{ xAxis: last.t }, { xAxis: M.xMax }]] } : undefined },
      { name: "마지막 확정", type: "scatter", data: [[last.t, last.p]], symbolSize: 10, z: 6, silent: true,
        itemStyle: { color: T.ink, borderColor: T.surface, borderWidth: 2 },
        label: { show: showLast, position: lastPos, align: "right", offset: [-3, 0], distance: 4, formatter: `${md(last.d)} 실제 ${fmt(last.p)}`, ...text({ color: T.ink, fontWeight: 700 }), ...halo } },
      { name: "범위 끝", type: "scatter", data: rangeMarks, symbol: "circle", symbolSize: 7, z: 6, silent: true,
        itemStyle: { color: T.fc } },
      { name: "달력", type: "scatter", xAxisIndex: 1, yAxisIndex: 1, data: cal, symbolSize: 9, clip: true, silent: true,
        label: { show: true, position: "right", distance: 5, formatter: "{b}", ...text() },
        labelLayout: { hideOverlap: true },
        markArea: kimjang.length ? { silent: true, itemStyle: { color: T.line }, label: { position: "right", distance: 4, ...text() }, data: kimjang } : undefined },
      { id: "vol", name: "반입량", type: "bar", xAxisIndex: 2, yAxisIndex: 2, data: D.vol,
        barMaxWidth: 6, itemStyle: { color: T.vol, borderRadius: [2, 2, 0, 0] }, emphasis: { disabled: true }, large: false },
      { id: "volMark", name: "적은 반입량", type: "scatter", xAxisIndex: 2, yAxisIndex: 2, data: D.volMarks, symbol: "circle", symbolSize: 8, z: 4, silent: true,
        itemStyle: { color: T.surface, borderColor: T.muted, borderWidth: 1.5 } },
    ],
  };
  chart.setOption(option, true);

  const c = M.c;
  el.setAttribute("aria-label",
    `${M.name} 경락가 그래프. ${longD(last.d)} 확정 ${fmt(last.p)}원. ${M.tmr ? longD(M.tmr) : "다음 거래일"} 예측 ${fmt(c.tomorrow)}원, 예측 범위 ${fmt(c.t10)}~${fmt(c.t90)}원.${J ? " 자료 점검 중이라 예측은 참고만 하세요." : ""}`);
}

function onZoom() {
  // 끌기·Ctrl+휠로 기간을 바꾸면 세로 눈금·가로 눈금·반입량 묶음을 다시 맞춘다
  const opt = chart.getOption();
  const dz = opt.dataZoom && opt.dataZoom[0];
  if (!dz) return;
  const M = model(current);
  const win = { x0: dz.startValue, x1: dz.endValue };
  const L = layout();
  const D = dynamicParts(M, win, L, tokens());
  chart.setOption({
    xAxis: [0, 1, 2].map((i) => (i === 2 ? { minInterval: D.minInterval, axisLabel: { customValues: D.ticks } } : { minInterval: D.minInterval })),
    yAxis: [{ min: D.Y.min, max: D.Y.max, interval: D.Y.step }, {}, { min: 0, max: D.V.max, interval: D.V.max }],
    series: [{ id: "prov", data: D.prov }, { id: "vol", data: D.vol }, { id: "volMark", data: D.volMarks }],
    graphic: [{ id: "volTitle", style: { text: D.volTitle } }],
  });
  document.querySelectorAll("#rangeSeg button").forEach((b) => b.setAttribute("aria-pressed", "false"));
}

// 키보드: 그래프에 초점을 두고 방향키로 날짜를 옮긴다. 읽은 값은 화면 낭독기에도 알린다
function kbDates(M) {
  const opt = chart.getOption();
  const dz = opt.dataZoom && opt.dataZoom[0];
  const x0 = dz ? dz.startValue : M.xMin, x1 = dz ? dz.endValue : M.xMax;
  const set = new Set();
  M.conf.forEach((x) => set.add(x.t));
  M.provPts.forEach((x) => set.add(x.t));
  M.fcDays.forEach((x) => set.add(x.t));
  M.sun.forEach((s) => set.add(ts(s.start) + 4 * DAY));
  return [...set].filter((t) => t >= x0 && t <= x1).sort((a, b) => a - b);
}
$("chart").addEventListener("keydown", (e) => {
  if (!chart || !DATA) return;
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  if (e.key === "Escape") { chart.dispatchAction({ type: "hideTip" }); return; }
  const M = model(current);
  const dates = kbDates(M);
  if (!dates.length) return;
  if (kbIdx == null || kbIdx >= dates.length) {
    kbIdx = Math.max(0, dates.indexOf(M.last.t));
  } else if (e.key === "ArrowLeft") kbIdx = Math.max(0, kbIdx - 1);
  else if (e.key === "ArrowRight") kbIdx = Math.min(dates.length - 1, kbIdx + 1);
  if (e.key === "Home") kbIdx = 0;
  if (e.key === "End") kbIdx = dates.length - 1;
  const x = chart.convertToPixel({ xAxisIndex: 0 }, dates[kbIdx]);
  chart.dispatchAction({ type: "showTip", x, y: layout().top + 40 });
  $("chartLive").textContent = tipText(M, ds(dates[kbIdx]));
});
$("chart").addEventListener("blur", () => chart && chart.dispatchAction({ type: "hideTip" }));
// 마우스로 띄운 툴팁도 Esc로 닫는다
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && chart) chart.dispatchAction({ type: "hideTip" }); });

// ── 표로 보기: 그래프 기간을 따른다(6주·3개월은 날마다, 1년·전체는 주 평균) ──────
function renderTable(M) {
  const weekly = !rangeDays || rangeDays > 120;
  const cell = (v) => (v == null ? "–" : fmt(v));
  const vcell = (v) => (v == null ? "–" : fmtT(v));
  // 작년 같은 때 칸: 작년 그날 거래가 없었으면 '작년 휴장'
  const lyCell = (d) => (M.lyMap.has(d) ? fmt(M.lyMap.get(d)) : lyClosedNote(M, d) ? `<span class="tag">작년 휴장</span>` : "–");
  const rowHead = (s) => `<th scope="row">${s}</th>`;
  const groups = []; // [구역 이름, 행들]
  const fcRows = [];
  if (M.upcoming.length) {
    let d = M.upcoming[0].d;
    const end = M.upcoming[M.upcoming.length - 1].d;
    const fcMap = new Map(M.upcoming.map((x) => [x.d, x]));
    while (d <= end) {
      const f = fcMap.get(d);
      if (f) fcRows.push(`<tr>${rowHead(esc(mdw(d)))}<td>–</td><td>${fmt(f.q50)}</td><td>${fmt(f.q10)}~${fmt(f.q90)}</td><td>${lyCell(d)}</td><td>–</td></tr>`);
      else if (isSun(d) || M.closed.has(d)) fcRows.push(`<tr class="closed">${rowHead(esc(mdw(d)))}<td colspan="5">휴장(${isSun(d) ? "일요일" : esc(holidayName(d) || "휴장일")})</td></tr>`);
      d = addDays(d, 1);
    }
  }
  groups.push([`앞으로 10일 예측 (${M.tmr ? esc(mdw(M.tmr)) : ""}부터)`, fcRows]);
  if (M.sun.length) {
    groups.push(["열흘 평균 예측", M.sun.map((s) => `<tr>${rowHead(`${esc(s.label)} (${esc(s.range)})`)}<td>–</td><td>${fmt(s.q50)}</td><td>${fmt(s.q10)}~${fmt(s.q90)}</td><td>${cell(s.ly)}</td><td>–</td></tr>`)]);
  }
  const from = rangeDays ? M.last.t - rangeDays * DAY : M.xMin;
  const hist = [];
  if (!weekly) {
    [...M.conf.filter((x) => x.t >= from), ...M.provPts].reverse().forEach((x) => {
      const prov = M.provPts.includes(x);
      hist.push(`<tr>${rowHead(esc(mdw(x.d)))}<td>${fmt(x.p)}${prov ? `<span class="tag">잠정</span>` : ""}</td><td>–</td><td>–</td><td>${lyCell(x.d)}</td><td>${vcell(x.v)}</td></tr>`);
    });
    groups.push([`지난 가격 (최근 ${rangeDays === 42 ? "6주" : "3개월"}, 최근 날짜부터)`, hist]);
  } else {
    M.provPts.slice().reverse().forEach((x) => hist.push(`<tr>${rowHead(esc(mdw(x.d)))}<td>${fmt(x.p)}<span class="tag">잠정</span></td><td>–</td><td>–</td><td>${lyCell(x.d)}</td><td>${vcell(x.v)}</td></tr>`));
    const wk = new Map();
    M.conf.filter((x) => x.t >= from).forEach((x) => {
      const k = ds(x.t - ((new Date(x.t).getDay() + 6) % 7) * DAY);
      if (!wk.has(k)) wk.set(k, { p: [], v: [], ly: [] });
      const o = wk.get(k); o.p.push(x.p); if (x.v != null) o.v.push(x.v);
      const l = M.lyMap.get(x.d); if (l != null) o.ly.push(l);
    });
    [...wk.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).forEach(([k, o]) => {
      hist.push(`<tr>${rowHead(`${esc(k.slice(2, 4))}/${esc(md(k))} 주`)}<td>${fmt(mean(o.p))}</td><td>–</td><td>–</td><td>${cell(mean(o.ly))}</td><td>${vcell(mean(o.v))}</td></tr>`);
    });
    groups.push([`지난 가격 (${rangeDays ? "최근 1년" : "전체"} 주 평균, 최근 주부터)`, hist]);
  }
  $("tableView").innerHTML = `<div class="table-scroll${weekly ? " tall" : ""}" tabindex="0" role="region" aria-label="${esc(M.name)} 가격 표"><table class="tbl">
    <caption>${esc(M.name)} 경락가와 예측 (원/kg).${weekly ? " 지난 가격과 반입량은 주 평균(반입량은 하루 평균)이에요." : ""}</caption>
    <thead><tr><th scope="col">날짜</th><th scope="col">실제(확정·잠정)</th><th scope="col">예측</th><th scope="col">예측 범위</th><th scope="col">작년 같은 때</th><th scope="col">반입량(t${weekly ? "/일" : ""})</th></tr></thead>
    ${groups.map(([title, rows]) => `<tbody><tr class="sec"><th colspan="6" scope="rowgroup">${title}</th></tr>${rows.join("")}</tbody>`).join("")}
  </table></div>`;
}

// 표로 보기 ↔ 그래프로 보기: 글자가 바뀌므로 aria-expanded는 쓰지 않는다(뜻이 엇갈림)
$("btnTable").addEventListener("click", () => {
  tableShown = !tableShown;
  $("btnTable").textContent = tableShown ? "그래프로 보기" : "표로 보기";
  $("chartWrap").hidden = tableShown;
  $("legend").hidden = tableShown;
  $("tableView").hidden = !tableShown;
  if (!DATA) return;
  const M = model(current);
  if (tableShown) renderTable(M);
  else renderChart(M);
});

function syncRangeButtons() {
  document.querySelectorAll("#rangeSeg button").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.days === rangeDays)));
}
document.querySelectorAll("#rangeSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    rangeDays = +b.dataset.days;
    syncRangeButtons();
    kbIdx = null;
    if (!DATA) return;
    const M = model(current);
    renderNotes(M);
    if (tableShown) renderTable(M);
    else renderChart(M);
  })
);
syncRangeButtons();

// ── 예측 성적표 ─────────────────────────────────────────
function modelName(key, withSub = true) {
  const n = MODEL_NAMES[key];
  if (!n) return esc(key);
  if (!withSub) return esc(n[0]);
  // 넓은 화면: 긴 이름 + (설명), 좁은 화면: 짧은 이름만. 이름은 줄바꿈하지 않는다
  return `<span class="nm nm-l">${esc(n[0])}</span><span class="nm nm-s">${esc(n[2] || n[0])}</span><span class="sub-n">(${esc(n[1])})</span>`;
}
function renderScore() {
  const bt = DATA.backtest;
  const mineKey = String(DATA.model || "").split(" ")[0];
  if (bt && bt.rows && bt.rows.length) {
    if (bt.n_origins) $("btTitle").textContent = `과거 ${bt.n_origins}개 기준일로 돌아가 다시 예측해 본 오차`;
    const fromTxt = bt.from ? `${bt.from.slice(0, 4)}년 ${+bt.from.slice(5, 7)}월` : "";
    const toTxt = bt.to ? `${bt.to.slice(0, 4)}년 ${+bt.to.slice(5, 7)}월` : "";
    $("btMeta").textContent = `숫자가 작을수록 정확해요. ${fromTxt && toTxt ? `${fromTxt}~${toTxt} 사이 ` : ""}${bt.n_origins}개 날짜, 5개 품목의 평균 오차율(%)이에요.`;
    // [열 키, 넓은 화면 머리, 좁은 화면 머리]
    const cols = [["1~3일", "1~3일 뒤", "1~3일"], ["4~10일", "4~10일 뒤", "4~10일"], ["2·3순", "2~5주 뒤<br>열흘 평균", "2~5주"], ["all", "전체", "전체"]];
    const best = Object.fromEntries(cols.map(([k]) => [k, Math.min(...bt.rows.map((r) => r[k]).filter((v) => v != null))]));
    const maxV = Math.max(...bt.rows.flatMap((r) => cols.slice(0, 3).map(([k]) => r[k])).filter((v) => v != null));
    $("btTable").innerHTML = `<thead><tr><th scope="col">방법</th>${cols.map(([, lab, short], i) => `<th scope="col"${i < 3 ? ` class="hb"` : ""}><span class="hl">${lab}</span><span class="hs">${short}</span></th>`).join("")}</tr></thead><tbody>` +
      bt.rows.map((r) => {
        const mine = r.model === mineKey;
        return `<tr class="${mine ? "mine" : ""}"><th scope="row" class="name">${modelName(r.model)}</th>` +
          cols.map(([k], i) => {
            const v = r[k];
            const bar = i < 3 && v != null ? `<span class="slot" aria-hidden="true"><span class="mbar" style="--w:${(v / maxV).toFixed(3)}"></span></span>` : "";
            const isBest = v != null && v === best[k];
            return `<td class="${isBest ? "best" : ""}">${v == null ? "–" : `${v.toFixed(1)}%`}${isBest ? `<span class="sr"> (가장 작음)</span>` : ""}${bar}</td>`;
          }).join("") + `</tr>`;
      }).join("") + `</tbody>`;

    // 한 줄 결론(데이터에서 계산)
    const mine = bt.rows.find((r) => r.model === mineKey);
    const naive = bt.rows.find((r) => r.model === "최근 가격 유지");
    let sum = "";
    if (mine) {
      const wins = cols.filter(([k]) => mine[k] != null && mine[k] === best[k]);
      const nm = `이 화면의 ${modelName(mineKey, false)} 모형은`;
      if (wins.length === cols.length) sum = `${nm} 세 기간과 전체 평균 모두에서 오차가 가장 작았어요 (전체 ${mine.all}%${naive ? `, ${modelName(naive.model, false)}는 ${naive.all}%` : ""}).`;
      else if (wins.length) sum = `${nm} ${wins.map(([, l]) => l.replace("<br>", " ")).join("·")}에서 오차가 가장 작았어요.`;
      else sum = `${nm} 아직 다른 방법보다 오차가 작지 않아요.`;
      sum += " 5개 품목 평균이라 품목마다 다를 수 있어요.";
    }
    $("btSum").hidden = !sum;
    $("btSum").innerHTML = sum;
    const ex = mine && mine.all != null ? ` 오차율 ${mine.all}%는 1,000원짜리를 평균 ${Math.round(mine.all * 10)}원쯤 틀렸다는 뜻이에요.` : "";
    // 깐마늘 자료 이상 월(하루걸러 크게 오르내린 달)이 오차표에 들어 있다는 사실. 이 백테스트(abl2_base, 기준일 72개)로
    // 2026-09-27에 다시 계산해 확인한 내용이라, 같은 백테스트일 때만 적는다(docs/model-experiments.md 2.1절)
    const garlic = bt.file === "abl2_base.csv" && bt.n_origins === 72 && !!DATA.items["깐마늘"];
    $("btGarlic").hidden = !garlic;
    $("btGarlic").textContent = garlic
      ? "깐마늘은 가격이 하루걸러 크게 오르내린 달(2025년 11·12월, 2026년 5~9월)도 이 표에 들어 있고, 이 달에는 '마지막 확정 가격 그대로'의 오차가 특히 커요. 이 달을 빼고 다시 계산하면 이 화면의 AI와 '마지막 확정 가격 그대로'의 전체 차이는 3.0%p에서 2.3%p로 줄지만, 방법 간 순위는 같았어요(2026년 9월 27일 계산)."
      : "";
    $("btNote").textContent = `평균 오차율은 예측이 실제 가격과 평균 몇 % 달랐는지예요.${ex} (단순 비교)는 AI 없이 누구나 할 수 있는 계산이라, 이보다 오차가 작아야 쓸모 있는 예측이에요. 열마다 가장 작은 값은 굵게 적었어요.`;
  } else {
    $("btMeta").textContent = "아직 과거 날짜로 다시 예측해 본 결과가 없어요.";
    $("btSum").hidden = true;
    $("btGarlic").hidden = true;
    $("btTable").innerHTML = "";
  }

  const sb = DATA.scoreboard;
  if (!sb || !sb.n) {
    // 빈 상태: 무엇이 채점될지(각 품목의 다음 거래일 예측)를 표 모양 그대로 먼저 보여 준다
    const names = ITEMS.filter((x) => DATA.items[x]);
    const tmr = mostCommon(names.map((x) => DATA.items[x].card.tomorrow_date));
    const first = tmr ? monthDay(addDays(tmr, 3)) : null;
    const jumpy = new Set(names.filter((x) => model(x).jumpy));
    $("live").innerHTML = `<p class="live-empty">아직 채점된 예측이 없어요. 아래 예측은 그날 가격이 확정되면(약 3일 뒤) 채점해요.${first ? ` 첫 채점은 ${esc(first)}쯤이에요.` : ""}</p>
      <div class="table-scroll"><table class="tbl" aria-labelledby="liveTitle"><thead><tr><th scope="col">품목</th><th scope="col">대상일</th><th scope="col">예측</th><th scope="col">실제</th></tr></thead><tbody>` +
      names.map((x) => {
        const c = DATA.items[x].card;
        return `<tr><th scope="row">${esc(x)}</th><td>${c.tomorrow_date ? esc(mdw(c.tomorrow_date)) : "–"}</td><td>${fmt(c.tomorrow)}${jumpy.has(x) ? `<span class="tag">참고용</span>` : ""}</td><td class="wait">채점 대기</td></tr>`;
      }).join("") +
      `</tbody></table></div><p class="note">그동안은 과거 날짜로 다시 예측해 본 오차표를 참고하세요.</p>`;
    return;
  }
  const hitTxt = sb.hit != null ? `이고, 실제 가격이 예측 범위 안에 든 비율은 ${esc(sb.hit)}%예요(목표 80%).` : "%예요.";
  // 대상일이 평소와 다른 날(추석 전날 같은 명절 무렵, 또는 반입량이 평소의 절반도 안 된 날)인 건은 표에 꼬리표를 달고 요약에서 밝힌다.
  // 탭·가격 상자·'왜' 카드가 이런 날을 비교에서 빼는 것과 말을 맞춘다(data.json은 그대로, 화면에서만 계산)
  const recent = sb.recent || [];
  const odd = recent.map((r) => oddTarget(r.item, r.target));
  const O = odd.filter(Boolean);
  let oddTxt = "";
  if (O.length) {
    const lowN = O.filter((o) => o.low).length;
    const hol = mostCommon(O.map((o) => o.hol));
    const days = [...new Set(recent.filter((r, i) => odd[i]).map((r) => r.target))];
    const allHol = O.every((o) => o.hol);
    // 한 날짜·한 명절이면 '추석 전날(9/24) 값이라', 아니면 '추석 전날처럼 거래가 아주 적은(평소와 다른) 날이라'
    const kind = days.length === 1 && allHol ? `${hol}(${md(days[0])}) 값`
      : `${hol ? `${hol}처럼 ` : ""}거래가 ${lowN === O.length ? "아주 적은" : "평소와 다른"} 날`;
    const who = recent.length < sb.n ? `최근 ${recent.length}건 중 ${O.length}건은`
      : O.length === sb.n ? `채점한 ${sb.n}건은 모두` : `채점한 ${sb.n}건 중 ${O.length}건은`;
    const lowTxt = !lowN || !allHol ? "" : lowN < O.length ? `(그중 ${lowN}건은 반입량이 평소의 절반도 안 됐어요)` : "(모두 반입량이 평소의 절반도 안 된 날이에요)";
    oddTxt = ` ${who} ${esc(kind)}이라 평소 성적과 다를 수 있어요${lowTxt}. 평소 성적은 위 오차표를 함께 보세요.`;
  }
  $("live").innerHTML = `<p class="live-sum">지금까지 ${esc(sb.n)}건을 채점했어요. 평균 오차율은 ${esc(sb.mape)}${sb.hit != null ? "%" : ""}${hitTxt}${oddTxt}</p>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="liveTitle"><table class="tbl"><thead><tr><th scope="col">품목</th><th scope="col">대상일</th><th scope="col">예측</th><th scope="col">실제</th><th scope="col">오차</th><th scope="col"><span class="hl">범위 안</span><span class="hs">범위</span></th></tr></thead><tbody>` +
    recent.slice(0, 12).map((r, i) => {
      const o = odd[i];
      const tag = o ? `<span class="tag">${esc([o.hol, o.low ? "거래 적음" : ""].filter(Boolean).join(" · "))}</span>` : "";
      return `<tr><th scope="row">${esc(r.item)}</th><td class="tgt">${esc(mdw(r.target))}${tag}</td><td>${fmt(r.pred)}</td><td>${fmt(r.actual)}</td><td>${r.err == null || !isFinite(r.err) ? "–" : `${Number(r.err).toFixed(1)}%`}</td>` +
        `<td>${r.hit ? `<span aria-hidden="true">○</span><span class="sr">들었음</span>` : `<span aria-hidden="true">×</span><span class="sr">벗어남</span>`}</td></tr>`;
    }).join("") +
    `</tbody></table></div><p class="note">범위 안: 실제 가격이 예측 범위 안에 들었으면 ○, 벗어났으면 ×.${O.length ? " 꼬리표는 대상일이 명절 무렵이거나 반입량이 평소(최근 30일 중간값)의 절반도 안 된 날이에요." : ""}</p>`;
}
// 채점 대상일이 평소와 다른 날인지: 명절 무렵(holidayName) 또는 반입량이 평소(model().vMed)의 절반 미만
function oddTarget(item, d) {
  if (!DATA.items[item] || !d) return null;
  const M = model(item);
  const hol = holidayName(d);
  const row = M.conf.find((x) => x.d === d) || M.provPts.find((x) => x.d === d);
  const low = !!(row && M.vMed && row.v != null && isFinite(row.v) && row.v < M.vMed / 2);
  return hol || low ? { hol, low } : null;
}

function renderFooter() {
  $("footMain").textContent = "예측은 과거 가격으로 만든 추정이에요. 날씨, 정부 수급 대책, 수입 물량 같은 돌발 요인으로 크게 달라질 수 있으니 거래 판단의 참고로만 쓰세요.";
  const modelShort = String(DATA.model || "–").replace(/\s*\(.*\)\s*$/, "");
  $("footSrc").textContent = `자료: 농넷 전국 공영도매시장 경락가(도매시장 경매에서 정해진 가격)·반입량(공개 화면). 예측 모형: ${modelShort}(예측 범위 10~90%). 추석·설은 달력 날짜, 김장철은 대략적인 시기예요.`;
}

// ── 화면 밝기(다크 모드): '밝게 | 어둡게' 두 칸 ─────────────────────
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : mqDark.matches;
}
function syncThemeButtons() {
  const d = isDark();
  document.querySelectorAll("#themeSeg button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.theme === "dark") === d)));
}
document.querySelectorAll("#themeSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    const next = b.dataset.theme;
    if ((next === "dark") === isDark() && document.documentElement.getAttribute("data-theme")) return;
    document.documentElement.setAttribute("data-theme", next);
    store.set("theme", next);
    syncThemeButtons();
    if (DATA && !tableShown) renderChart();
  })
);
mqDark.addEventListener("change", () => { syncThemeButtons(); if (DATA && !tableShown) renderChart(); });
syncThemeButtons();

// 크기 변화: 좁은/넓은 배치가 바뀌면 다시 그리고, 아니면 크기만 맞춘다
let resizeRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (!chart || !DATA || tableShown) return;
    if (layout().key !== lastLayoutKey) renderChart();
    else chart.resize();
  });
});

// ── 내 PC 앱(FastAPI)에서만 버튼이 보인다. 공유 페이지에는 api/ 가 없으므로 숨김 유지 ──
function lastText(last) { // "09-26 22:42"
  if (!last) return "";
  const m = /^(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(last);
  return m ? `${+m[1]}월 ${+m[2]}일 ${m[3]}` : last;
}
function showStatus(st) {
  // disabled 대신 aria-disabled: 방금 누른 버튼에서 키보드 초점이 빠지지 않게
  $("btnRefresh").setAttribute("aria-disabled", String(!!st.running));
  const shown = DATA && DATA.generated_at ? ` 화면은 ${stampText(DATA.generated_at)} 자료 그대로예요.` : "";
  let msg = "";
  if (st.running) msg = "최신 가격을 받고 다시 예측하는 중이에요(1~3분). 끝나면 화면이 저절로 바뀌어요.";
  else if (st.error) msg = `요청을 보내지 못했어요.${shown} 몇 분 뒤 다시 눌러 보세요.`;
  else if (st.last) msg = st.ok === false ? `가격을 받지 못했어요(${lastText(st.last)}).${shown} 몇 분 뒤 다시 눌러 보세요.` : `${lastText(st.last)}에 받았어요.`;
  $("status").textContent = msg;
}
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let st;
    try { st = await (await fetch("api/status", { cache: "no-store" })).json(); } catch (e) { return; }
    showStatus(st);
    if (!st.running) { clearInterval(pollTimer); load(); }
  }, 3000);
}
async function detectLocal() {
  // 공유 페이지에서는 요청하지 않는다(콘솔 404 방지). 내 PC 주소일 때만 api/status 성공 여부로 판단
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  // 다른 정적 서버(파이썬 http.server 등)로 띄운 경우도 요청하지 않는다. 머리글이 없으면 물어본다
  if (serverName && !/uvicorn/i.test(serverName)) return;
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    if (!r.ok) return;
    const st = await r.json();
    isLocal = true;
    $("local").hidden = false;
    if (DATA) renderHeader();
    showStatus(st);
    if (st.running) startPolling();
  } catch (e) { /* 공유 페이지 */ }
}
$("btnRefresh").addEventListener("click", async () => {
  if ($("btnRefresh").getAttribute("aria-disabled") === "true") return; // 받는 중에는 무시
  try {
    const r = await fetch("api/refresh", { method: "POST" });
    if (!r.ok) throw new Error(r.status);
  } catch (e) { showStatus({ error: true }); return; }
  showStatus({ running: true });
  startPolling();
});

load().then(detectLocal);
setInterval(load, 30 * 60 * 1000); // 30분마다 새 데이터 확인
