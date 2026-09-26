// 농산물 도매가격 예보 화면. data.json 하나만 읽는다(내 PC 앱·공유 페이지 공용).
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
const LY_SHIFT = 364;

const DAY = 864e5;
const WD = "일월화수목금토";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v == null || !isFinite(v) ? "–" : Math.round(v).toLocaleString("ko-KR"));
const ts = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const ds = (ms) => { const t = new Date(ms + 12 * 3600e3); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const addDays = (s, n) => ds(ts(s) + n * DAY);
const wd = (s) => WD[new Date(ts(s)).getDay()];
const isSun = (s) => new Date(ts(s)).getDay() === 0;
const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
const mdw = (s) => `${md(s)}(${wd(s)})`;
const longD = (s) => `${+s.slice(5, 7)}월 ${+s.slice(8, 10)}일(${wd(s)})`;
const monthDay = (s) => `${+s.slice(5, 7)}월 ${+s.slice(8, 10)}일`;
const median = (a) => { const b = a.filter((x) => isFinite(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
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
let current = store.get("item") || "배추";
// 휴대폰에서는 예측 구간이 눌리지 않게 6주로 시작한다
let rangeDays = window.matchMedia("(max-width: 600px)").matches ? 42 : 90;
let tableShown = false;
let chart = null;
let kbIdx = null;
let lastLayoutKey = "";
let pollTimer = null;
let isLocal = false;
const coarse = window.matchMedia("(pointer: coarse)").matches;

// ── 방향 표시(빨강▲ 파랑▼은 방향만 뜻한다). 색은 기호에만, 숫자는 청흑 ─────────────────
function dirHtml(v, { digits = 1, held = false } = {}) {
  if (v == null || !isFinite(v)) return `<span class="flat">–</span>`;
  const abs = digits ? Math.abs(v).toFixed(digits) : Math.round(Math.abs(v));
  if (held) return `<span class="held">${v > 0 ? "▲" : v < 0 ? "▼" : ""}${abs}%<span aria-hidden="true">※</span></span>`;
  if (v > 0) return `<span class="dirv"><span class="sr">오름 </span><span class="up" aria-hidden="true">▲</span>${abs}%</span>`;
  if (v < 0) return `<span class="dirv"><span class="sr">내림 </span><span class="down" aria-hidden="true">▼</span>${abs}%</span>`;
  return `<span class="flat">0%</span>`;
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
  const sun = (it.sun || []).filter((x) => x.q50 != null).map((x) => ({
    ...x, ly: s.d.length && addDays(x.start, -LY_SHIFT) >= s.d[0] ? lySeg(x.start, x.end) : x.ly,
    t0: ts(x.start), t1: ts(x.end) + DAY - 1,
    short: x.label.replace(/^\d+월\s*/, ""),
    range: `${md(x.start)}~${+x.end.slice(8, 10)}`,
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
  const lowVol = provPts.filter((x) => vMed && x.v != null && x.v < vMed / 2);
  const provOdd = provPts.map((x) => {
    const fx = fcByDate.get(x.d);
    const outside = !!fx && (x.p < fx.q10 || x.p > fx.q90);
    const chg = (x.p / last.p - 1) * 100;
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

  return { name, it, c, conf, provPts, last, closed, fcAll, fcDays, upcoming, tmr, ly, lyMap, lyDates, sun, w, g, swing, jumpy, lowVol, provOdd, vMed, byDate, xMin, xMax };
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
    data = await r.json();
  } catch (e) {
    if (!DATA) $("boardBody").innerHTML = `<p class="loading">자료를 불러오지 못했어요. 잠시 뒤 새로고침해 보세요.</p>`;
    return;
  }
  // 다시 그리기 전에 키보드 위치를 기억해 두고, 그린 뒤 되돌린다
  const ae = document.activeElement;
  const focusItem = ae && ae.classList && ae.classList.contains("brow") ? ae.dataset.item : null;
  const focusTable = ae && $("tableView").contains(ae);

  DATA = data;
  if (!ITEMS.includes(current) || !DATA.items[current]) current = ITEMS.find((x) => DATA.items[x]) || ITEMS[0];
  renderHeader();
  renderBoard();
  renderDetail(false);
  renderScore();
  renderFooter();

  if (focusItem) { const el = document.querySelector(`.brow[data-item="${CSS.escape(focusItem)}"]`); if (el) el.focus(); }
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

function renderHeader() {
  $("origin").textContent = DATA.origin ? longD(DATA.origin) : "–";
  $("generated").textContent = stampText(DATA.generated_at);
  const sl = sunLabels();
  $("sub").textContent = `배추·무·양파·깐마늘·건고추의 경락가(도매시장 경매에서 정해진 가격)를 전국 공영도매시장 평균으로 보여 주고, 앞으로 10일과 ${sl ? `${sl}의 열흘 평균` : "열흘 평균"} 가격을 예측해요.`;
  $("lgSun").textContent = sl ? `${sl} 평균(열흘)` : "열흘 평균 예측";
  const prov = DATA.provisional_from;
  $("basis").hidden = !DATA.origin;
  if (DATA.origin) $("basis").textContent = `${md(DATA.origin)}까지 확정된 가격으로 예측했어요.${prov ? ` ${md(prov)}부터는 아직 최종 집계 전인 잠정 가격이에요(보통 3일 안에 확정돼요).` : ""}`;
  const g = parseStamp(DATA.generated_at);
  const stale = g && Date.now() - g > 36 * 3600e3;
  $("stale").hidden = !stale;
  if (stale) {
    $("stale").textContent = isLocal
      ? "자료가 하루 넘게 지났어요. 「최신 가격 받고 다시 예측」을 눌러 주세요."
      : `${stampText(DATA.generated_at)} 자료예요. 그 뒤 가격은 아직 반영되지 않았어요.`;
  }
}

// ── 전광판 ─────────────────────────────────────────
function mostCommon(arr) {
  const m = new Map(); arr.forEach((x) => x && m.set(x, (m.get(x) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function sparkSvg(M) {
  const W = 120, H = 30, P = 3;
  const from = addDays(M.last.d, -30);
  const act = M.conf.filter((x) => x.d >= from);
  const fc = M.fcDays;
  const pts = [...act.map((x) => x.p), ...fc.map((x) => x.q10), ...fc.map((x) => x.q90)];
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const t0 = act.length ? act[0].t : M.last.t, t1 = fc.length ? fc[fc.length - 1].t : M.last.t;
  const X = (t) => (P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P)).toFixed(1);
  const Y = (v) => (H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * P)).toFixed(1);
  const line = (arr) => arr.map((q, i) => `${i ? "L" : "M"}${X(q[0])} ${Y(q[1])}`).join("");
  const band = fc.length
    ? `M${X(M.last.t)} ${Y(M.last.p)}` + fc.map((x) => `L${X(x.t)} ${Y(x.q90)}`).join("") + [...fc].reverse().map((x) => `L${X(x.t)} ${Y(x.q10)}`).join("") + "Z"
    : "";
  return `<svg${M.jumpy ? ` class="sp-jumpy"` : ""} viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path class="sp-band" d="${band}"/>
    <path class="sp-act" d="${line(act.map((x) => [x.t, x.p]))}"/>
    <path class="sp-fc" d="${line([[M.last.t, M.last.p], ...fc.map((x) => [x.t, x.q50])])}"/>
  </svg>`;
}

// 전광판 행 끝의 작은 도장. 주의(자료 점검 중·범위 넓음)만 호박색 + 느낌표
function stampSmall(M) {
  if (M.jumpy) return `<span class="stamp-s warn"><i class="ic" aria-hidden="true">!</i>자료 점검 중</span>`;
  if (M.g == null) return "";
  if (M.g === 2) return `<span class="stamp-s warn"><i class="ic" aria-hidden="true">!</i>넓음</span>`;
  return `<span class="stamp-s">${GRADES[M.g]}</span>`;
}
const gradeWord = (M) => (M.jumpy ? "자료 점검 중" : M.g == null ? "" : `범위 폭 ${GRADES[M.g]}`);

function renderBoard() {
  const models = ITEMS.filter((x) => DATA.items[x]).map(model);
  const lastD = mostCommon(models.map((m) => m.c.last_date));
  const tmrD = mostCommon(models.map((m) => m.tmr));
  $("boardHead").innerHTML = `
    <span class="h-name">품목</span>
    <span class="r">확정 경락가(원/kg)<span class="date">${lastD ? esc(mdw(lastD)) : ""}</span></span>
    <span class="r h-d1">전일</span>
    <span class="r h-d7">전주</span>
    <span class="h-spark">최근 30일과 예측</span>
    <span class="r fz fz0 h-next">다음 거래일 예측<span class="date">${tmrD ? esc(mdw(tmrD)) : ""}</span></span>
    <span class="r fz h-range">예측 범위(원/kg)</span>
    <span class="r fz h-stamp">범위 폭</span>`;

  const out = [];
  GROUPS.forEach((grp, gi) => {
    const ms = models.filter((m) => !!m.it.fresh === grp.fresh);
    if (!ms.length) return;
    const rows = ms.map((m) => {
      const c = m.c;
      const on = m.name === current;
      const label = [
        `${m.name}.`,
        `확정 경락가 ${fmt(c.last)}원(${c.last_date ? longD(c.last_date) : ""}).`,
        c.d1 != null ? `전일보다 ${pct1(c.d1)}% ${dirWord(c.d1)}${m.jumpy ? "(자료 점검 중)" : ""}.` : "",
        c.d7 != null ? `전주보다 ${pct1(c.d7)}% ${dirWord(c.d7)}.` : "",
        `${m.tmr ? longD(m.tmr) : "다음 거래일"} 예측 ${fmt(c.tomorrow)}원, 예측 범위 ${fmt(c.t10)}~${fmt(c.t90)}원.`,
        gradeWord(m) ? `${gradeWord(m)}.` : "",
      ].filter(Boolean).join(" ");
      return `<button type="button" class="brow${m.jumpy ? " jumpy" : ""}" data-item="${esc(m.name)}" aria-pressed="${on}" aria-label="${esc(label)}">
        <span class="c-name">${esc(m.name)}</span>
        <span class="c-last">${fmt(c.last)}${c.last_date && c.last_date !== lastD ? `<span class="rowdate">${esc(mdw(c.last_date))}</span>` : ""}</span>
        <span class="c-chg">
          <span class="c-d1"><span class="mlabel">전일</span>${dirHtml(c.d1, { held: m.jumpy })}</span>
          <span class="c-d7"><span class="mlabel">전주</span>${dirHtml(c.d7)}</span>
        </span>
        <span class="c-spark">${sparkSvg(m)}</span>
        <span class="c-next fz fz0">${fmt(c.tomorrow)}${m.tmr && m.tmr !== tmrD ? `<span class="rowdate">${esc(mdw(m.tmr))}</span>` : ""}<span class="nrange"><span class="nr-l">범위 </span>${fmt(c.t10)}~${fmt(c.t90)}</span></span>
        <span class="c-range fz">${fmt(c.t10)}~${fmt(c.t90)}</span>
        <span class="c-stamp fz">${stampSmall(m)}</span>
      </button>`;
    });
    out.push(`<div class="bgrp" role="group" aria-labelledby="g-${gi}">
      <div class="bgroup"><span class="gl"><span class="gn" id="g-${gi}">${esc(grp.name)}</span><span class="gd">${esc(grp.desc)}</span></span><span class="fz fz0" aria-hidden="true"></span></div>
      ${rows.join("")}
    </div>`);
  });
  $("boardBody").innerHTML = out.join("");
  // 마우스·터치(detail > 0)로 고르면 바뀐 전표로 스크롤, 키보드로 고르면 초점을 그대로 두고 소리로만 알린다
  $("boardBody").querySelectorAll(".brow").forEach((el) => el.addEventListener("click", (e) => selectItem(el.dataset.item, e.detail > 0 ? "pointer" : "key")));

  const wide = models.filter((m) => !m.jumpy && m.g === 2).map((m) => m.name);
  const jumpy = models.filter((m) => m.jumpy).map((m) => m.name);
  const lastOf = (a) => a[a.length - 1];
  $("boardFoot").innerHTML = `<p>품목을 누르면 아래 「앞으로의 가격」과 그래프가 그 품목으로 바뀌어요.</p>` +
    (wide.length ? `<p class="warn-line"><i class="ic" aria-hidden="true">!</i><span>${esc(wide.join("·"))}${josa(lastOf(wide), "은", "는")} 이번 예측 범위가 넓어 예측이 크게 빗나갈 수 있어요. 품목을 눌러 범위를 확인하고, 사거나 팔 양은 며칠에 나눠 정하세요.</span></p>` : "") +
    (jumpy.length ? `<p class="warn-line"><i class="ic" aria-hidden="true">!</i><span>${esc(jumpy.join("·"))}${josa(lastOf(jumpy), "은", "는")} 최근 가격이 하루걸러 크게 오르내려 자료를 점검하고 있어요. ※ 표시한 전일 대비와 예측값은 믿기 어려우니 전주 대비와 작년 같은 때 값을 보세요.</span></p>` : "");
}

function selectItem(name, how) {
  if (!DATA.items[name]) return;
  const changed = name !== current;
  current = name;
  store.set("item", current);
  document.querySelectorAll(".brow").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.item === current)));
  kbIdx = null;
  const M = renderDetail(changed);
  // 좁은 화면 + 마우스·터치: 바뀐 「앞으로의 가격」이 화면 밖이면 그쪽으로 옮긴다.
  // 키보드: 초점이 화면 밖으로 밀려나지 않게 스크롤하지 않고, 바뀐 내용을 한 줄로 알린다
  if (how === "pointer" && window.matchMedia("(max-width: 959px)").matches) {
    const slip = $("slip");
    const top = slip.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.5) slip.scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
  }
  if (how === "key" && M) {
    const grade = M.jumpy ? "자료 점검 중" : M.g == null ? "" : `범위 ${GRADES[M.g]}`;
    $("boardLive").textContent = `${M.name}${josaRo(M.name)} 바꿨어요. ${M.tmr ? md(M.tmr) : "다음 거래일"} 예측 ${fmt(M.c.tomorrow)}원${grade ? `, ${grade}` : ""}.`;
  }
}

// ── 상세(그래프 + 전표) ─────────────────────────────
function renderDetail(thump) {
  const M = model(current);
  $("itemName").textContent = current;
  renderSlip(M, thump);
  renderNotes(M);
  if (tableShown) renderTable(M);
  else renderChart(M);
  return M;
}

const halfPct = (M) => Math.round((M.w || 0) * 50);
function gradeSentence(M) {
  const c = M.c;
  if (M.w == null) return "";
  const day = M.tmr ? md(M.tmr) : "다음 거래일";
  if (M.jumpy) {
    return `${M.name}${josa(M.name, "은", "는")} 최근 가격이 하루는 높고 하루는 낮게 번갈아 나와요(하루 차이 약 ${Math.round(M.swing * 100)}%). 수집 자료에 문제가 있을 수 있어 이 화면의 예측은 믿기 어려워요. 전주 대비와 작년 같은 때 값을 함께 보세요.`;
  }
  if (M.g === 2) return `${day} 가격은 10번 중 8번은 ${fmt(c.t10)}~${fmt(c.t90)}원 사이일 것으로 봐요. 이보다 더 벗어날 수도 있어요. 사거나 팔 양이 많다면 한 번에 정하지 말고 며칠에 나눠 정하세요.`;
  if (M.g === 1) return `가운데 값에서 위아래로 약 ${halfPct(M)}% 안에서 오르내릴 수 있어요.`;
  return `범위가 좁은 편이에요. 가운데 값에서 위아래로 약 ${halfPct(M)}% 안이에요.`;
}

// 확정 경락가 대비(방향 색은 여기와 전일·전주에만 쓴다). 자료 점검 중이면 색·화살표 없이 '참고용'
function vsConf(M, v, full) {
  const r = (v / M.last.p - 1) * 100;
  const a = Math.round(Math.abs(r));
  const base = full ? `${md(M.last.d)} 확정 경락가 ${fmt(M.last.p)}원` : "확정 경락가";
  if (a < 1) return `${base}${josa(base, "과", "와")} 거의 같게 봐요${M.jumpy ? "(참고용)" : ""}`;
  if (M.jumpy) return `${base}보다 ${a}% ${r > 0 ? "높게" : "낮게"} 나왔지만 참고용이에요`;
  const cls = r > 0 ? "up" : "down";
  return `${base}보다 <span class="${cls}"><span aria-hidden="true">${r > 0 ? "▲" : "▼"}</span>${a}% ${r > 0 ? "높게" : "낮게"}</span> 봐요`;
}
// 작년 대비는 회색 보조 문구(색 화살표 없음)
function vsLy(v, ly, name) {
  if (ly == null) return `${name} 자료가 없어요.`;
  const r = v / ly - 1;
  if (Math.abs(r) < 0.03) return `${name} ${fmt(ly)}원과 비슷해요.`;
  return `${name} ${fmt(ly)}원보다는 ${r > 0 ? "높아요" : "낮아요"}.`;
}
// 앞으로의 흐름 한 줄(전표에서 가장 먼저 읽는 답). 자료 점검 중이면 방향을 말하지 않는다
function trendHtml(M) {
  if (M.jumpy) return `<p class="slip-sum">${esc(M.name)}${josa(M.name, "은", "는")} 자료를 점검하는 중이라 방향을 말하기 어려워요.</p>`;
  const base = M.last.p;
  const vals = [M.c.tomorrow, ...M.sun.map((s) => s.q50)].filter((v) => v != null && isFinite(v));
  if (!vals.length) return "";
  const dirs = vals.map((v) => { const r = v / base - 1; return r >= 0.03 ? 1 : r <= -0.03 ? -1 : 0; });
  const up = dirs.includes(1), down = dirs.includes(-1);
  const verb = up && down ? "오르내릴" : up ? "오를" : down ? "내릴" : "지금과 비슷할";
  const far = M.sun[M.sun.length - 1];
  const until = far ? `${far.label.endsWith("하순") ? far.label.replace(/하순$/, "말") : far.label}까지는` : "앞으로 열흘은";
  const path = far
    ? `${fmt(base)}원(${md(M.last.d)} 확정) → ${far.label} 평균 ${fmt(far.q50)}원`
    : `${fmt(base)}원(${md(M.last.d)} 확정) → ${M.tmr ? md(M.tmr) : "다음 거래일"} ${fmt(M.c.tomorrow)}원`;
  return `<p class="slip-sum">${esc(until)} ${verb} 것으로 봐요.<span class="path">${esc(path)}</span></p>`;
}

function renderSlip(M, thump) {
  const c = M.c;
  // 범위 막대: 다음 거래일·열흘 평균 두 개를 같은 가로 잣대에 둔다
  const rungs = [{ q10: c.t10, q50: c.tomorrow, q90: c.t90, ly: M.tmr ? M.lyMap.get(M.tmr) : null }, ...M.sun];
  const vals = rungs.flatMap((r) => [r.q10, r.q90, r.ly]).filter((v) => v != null && isFinite(v));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.06 || 1;
  const P = (v) => (((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2);
  const ladder = (r, lyName) => r.q10 == null || r.q90 == null ? "" : `
    <div class="ladder" aria-hidden="true">
      <span class="track"></span>
      <span class="bar" style="left:${P(r.q10)}%;width:${(P(r.q90) - P(r.q10)).toFixed(2)}%"></span>
      <span class="mid" style="left:${P(r.q50)}%"></span>
      ${r.ly != null ? `<span class="lyd" style="left:${P(r.ly)}%" title="${esc(lyName)}"></span>` : ""}
    </div>`;
  // 잣대 끝값은 첫 막대 위에 한 번만
  const scale = rungs.length > 1
    ? `<div class="ladder-scale" aria-hidden="true"><span>${fmt(lo)}원</span><span class="c">${["", "", "두", "세", "네"][rungs.length] || rungs.length} 막대는 같은 잣대</span><span>${fmt(hi)}원</span></div>`
    : "";

  const warn = M.jumpy || M.g === 2;
  const t = thump ? " thump" : "";
  const callout = M.w == null ? "" : `<div class="callout" role="note"><i class="ic" aria-hidden="true">!</i><p>${esc(gradeSentence(M))}</p></div>`;
  let gradeRow = "";
  if (M.g != null) {
    const ticks = GRADES.map((g, i) => {
      const on = !M.jumpy && i === M.g;
      return `<span class="tick${on ? ` on${i === 2 ? " warn" : ""}${t}` : ""}">${g}</span>`;
    }).join("");
    gradeRow = `
      <div class="grade" role="img" aria-label="${M.jumpy ? "자료 점검 중. 범위 폭 등급을 매기지 않았어요." : `범위 폭 ${GRADES[M.g]} (좁음, 보통, 넓음 중)`}">
        <span class="grade-label">범위 폭</span>
        <span class="scale">${ticks}</span>
        ${M.jumpy ? `<span class="stamp-x${t}">자료 점검 중</span>` : ""}
      </div>
      ${M.jumpy ? "" : warn ? callout : `<p class="grade-note">${esc(gradeSentence(M))}</p>`}`;
  }

  const sunCell = (s) => `<div class="cell">
      <div class="cell-label">${esc(s.label)} 평균 (${esc(s.range)})</div>
      <div class="sun-v${M.jumpy ? " dim" : ""}"><span class="n">${fmt(s.q50)}</span><span class="u">원/kg</span></div>
      <p class="vs-conf">${vsConf(M, s.q50, false)}</p>
      <p class="vs-ly">${esc(vsLy(s.q50, s.ly, "작년 같은 때(같은 순 평균)"))}</p>
      ${ladder(s, "작년 같은 때(같은 순 평균)")}
      <p class="range-t">예측 범위 ${fmt(s.q10)}~${fmt(s.q90)}원</p>
    </div>`;

  $("slip").classList.toggle("jumpy", !!M.jumpy);
  $("slip").innerHTML = `
    <h2 class="slip-title" id="slipTitle">${esc(M.name)} 앞으로의 가격</h2>
    ${M.jumpy ? callout : ""}
    ${trendHtml(M)}
    <div class="cell">
      <div class="cell-label">다음 거래일 ${M.tmr ? esc(longD(M.tmr)) : ""}</div>
      <div class="hero${M.jumpy ? " dim" : ""}"><span class="hero-n">${fmt(c.tomorrow)}</span><span class="hero-u">원/kg</span></div>
      <p class="vs-conf">${vsConf(M, c.tomorrow, true)}</p>
      <p class="vs-ly">${esc(vsLy(c.tomorrow, rungs[0].ly, "작년 같은 때"))}</p>
      ${scale}
      ${ladder(rungs[0], "작년 같은 때")}
      <p class="range-t">예측 범위 ${fmt(c.t10)}~${fmt(c.t90)}원</p>
      ${gradeRow}
    </div>
    ${M.sun.map(sunCell).join("")}
    <div class="ladder-key" aria-hidden="true">
      <span><i class="k k-dot"></i>예측 가운데 값</span>
      <span><i class="k k-lbar"></i>예측 범위</span>
      <span><i class="k k-lytick"></i>작년 같은 때</span>
    </div>`;
}

function renderNotes(M) {
  const notes = [];
  const chuseokClosed = M.fcAll.some((x) => M.closed.has(x.d));
  // 사실 하나는 한 곳에만: 예측 범위의 뜻(10번 중 8번)은 여기 한 줄에만 둔다
  notes.push(`<p><i class="k k-band"></i>예측 범위: 10번 중 8번은 실제 가격이 이 안에 들 것으로 본 구간이에요. 일요일${chuseokClosed ? "과 추석 당일·다음 날은 경매가 쉬어" : "은 경매가 없어"} 예측을 그리지 않았어요.</p>`);
  const { Y } = extents(M, windowFor(M));
  for (const x of M.provOdd) {
    const off = x.p < Y.min || x.p > Y.max;
    const offTxt = off ? ` 눈금 밖이라 그래프 ${x.p < Y.min ? "아래" : "위"} 끝에 ${x.p < Y.min ? "▼" : "▲"}로 표시했어요.` : "";
    if (x.low) {
      notes.push(`<p><i class="k k-prov"></i>${esc(md(x.d))} 잠정 ${fmt(x.p)}원은 ${x.hol ? `${esc(x.hol)}이라 ` : ""}시장에 들어온 양(반입량)이 ${fmt(x.v)}t으로 평소(${fmt(M.vMed)}t)의 절반도 안 되던 날 값이라 평소 시세와 다를 수 있어요.${offTxt}</p>`);
    } else {
      notes.push(`<p><i class="k k-prov"></i>${esc(md(x.d))} 잠정 ${fmt(x.p)}원은 ${esc(md(M.last.d))} 확정 경락가보다 ${Math.round(Math.abs(x.chg))}% ${x.chg < 0 ? "낮아요" : "높아요"}${x.hol ? `(${esc(x.hol)})` : ""}. 확정되면 바뀔 수 있어요.${offTxt}</p>`);
    }
  }
  if (M.jumpy) notes.push(`<p>※ 최근 값이 하루걸러 크게 오르내려 예측선도 톱니 모양이라, 예측은 흐리게 그렸어요.</p>`);
  $("chartNotes").innerHTML = notes.join("");
}

// ── 그래프 ─────────────────────────────────────────
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: g("--surface"), ink: g("--ink"), form: g("--form"), muted: g("--muted"), rule: g("--rule"), grid: g("--grid"),
    fc: g("--fc"), band: g("--band"), ly: g("--ly"), lyMark: g("--ly-mark"), vol: g("--vol"), boundary: g("--boundary"),
    pointer: g("--pointer"), font: g("--font"),
  };
}
// '#RRGGBB' + 투명도 → rgba()
function alpha(hex, a) {
  const h = String(hex).trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

// 전표 높이에서 그래프 판의 다른 부분(제목·범례·주석·여백)을 뺀 그래프 자리
function chartRoom() {
  if (!window.matchMedia("(min-width: 960px)").matches) return 0;
  const slip = $("slip"), panel = $("chart").closest(".chart-panel");
  if (!slip || !panel || !slip.offsetHeight) return 0;
  const box = (el) => { if (!el || el.hidden) return 0; const cs = getComputedStyle(el); return el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); };
  const cs = getComputedStyle(panel);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return slip.offsetHeight - pad - box(panel.querySelector(".panel-head")) - box($("legend")) - box($("chartNotes")) - 4 - 4; // 4: 그래프 margin-top, 4: 여유
}

function layout() {
  const w = $("chartWrap").clientWidth || 800;
  const narrow = w < 560;
  const L = { narrow, w, top: 30, left: narrow ? 46 : 56, right: narrow ? 10 : 18, priceH: narrow ? 240 : 290, stripH: 16, volH: narrow ? 54 : 60 };
  // 넓은 화면(그래프와 전표가 나란히)에서는 그래프 판 아래 끝이 전표와 맞도록 가격 그래프 높이를 늘린다
  const fixed = L.top + 6 + L.stripH + 24 + L.volH + 28;
  const avail = chartRoom();
  if (avail) L.priceH = Math.round(Math.min(520, Math.max(L.priceH, avail - fixed)));
  L.stripTop = L.top + L.priceH + 6;
  L.volTop = L.stripTop + L.stripH + 24;
  L.h = L.volTop + L.volH + 28;
  L.key = `${narrow}|${L.priceH}`;
  return L;
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

// 반입량: 보이는 기간이 길면 주·월 합계로 묶는다(바코드처럼 번쩍이지 않게)
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

// 세로축 범위는 확정·잠정·예측 범위·열흘 평균(작년 같은 순 포함)으로만 정한다.
// 작년 같은 때 선은 참고선이라 넣지 않는다(넘치면 그래프 위·아래 끝에서 잘린다)
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
  const priceH = L ? L.priceH : 300;
  const n = Math.max(4, Math.min(7, Math.round(priceH / 80)));
  const maxCells = Math.floor(priceH / 34);
  // 열흘 평균 블록의 이름표(두 줄, 약 34px)가 그림 안에 들어가게 자리를 남긴다.
  // 작년 표시가 가운데 값보다 위면 이름표는 막대 아래, 아니면 막대 위
  const tops = sunIn.filter((s) => !(s.ly != null && s.ly > s.q50)).map((s) => s.q90);
  const bots = sunIn.filter((s) => s.ly != null && s.ly > s.q50).map((s) => s.q10);
  const NEED = 36;
  let lo0 = lo - span * 0.03, hi0 = hi + span * 0.03, Y = null;
  for (let i = 0; i < 4; i++) {
    Y = niceScale(lo0, hi0, n, maxCells);
    const px = priceH / (Y.max - Y.min);
    let ok = true;
    if (tops.length && (Y.max - Math.max(...tops)) * px < NEED - 6) { hi0 = Math.max(...tops) + NEED / px; ok = false; }
    if (bots.length && (Math.min(...bots) - Y.min) * px < NEED - 6 && Y.min > 0) { lo0 = Math.min(...bots) - NEED / px; ok = false; }
    if (ok) break;
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
// 짧은 기간(130일 이하)은 매월 1일·15일에 눈금: '8/15, 9월, 9/15, 10월'
function tickValues(win) {
  if ((win.x1 - win.x0) / DAY > 130) return null;
  const out = [];
  const d = new Date(win.x0); d.setDate(1);
  while (d.getTime() <= win.x1) {
    for (const day of [1, 15]) {
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
        ...(s.ly != null ? [["k-lysun", `${fmt(s.ly)}${U}`, "작년 같은 때(같은 순 평균)"]] : []),
      ],
      notes: M.jumpy ? ["자료 점검 중이라 참고만 하세요."] : [],
    };
  }
  const rows = [], notes = [];
  if (r.act != null) rows.push(["k-line k-act", `${fmt(r.act)}${U}`, "확정 경락가"]);
  if (r.prov != null) rows.push(["k-prov", `${fmt(r.prov)}${U}`, "잠정"]);
  if (r.fc) {
    rows.push(["k-line k-fc", `${fmt(r.fc.q50)}${U}`, "예측(가운데 값)"]);
    rows.push(["k-tband", `${fmt(r.fc.q10)}~${fmt(r.fc.q90)}${U}`, "예측 범위"]);
  }
  if (ly != null) rows.push(["k-line k-ly", `${fmt(ly)}${U}`, "작년 같은 때"]);
  if (r.vol != null) rows.push(["k-tvol", `${fmt(r.vol)} t`, "반입량"]);
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
  const text = (x = {}) => ({ color: T.muted, fontFamily: T.font, fontSize: 12.5, fontWeight: 500, ...x });
  const halo = { textBorderColor: T.surface, textBorderWidth: 4 };
  const pxPerDay = (L.w - L.left - L.right) / Math.max(1, (win.x1 - win.x0) / DAY);
  const prov = M.provPts.map((x, i, a) => {
    const off = x.p < Y.min ? -1 : x.p > Y.max ? 1 : 0;
    const odd = M.provOdd.find((o) => o.d === x.d);
    // 그래프 안에는 '잠정 975'만. 이유(추석 전날·소량 거래)는 그래프 아래 주석(○)에 있다
    const txt = `잠정 ${fmt(x.p)}${off < 0 ? " ↓" : off > 0 ? " ↑" : ""}`;
    const roomRight = (win.x1 - x.t) / DAY * pxPerDay;
    const fitsRight = textW(txt, 12.5) + 6 <= roomRight;
    const show = !!odd || i === a.length - 1;
    // 라벨은 예측 쪽(오른쪽)에 붙인다: 그쪽은 옅은 범위 면뿐이라 선을 지우지 않는다.
    // 그림 아래쪽 15% 안이면 점 위로(달력 줄과 겹치지 않게), 오른쪽 자리가 모자라면 점 바로 위로
    const nearBottom = off < 0 || (x.p - Y.min) / Math.max(1, Y.max - Y.min) < 0.15;
    return {
      value: [x.t, off < 0 ? Y.min : off > 0 ? Y.max : x.p],
      symbol: off ? "triangle" : "circle", symbolRotate: off < 0 ? 180 : 0, symbolSize: off ? 10 : 8,
      itemStyle: off ? { color: T.muted, borderColor: T.surface, borderWidth: 1 } : { color: T.surface, borderColor: T.muted, borderWidth: 2 },
      label: show ? {
        show: true, position: fitsRight && !nearBottom ? "bottom" : "top", distance: 6,
        align: fitsRight ? "left" : "center", offset: [fitsRight ? -4 : 0, 0],
        formatter: txt, ...text(), ...halo,
      } : { show: false },
    };
  });
  // 반입량: 잠정(정산 전)은 모두 같은 흐린 막대. 거래가 적었던 잠정일은 막대 위에 잠정과 같은 빈 원 + 't' 라벨
  const vol = agg.rows.map((r) => ({ value: [r.t, r.v], itemStyle: r.prov ? { opacity: 0.45 } : undefined }));
  const low = new Set(M.lowVol.map((x) => x.d));
  const volMarks = agg.unit === "일"
    ? M.provPts.filter((x) => low.has(x.d) && x.v != null).map((x) => ({
      value: [x.t, x.v],
      label: { show: true, position: "top", distance: 3, formatter: `${fmt(x.v)}t`, ...text({ fontSize: 12 }), ...halo },
    }))
    : [];
  const hasProv = agg.rows.some((r) => r.prov);
  return {
    Y, V, prov, vol, volMarks,
    volTitle: agg.unit === "일" ? `반입량(t)${hasProv ? " · 흐린 막대는 잠정" : ""}` : `반입량(t/일, ${agg.unit} 평균)${hasProv ? " · 흐린 막대는 잠정 포함" : ""}`,
    ticks: tickValues(win),
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
    // 그래프 속 글자 조각(눈금·라벨)은 화면 낭독기에서 숨긴다. 같은 값은 그래프 이름표·알림·「표로 보기」에 있다
    const root = chart.getDom().firstElementChild;
    if (root) root.setAttribute("aria-hidden", "true");
  } else chart.resize();
  const win = windowFor(M);
  const D = dynamicParts(M, win, L, T);
  const text = (x = {}) => ({ color: T.muted, fontFamily: T.font, fontSize: 12.5, fontWeight: 500, ...x });
  const halo = { textBorderColor: T.surface, textBorderWidth: 4 };
  const last = M.last;
  const fcEnd = M.fcDays[M.fcDays.length - 1];
  const year = +DATA.origin.slice(0, 4);
  // 자료 점검 중(톱니 예측): 예측선·범위를 회색으로 흐리게 그려 전표의 '믿기 어려워요'와 말을 맞춘다
  const J = M.jumpy;
  const fcColor = J ? T.muted : T.fc;
  const bandColor = J ? T.grid : T.band;
  const edge = alpha(J ? T.muted : T.fc, J ? 0.3 : 0.35); // 예측 범위 가장자리 1px(시연 화면에서도 경계가 보이게)
  const sunEdge = alpha(J ? T.muted : T.fc, 0.45);

  const xAxis = [0, 1, 2].map((i) => ({
    type: "time", gridIndex: i, min: M.xMin, max: M.xMax,
    minInterval: D.minInterval,
    axisTick: { show: false }, splitLine: { show: false },
    axisLine: { show: i === 2, lineStyle: { color: T.rule } },
    axisPointer: { show: true, type: "line", snap: true, lineStyle: { color: T.pointer, width: 1, type: "solid" }, label: { show: false } },
    axisLabel: i === 2
      ? { ...text(), hideOverlap: true, margin: 8, customValues: D.ticks, formatter: (v) => tickLabel(v, M.xMax) }
      : { show: false },
  }));

  const plotW = L.w - L.left - L.right;
  const pxPerDay = plotW / Math.max(1, (win.x1 - win.x0) / DAY);

  // 달력 줄: 추석(올해 ●청흑, 작년 ●회색 — 회색은 화면 전체에서 '작년'), 김장철(대략 11/15~12/10, 해마다)
  const cal = [];
  let lyName = "";
  if (CHUSEOK[year - 1]) {
    const t = ts(addDays(CHUSEOK[year - 1], LY_SHIFT));
    const room = (win.x1 - t) / DAY * pxPerDay; // 오른쪽 자리에 맞춰 '작년 추석' → '작년' → (올해 라벨에 합침)
    lyName = room >= textW("작년 추석", 12) + 10 ? "작년 추석" : room >= textW("작년", 12) + 8 ? "작년" : "";
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

  // 기준선 라벨: 넓으면 '9/23까지 확정 · 9/24 잠정 · 9/28부터 예측', 좁으면 '9/23까지 확정'
  const pv = M.provPts;
  const provTxt = pv.length ? (pv.length === 1 ? md(pv[0].d) : `${md(pv[0].d)}~${md(pv[pv.length - 1].d)}`) : "";
  const bLabel = L.narrow ? `${md(last.d)}까지 확정`
    : `${md(last.d)}까지 확정${provTxt ? ` · ${provTxt} 잠정` : ""} · ${M.tmr ? `${md(M.tmr)}부터 예측` : "이후 예측"}`;
  const bRoom = (win.x1 - last.t) / DAY * pxPerDay; // 기준선 오른쪽 자리
  const fcLine = [[last.t, last.p], ...M.fcDays.map((x) => [x.t, x.q50])];
  const roomy = fcEnd && (fcEnd.t - last.t) / DAY * pxPerDay >= 56; // 예측 구간이 좁으면 끝 라벨은 전표에 맡긴다
  if (fcEnd) {
    // 끝 라벨: 오른쪽(첫 열흘 평균 블록 전까지)에 자리가 있으면 점의 오른쪽 위 — 예측선은 왼쪽에서 들어오므로 글자를 가로지르지 않는다.
    // 자리가 없으면 선이 들어오는 반대쪽(직전 점이 더 높으면 아래, 아니면 위)
    const endTxt = `${md(fcEnd.d)} ${fmt(fcEnd.q50)}`;
    const nextBlock = M.sun.length ? M.sun[0].t0 : M.xMax;
    const rightRoom = (nextBlock - fcEnd.t) / DAY * pxPerDay;
    const prevFc = M.fcDays.length > 1 ? M.fcDays[M.fcDays.length - 2].q50 : last.p;
    const endPos = rightRoom >= textW(endTxt, 12.5) + 8
      ? { position: "right", verticalAlign: "bottom", distance: 3, offset: [0, -3] }
      : { position: prevFc > fcEnd.q50 ? "bottom" : "top", distance: 8 };
    fcLine[fcLine.length - 1] = {
      value: [fcEnd.t, fcEnd.q50], symbol: "circle", symbolSize: 8,
      itemStyle: { color: fcColor, borderColor: T.surface, borderWidth: 2 },
      label: { show: roomy && !J, ...endPos, formatter: endTxt, ...text({ color: T.ink, fontWeight: 600 }), ...halo },
    };
  }
  // '작년 같은 때' 선: 작년 그날 거래가 없던 날(명절 연휴 등)이 이틀 넘게 이어지면 선을 끊는다.
  // 일요일 하루 틈은 확정 경락가 선처럼 건너뛰어 잇는다
  const lyData = [];
  let peak = -1, peakP = -Infinity;
  M.ly.forEach((x, i) => {
    const prev = M.ly[i - 1];
    if (prev && x.t - prev.t > 2 * DAY + 2 * 3600e3) lyData.push([prev.t + DAY, null]);
    lyData.push([x.t, x.p]);
    // 직접 라벨: 보이는 구간(기준일 전)에서 눈금 안에 있는 가장 높은 곳
    if (x.t >= win.x0 + 5 * DAY && x.t <= last.t - 7 * DAY && x.p <= D.Y.max && x.p > peakP) { peakP = x.p; peak = lyData.length - 1; }
  });
  if (peak >= 0) lyData[peak] = { value: lyData[peak], symbol: "circle", symbolSize: 1, itemStyle: { color: "transparent", borderWidth: 0 }, label: { show: true, position: "top", distance: 4, formatter: "작년 같은 때", ...text(), ...halo } };

  // '마지막 확정' 라벨: 선이 들어오는 반대쪽(직전이 더 높으면 왼쪽 아래, 아니면 왼쪽 위). 촘촘한 기간·좁은 화면에서는 뺀다(값은 전광판·전표에)
  const prevP = M.conf.length > 1 ? M.conf[M.conf.length - 2].p : last.p;
  const showLast = !L.narrow && pxPerDay >= 3;

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
        axisLabel: { ...text(), formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: T.grid, width: 1, type: "solid" } } },
      { type: "value", gridIndex: 1, min: -1, max: 1, show: false },
      { type: "value", gridIndex: 2, min: 0, max: D.V.max, interval: D.V.max, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { ...text({ fontSize: 12 }), formatter: (v) => fmt(v) }, splitLine: { show: false } },
    ],
    dataZoom: [{
      type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none", startValue: win.x0, endValue: win.x1,
      zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true, preventDefaultMouseMove: false,
      disabled: coarse, minValueSpan: 21 * DAY,
    }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis", confine: true, transitionDuration: 0, triggerOn: "mousemove|click",
      backgroundColor: T.surface, borderColor: T.form, borderWidth: 1, padding: [8, 10],
      textStyle: { color: T.ink, fontFamily: T.font, fontSize: 15 },
      extraCssText: "box-shadow:none;border-radius:3px;",
      // 툴팁은 포인터 반대편 위쪽 모서리에 고정: 세로 십자선이 날짜를 짚으니 따라다닐 필요가 없고, 주석·예측 구간을 가리지 않는다
      position: (point, params, dom, rect, size) => {
        const w = size.contentSize[0];
        const plotL = L.left, plotR = chart.getWidth() - L.right;
        const x = point[0] > (plotL + plotR) / 2 ? plotL + 8 : plotR - w - 8;
        return [Math.max(0, x), L.top + 4];
      },
      formatter: (ps) => tipHtml(M, ps),
    },
    graphic: [{ id: "volTitle", type: "text", left: L.left, top: L.volTop - 20, silent: true, style: { text: D.volTitle, fill: T.form, font: `500 12.5px ${T.font}` } }],
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
            { type: "rect", shape: { x: cx - rw / 2 + 0.5, y: yTop + 0.5, width: rw - 1, height: yBot - yTop - 1 }, style: { fill: bandColor, stroke: sunEdge, lineWidth: 1 } },
            { type: "line", shape: { x1: xa, y1: yMid, x2: xb, y2: yMid }, style: { stroke: fcColor, lineWidth: J ? 1.5 : 2 } },
          ];
          // 작년 같은 순: 빈 원(○ = 잠정 전용) 대신, 범례의 '작년 같은 때' 선과 같은 회색 가로줄
          const lyAbove = s.ly != null && s.ly > s.q50;
          if (s.ly != null) {
            const yl = api.coord([s.t0, s.ly])[1];
            kids.push({ type: "line", shape: { x1: xa + 2, y1: yl, x2: xb - 2, y2: yl }, style: { stroke: T.lyMark, lineWidth: 2 } });
          }
          // 라벨 모양은 모든 순 블록에 같게: 한 줄 → 두 줄 → 이름만 → 없음(값은 툴팁·전표·표에)
          const ws = M.sun.map((x) => api.coord([x.t1, x.q50])[0] - api.coord([x.t0, x.q50])[0] - 2);
          const fits = (f) => M.sun.every((x, i) => f(x) <= ws[i] + 4);
          const mode = fits((x) => textW(`${x.short} ${fmt(x.q50)}`, 12.5)) ? 1
            : fits((x) => Math.max(textW(x.short, 12.5), textW(fmt(x.q50), 12.5))) ? 2
            : fits((x) => textW(x.short, 12)) ? 3 : 0;
          const label = mode === 1 ? `${s.short} ${fmt(s.q50)}` : mode === 2 ? `${s.short}\n${fmt(s.q50)}` : mode === 3 ? s.short : null;
          if (label) {
            // 라벨은 늘 범위 막대에 붙이고, 작년 표시의 반대쪽에 단다(작년이 위면 막대 아래, 아니면 막대 위)
            kids.push({ type: "text", x: cx, y: lyAbove ? yBot + 5 : yTop - 5, style: {
              text: label, fill: J ? T.muted : T.ink, font: `600 ${label === s.short ? 12 : 12.5}px ${T.font}`, lineHeight: 15,
              align: "center", verticalAlign: lyAbove ? "top" : "bottom", stroke: T.surface, lineWidth: 4,
            } });
          }
          return { type: "group", children: kids };
        } },
      { name: "작년", type: "line", data: lyData, connectNulls: false, showSymbol: true, showAllSymbol: true, symbol: "none", lineStyle: { color: T.ly, width: 1 }, z: 3,
        labelLayout: { hideOverlap: true }, emphasis: { disabled: true } },
      { name: "확정", type: "line", data: M.conf.map((x) => [x.t, x.p]), showSymbol: false, symbol: "none",
        lineStyle: { color: T.ink, width: 2, cap: "round", join: "round" }, z: 4, emphasis: { disabled: true },
        markArea: kimjang.length ? { silent: true, itemStyle: { color: T.grid, opacity: 0.5 }, label: { show: false }, data: kimjang.map(([a, b]) => [{ xAxis: a.xAxis }, { xAxis: b.xAxis }]) } : undefined },
      { id: "prov", name: "잠정", type: "line", data: D.prov, showSymbol: true, lineStyle: { opacity: 0, width: 0 }, z: 5, emphasis: { disabled: true } },
      { name: "예측", type: "line", data: fcLine, symbol: "none", showSymbol: true,
        lineStyle: { color: fcColor, width: J ? 1.5 : 2, cap: "round", join: "round" }, z: 5, emphasis: { disabled: true },
        markLine: { symbol: "none", silent: true, animation: false,
          lineStyle: { color: T.boundary, width: 1, type: "solid" },
          label: { show: true, position: "end", formatter: bLabel, ...text(), distance: 6, ...(bRoom < textW(bLabel, 12.5) / 2 + 4 ? { align: "right", offset: [Math.max(0, bRoom - 2), 0] } : {}) },
          data: [{ xAxis: last.t }] },
        // 자료 점검 중이면 예측 구간 위에 직접 라벨
        markArea: J ? { silent: true, itemStyle: { color: "transparent" },
          label: { show: true, position: "insideTopLeft", distance: 6, formatter: "자료 점검 중 · 참고만", ...text({ color: T.ink, fontWeight: 600 }), ...halo },
          data: [[{ xAxis: last.t }, { xAxis: M.xMax }]] } : undefined },
      { name: "마지막 확정", type: "scatter", data: [[last.t, last.p]], symbolSize: 8, z: 6, silent: true,
        itemStyle: { color: T.ink, borderColor: T.surface, borderWidth: 2 },
        label: { show: showLast, position: prevP > last.p ? "bottom" : "top", align: "right", offset: [-3, 0], distance: 4, formatter: fmt(last.p), ...text({ color: T.ink, fontWeight: 600 }), ...halo } },
      { name: "달력", type: "scatter", xAxisIndex: 1, yAxisIndex: 1, data: cal, symbolSize: 8, clip: true, silent: true,
        label: { show: true, position: "right", distance: 5, formatter: "{b}", ...text({ fontSize: 12 }) },
        labelLayout: { hideOverlap: true },
        markArea: kimjang.length ? { silent: true, itemStyle: { color: T.rule }, label: { position: "right", distance: 4, ...text({ fontSize: 12 }) }, data: kimjang } : undefined },
      { id: "vol", name: "반입량", type: "bar", xAxisIndex: 2, yAxisIndex: 2, data: D.vol,
        barMaxWidth: 6, itemStyle: { color: T.vol, borderRadius: [2, 2, 0, 0] }, emphasis: { disabled: true }, large: false },
      { id: "volMark", name: "적은 반입량", type: "scatter", xAxisIndex: 2, yAxisIndex: 2, data: D.volMarks, symbol: "circle", symbolSize: 7, z: 4, silent: true,
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
      hist.push(`<tr>${rowHead(esc(mdw(x.d)))}<td>${fmt(x.p)}${prov ? `<span class="tag">잠정</span>` : ""}</td><td>–</td><td>–</td><td>${lyCell(x.d)}</td><td>${cell(x.v)}</td></tr>`);
    });
    groups.push([`지난 가격 (최근 ${rangeDays === 42 ? "6주" : "3개월"}, 최근 날짜부터)`, hist]);
  } else {
    M.provPts.slice().reverse().forEach((x) => hist.push(`<tr>${rowHead(esc(mdw(x.d)))}<td>${fmt(x.p)}<span class="tag">잠정</span></td><td>–</td><td>–</td><td>${lyCell(x.d)}</td><td>${cell(x.v)}</td></tr>`));
    const wk = new Map();
    M.conf.filter((x) => x.t >= from).forEach((x) => {
      const k = ds(x.t - ((new Date(x.t).getDay() + 6) % 7) * DAY);
      if (!wk.has(k)) wk.set(k, { p: [], v: [], ly: [] });
      const o = wk.get(k); o.p.push(x.p); if (x.v != null) o.v.push(x.v);
      const l = M.lyMap.get(x.d); if (l != null) o.ly.push(l);
    });
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    [...wk.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).forEach(([k, o]) => {
      hist.push(`<tr>${rowHead(`${esc(k.slice(2, 4))}/${esc(md(k))} 주`)}<td>${fmt(avg(o.p))}</td><td>–</td><td>–</td><td>${cell(avg(o.ly))}</td><td>${cell(avg(o.v))}</td></tr>`);
    });
    groups.push([`지난 가격 (${rangeDays ? "최근 1년" : "전체"} 주 평균, 최근 주부터)`, hist]);
  }
  $("tableView").innerHTML = `<div class="table-scroll${weekly ? " tall" : ""}" tabindex="0" role="region" aria-label="${esc(M.name)} 가격 표"><table class="tbl">
    <caption>${esc(M.name)} 경락가와 예측 (원/kg).${weekly ? " 지난 가격과 반입량은 주 평균(반입량은 하루 평균)이에요." : ""}</caption>
    <thead><tr><th scope="col">날짜</th><th scope="col">확정·잠정</th><th scope="col">예측</th><th scope="col">예측 범위</th><th scope="col">작년 같은 때</th><th scope="col">반입량(t${weekly ? "/일" : ""})</th></tr></thead>
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

// ── 성적표 ─────────────────────────────────────────
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
    $("btNote").textContent = `평균 오차율은 예측이 실제 가격과 평균 몇 % 달랐는지예요.${ex} (단순 비교)는 AI 없이 누구나 할 수 있는 계산이라, 이보다 오차가 작아야 쓸모 있는 예측이에요.`;
  } else {
    $("btMeta").textContent = "아직 과거 날짜로 다시 예측해 본 결과가 없어요.";
    $("btSum").hidden = true;
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
  $("live").innerHTML = `<p class="live-sum">지금까지 ${esc(sb.n)}건을 채점했어요. 평균 오차율은 ${esc(sb.mape)}${sb.hit != null ? "%" : ""}${hitTxt}</p>
    <div class="table-scroll" tabindex="0" role="region" aria-labelledby="liveTitle"><table class="tbl"><thead><tr><th scope="col">품목</th><th scope="col">대상일</th><th scope="col">예측</th><th scope="col">실제</th><th scope="col">오차</th><th scope="col">범위 안</th></tr></thead><tbody>` +
    sb.recent.slice(0, 12).map((r) => `<tr><th scope="row">${esc(r.item)}</th><td>${esc(mdw(r.target))}</td><td>${fmt(r.pred)}</td><td>${fmt(r.actual)}</td><td>${esc(r.err)}%</td>` +
      `<td>${r.hit ? `<span aria-hidden="true">○</span><span class="sr">들었음</span>` : `<span aria-hidden="true">×</span><span class="sr">벗어남</span>`}</td></tr>`).join("") +
    `</tbody></table></div><p class="note">범위 안: 실제 가격이 예측 범위 안에 들었으면 ○, 벗어났으면 ×.</p>`;
}

function renderFooter() {
  $("footMain").textContent = "예측은 과거 가격으로 만든 추정이에요. 날씨, 정부 수급 대책, 수입 물량 같은 돌발 요인으로 크게 달라질 수 있으니 거래 판단의 참고로만 쓰세요.";
  const modelShort = String(DATA.model || "–").replace(/\s*\(.*\)\s*$/, "");
  $("footSrc").textContent = `자료: 농넷 전국 공영도매시장 경락가(공개 화면). 예측 모형: ${modelShort}. 추석은 달력 날짜, 김장철은 대략적인 시기예요.`;
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
