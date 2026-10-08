// ===== 設定 =====
const STORAGE_KEY = "attendance-records-v2";
const OLD_KEY = "attendance-records-v1"; // 舊版（單一員工）資料，首次載入時會搬到第一位員工
// 想增減假別，直接改這個清單即可
const LEAVE_TYPES = ["特休", "事假", "病假", "生理假", "補休", "公假", "婚假", "喪假", "原民假"];
const DEFAULT_RATES = { 事假: 0, 病假: 0.5, 生理假: 0.5 }; // 沒列出的假別預設全薪
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 勞健保預設費率（115 年），可在「薪資設定」修改；單位：%
const DEFAULT_INS = { laborRate: 12.5, laborShare: 20, healthRate: 5.17, healthShare: 30 };
const MAX_DEPENDENTS = 3; // 健保眷屬最多計 3 口

// 薪資規則（可依公司規定調整）
const STD_HOURS = 8;       // 每日正常工時
const OT1_HOURS = 2;       // 前 2 小時
const OT1_RATE = 1.34;     // 前 2 小時加班倍率
const OT2_RATE = 1.67;     // 之後加班倍率
const MONTH_DAYS = 30;     // 日薪 = 月薪 ÷ 30
const MONTH_HOURS = 240;   // 時薪 = 月薪 ÷ 240

// ===== 資料存取 =====
// state = {
//   employees: [{id, name, salary, laborBase, healthBase, dependents}], currentId,
//   data: { 員工id: { "2026-10-08": { in, out, leave, unit, note } } },
//   adj: { 員工id: { "2026-10": { bonus, allowance } } }, // 每月全勤獎金、津貼
//   settings: { lunch: 60, rates: { 假別: 給薪比例 } }
// }
function newId() {
  return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && s.employees && s.employees.length) {
      s.data = s.data || {};
      s.adj = s.adj || {};
      s.settings = Object.assign({ lunch: 60 }, s.settings);
      s.settings.rates = Object.assign({}, DEFAULT_RATES, s.settings.rates);
      s.settings.ins = Object.assign({}, DEFAULT_INS, s.settings.ins);
      s.employees.forEach((e) => (s.data[e.id] = s.data[e.id] || {}));
      if (!s.data[s.currentId]) s.currentId = s.employees[0].id;
      return s;
    }
  } catch (e) { /* 讀不到就用預設值 */ }

  let old = {};
  try { old = JSON.parse(localStorage.getItem(OLD_KEY)) || {}; } catch (e) { /* 忽略 */ }
  const id = newId();
  return {
    employees: [{ id, name: "員工1", salary: 0 }],
    currentId: id,
    data: { [id]: old },
    adj: {},
    settings: { lunch: 60, rates: Object.assign({}, DEFAULT_RATES), ins: Object.assign({}, DEFAULT_INS) },
  };
}

function saveRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert("無法儲存資料，請確認瀏覽器沒有封鎖網站儲存功能。");
  }
}

const state = loadState();
let records = state.data[state.currentId]; // 目前員工的打卡紀錄

function currentEmp() {
  return state.employees.find((e) => e.id === state.currentId);
}

function setCurrent(id) {
  state.currentId = id;
  records = state.data[id];
  saveRecords();
  render();
}

// ===== 小工具 =====
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const money = (n) => "NT$ " + Math.round(n).toLocaleString("zh-TW");

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeNow() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 實際工時（小時，數字）；超過 5 小時才扣午休
function netHours(rec) {
  if (!rec || !rec.in || !rec.out) return null;
  const [h1, m1] = rec.in.split(":").map(Number);
  const [h2, m2] = rec.out.split(":").map(Number);
  let mins = h2 * 60 + m2 - (h1 * 60 + m1);
  if (mins < 0) return null;
  if (mins > 300) mins -= Number(state.settings.lunch) || 0;
  return Math.max(0, mins) / 60;
}

function workHours(rec) {
  const h = netHours(rec);
  return h === null ? "" : h.toFixed(1);
}

function rateOf(type) {
  const r = state.settings.rates[type];
  return r === undefined ? 1 : r;
}

function rateLabel(r) {
  if (r === 0) return "不給薪";
  if (r === 1) return "全薪";
  return `${Math.round(r * 100)}% 薪`;
}

function isEmpty(rec) {
  return !rec.in && !rec.out && !rec.leave && !rec.note;
}

// ===== 薪資計算 =====
function getAdj(empId, month) {
  const a = (state.adj[empId] || {})[month] || {};
  return { bonus: Number(a.bonus) || 0, allowance: Number(a.allowance) || 0 };
}

function setAdj(field, value) {
  const id = state.currentId;
  const month = $("monthPicker").value;
  state.adj[id] = state.adj[id] || {};
  state.adj[id][month] = Object.assign({}, state.adj[id][month], { [field]: Math.max(0, Number(value) || 0) });
  saveRecords();
  renderPay();
}

// 切換員工或月份時，把已存的金額填回輸入欄
function syncAdjInputs() {
  const a = getAdj(state.currentId, $("monthPicker").value);
  $("inBonus").value = a.bonus || "";
  $("inAllow").value = a.allowance || "";
}

function calcPay(emp, recs, month) {
  const { bonus, allowance } = getAdj(emp.id, month);
  const salary = Number(emp.salary) || 0;
  const daily = salary / MONTH_DAYS;
  const hourly = salary / MONTH_HOURS;

  let workDays = 0, totalHours = 0, otHours = 0, otPay = 0;
  const leaves = {}; // 假別 -> { days, amount }
  let deduct = 0;

  Object.entries(recs).forEach(([key, rec]) => {
    if (!key.startsWith(month)) return;
    const dow = new Date(key + "T00:00:00").getDay();
    const weekend = dow === 0 || dow === 6;

    const h = netHours(rec);
    if (h !== null) {
      workDays += 1;
      totalHours += h;
      const ot = weekend ? h : Math.max(0, h - STD_HOURS);
      otHours += ot;
      otPay += hourly * (Math.min(ot, OT1_HOURS) * OT1_RATE + Math.max(ot - OT1_HOURS, 0) * OT2_RATE);
    }

    // 週末請假不影響月薪，不計扣薪
    if (rec.leave && !weekend) {
      const days = Number(rec.unit) || 1;
      const amount = days * daily * (1 - rateOf(rec.leave));
      leaves[rec.leave] = leaves[rec.leave] || { days: 0, amount: 0 };
      leaves[rec.leave].days += days;
      leaves[rec.leave].amount += amount;
      deduct += amount;
    }
  });

  // 勞健保自付額：各自四捨五入到整數（健保眷屬逐口計算）
  const ins = state.settings.ins;
  const laborFee = Math.round((Number(emp.laborBase) || 0) * (ins.laborRate / 100) * (ins.laborShare / 100));
  const people = 1 + Math.min(Math.max(Number(emp.dependents) || 0, 0), MAX_DEPENDENTS);
  const healthFee =
    Math.round((Number(emp.healthBase) || 0) * (ins.healthRate / 100) * (ins.healthShare / 100)) * people;

  const net = salary + bonus + allowance + otPay - deduct;
  return {
    salary, daily, hourly, workDays, totalHours, otHours, otPay, leaves, deduct, bonus, allowance,
    laborFee, healthFee, people, net,
    takeHome: net - laborFee - healthFee,
  };
}

function renderPay() {
  const emp = currentEmp();
  const month = $("monthPicker").value;
  $("payTitle").textContent = `${month.replace("-", " 年 ")} 月薪資試算 — ${emp.name}`;

  const tbody = $("payTable").querySelector("tbody");
  tbody.innerHTML = "";

  if (!Number(emp.salary)) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "notice";
    td.textContent = "尚未設定月薪，請按上方「管理員工」輸入。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const p = calcPay(emp, records, month);
  const addRow = (label, value, cls) => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    const a = document.createElement("td");
    const b = document.createElement("td");
    a.textContent = label;
    b.textContent = value;
    b.className = "num";
    if (cls === "minus-row") b.classList.add("minus");
    tr.append(a, b);
    tbody.appendChild(tr);
  };

  addRow("月薪（底薪）", money(p.salary));
  addRow(`出勤 ${p.workDays} 天，總工時 ${p.totalHours.toFixed(1)} 小時`, "", "pay-sub");
  addRow(`加班費（加班 ${p.otHours.toFixed(1)} 小時）`, "+ " + money(p.otPay));
  addRow("全勤獎金", "+ " + money(p.bonus));
  addRow("津貼", "+ " + money(p.allowance));
  addRow("請假扣薪", "- " + money(p.deduct), "minus-row");
  Object.entries(p.leaves).forEach(([type, l]) => {
    addRow(`${type} ${l.days} 天（${rateLabel(rateOf(type))}）`, l.amount > 0 ? "- " + money(l.amount) : "", "pay-sub");
  });
  addRow("應發合計", money(p.net), "pay-gross");
  addRow("勞保自付額", "- " + money(p.laborFee), "minus-row");
  addRow(`健保自付額（本人＋眷屬共 ${p.people} 口）`, "- " + money(p.healthFee), "minus-row");
  if (!Number(emp.laborBase) && !Number(emp.healthBase)) {
    addRow("尚未設定投保金額，請到「管理員工」輸入", "", "pay-sub");
  }
  addRow("預估實領", money(p.takeHome), "pay-total");
}

function exportPayCsv() {
  const month = $("monthPicker").value;
  const rows = [["員工", "月薪", "日薪", "時薪", "出勤天數", "總工時", "加班時數", "加班費", "全勤獎金", "津貼", "請假扣薪", "應發合計", "勞保自付", "健保自付", "預估實領"]];
  state.employees.forEach((e) => {
    const p = calcPay(e, state.data[e.id], month);
    rows.push([
      e.name, Math.round(p.salary), Math.round(p.daily), Math.round(p.hourly),
      p.workDays, p.totalHours.toFixed(1), p.otHours.toFixed(1),
      Math.round(p.otPay), p.bonus, p.allowance, Math.round(p.deduct), Math.round(p.net),
      p.laborFee, p.healthFee, Math.round(p.takeHome),
    ]);
  });
  downloadCsv(rows, `薪資_${month}.csv`);
}

// ===== 今日打卡 =====
function updateClock() {
  const d = new Date();
  $("clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $("todayDate").textContent =
    `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（週${WEEK[d.getDay()]}）`;
}

function refreshToday() {
  const rec = records[dateKey(new Date())] || {};
  $("btnIn").disabled = !!rec.in;
  $("btnOut").disabled = !rec.in || !!rec.out;

  let text = "今天還沒打卡";
  if (rec.in && !rec.out) text = `上班 ${rec.in}，下班尚未打卡`;
  if (rec.in && rec.out) text = `上班 ${rec.in}　下班 ${rec.out}　工時 ${workHours(rec) || "-"} 小時`;
  if (!rec.in && rec.leave) text = `今天請假：${rec.leave}`;
  $("todayStatus").textContent = text;
}

function punch(field) {
  const key = dateKey(new Date());
  const rec = records[key] || {};
  rec[field] = timeNow();
  records[key] = rec;
  saveRecords();
  render();
}

// ===== 假別統計 =====
function fillYearOptions() {
  const years = new Set([new Date().getFullYear()]);
  Object.keys(records).forEach((k) => years.add(Number(k.slice(0, 4))));
  const current = $("statYear").value;
  $("statYear").innerHTML = [...years]
    .sort((a, b) => b - a)
    .map((y) => `<option value="${y}">${y}</option>`)
    .join("");
  if (current && years.has(Number(current))) $("statYear").value = current;
}

function renderStats() {
  const year = $("statYear").value;
  const stats = {};
  LEAVE_TYPES.forEach((t) => (stats[t] = { count: 0, days: 0 }));

  Object.entries(records).forEach(([key, rec]) => {
    if (!key.startsWith(year) || !rec.leave) return;
    if (!stats[rec.leave]) stats[rec.leave] = { count: 0, days: 0 };
    stats[rec.leave].count += 1;
    stats[rec.leave].days += Number(rec.unit) || 1;
  });

  let totalCount = 0;
  let totalDays = 0;
  $("leaveStats").querySelector("tbody").innerHTML = Object.entries(stats)
    .map(([type, s]) => {
      totalCount += s.count;
      totalDays += s.days;
      return `<tr><td>${type}</td><td class="num">${s.count}</td><td class="num">${s.days}</td></tr>`;
    })
    .join("");
  $("leaveStats").querySelector("tfoot").innerHTML =
    `<tr><td>合計</td><td class="num">${totalCount}</td><td class="num">${totalDays}</td></tr>`;
}

// ===== 月紀錄 =====
function renderTable() {
  const month = $("monthPicker").value;
  const keys = Object.keys(records)
    .filter((k) => k.startsWith(month))
    .sort();

  const tbody = $("recordTable").querySelector("tbody");
  tbody.innerHTML = "";

  keys.forEach((key) => {
    const rec = records[key];
    const d = new Date(key + "T00:00:00");
    const tr = document.createElement("tr");
    if (d.getDay() === 0 || d.getDay() === 6) tr.className = "weekend";

    const leaveText = rec.leave ? `${rec.leave}（${Number(rec.unit) === 0.5 ? "半天" : "全天"}）` : "";
    const cells = [
      `${key.slice(5)}（${WEEK[d.getDay()]}）`,
      rec.in || "",
      rec.out || "",
      workHours(rec),
      leaveText,
      rec.note || "",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text; // 用 textContent 避免備註內容被當成 HTML
      if (i === 3) td.className = "num";
      if (i === 5) td.className = "note";
      tr.appendChild(td);
    });

    const act = document.createElement("td");
    const edit = document.createElement("button");
    edit.className = "btn-link";
    edit.textContent = "編輯";
    edit.onclick = () => openDialog(key);
    const del = document.createElement("button");
    del.className = "btn-link danger";
    del.textContent = "刪除";
    del.onclick = () => {
      if (confirm(`確定要刪除 ${key} 的紀錄嗎？`)) {
        delete records[key];
        saveRecords();
        render();
      }
    };
    act.append(edit, del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });

  $("emptyMsg").hidden = keys.length > 0;
}

function renderEmpSelect() {
  const sel = $("empSelect");
  sel.innerHTML = "";
  state.employees.forEach((e) => {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.name;
    sel.appendChild(o);
  });
  sel.value = state.currentId;
}

function render() {
  renderEmpSelect();
  fillYearOptions();
  refreshToday();
  syncAdjInputs();
  renderPay();
  renderStats();
  renderTable();
}

// ===== 新增／編輯打卡對話框 =====
function openDialog(key) {
  const rec = (key && records[key]) || {};
  $("editDialog").dataset.editing = key ? "1" : "";
  $("dialogTitle").textContent = key ? "編輯紀錄" : "補登／請假";
  $("fDate").value = key || dateKey(new Date());
  $("fIn").value = rec.in || "";
  $("fOut").value = rec.out || "";
  $("fLeave").value = rec.leave || "";
  $("fUnit").value = String(rec.unit || 1);
  $("fNote").value = rec.note || "";
  $("editDialog").showModal();
}

function saveDialog(e) {
  e.preventDefault();
  const key = $("fDate").value;
  if (!key) return;

  if (records[key] && !$("editDialog").dataset.editing) {
    // 補登到已有紀錄的日期時，先確認是否覆蓋
    if (!confirm(`${key} 已經有紀錄，要覆蓋嗎？`)) return;
  }

  const rec = {
    in: $("fIn").value,
    out: $("fOut").value,
    leave: $("fLeave").value,
    unit: Number($("fUnit").value),
    note: $("fNote").value.trim(),
  };

  if (rec.in && rec.out && rec.out < rec.in) {
    alert("下班時間不能早於上班時間。");
    return;
  }

  if (isEmpty(rec)) {
    delete records[key];
  } else {
    records[key] = rec;
  }
  saveRecords();
  $("editDialog").close();
  $("monthPicker").value = key.slice(0, 7);
  render();
}

// ===== 員工管理對話框 =====
let draft = []; // 編輯中的員工清單（按儲存才會生效）

function renderEmpRows() {
  const box = $("empRows");
  box.innerHTML = "";
  draft.forEach((emp, i) => {
    const row = document.createElement("div");
    row.className = "emp-row";

    // 產生「標籤 + 輸入框」；number 欄位寫回 draft 時一律轉成數字
    const field = (labelText, key, opts) => {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      Object.assign(input, opts);
      input.value = opts.type === "number" ? emp[key] || "" : emp[key];
      input.oninput = () => (emp[key] = opts.type === "number" ? Number(input.value) || 0 : input.value);
      label.appendChild(input);
      return label;
    };

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-link danger";
    del.textContent = "刪除此員工";
    del.onclick = () => {
      if (draft.length === 1) return alert("至少要保留一位員工。");
      draft.splice(i, 1);
      renderEmpRows();
    };

    row.append(
      field("姓名", "name", { type: "text", maxLength: 20 }),
      field("月薪", "salary", { type: "number", min: 0, step: 100 }),
      field("勞保投保薪資", "laborBase", { type: "number", min: 0, step: 100 }),
      field("健保投保金額", "healthBase", { type: "number", min: 0, step: 100 }),
      field("健保眷屬人數（最多計 3 口）", "dependents", { type: "number", min: 0, max: 20, step: 1 }),
      del,
    );
    box.appendChild(row);
  });
}

function openEmpDialog() {
  draft = state.employees.map((e) => ({ ...e }));
  renderEmpRows();
  $("empDialog").showModal();
}

function saveEmpDialog(e) {
  e.preventDefault();
  if (draft.some((d) => !d.name.trim())) return alert("員工姓名不能空白。");

  const keepIds = new Set(draft.map((d) => d.id));
  const removed = state.employees.filter((x) => !keepIds.has(x.id));
  if (removed.length &&
      !confirm(`將刪除 ${removed.map((x) => x.name).join("、")} 及其所有打卡紀錄，確定嗎？`)) return;

  removed.forEach((x) => {
    delete state.data[x.id];
    delete state.adj[x.id];
  });
  state.employees = draft.map((d) => ({
    id: d.id,
    name: d.name.trim(),
    salary: d.salary,
    laborBase: d.laborBase,
    healthBase: d.healthBase,
    dependents: Math.floor(d.dependents) || 0,
  }));
  state.employees.forEach((x) => (state.data[x.id] = state.data[x.id] || {}));
  if (!keepIds.has(state.currentId)) state.currentId = state.employees[0].id;
  records = state.data[state.currentId];

  saveRecords();
  $("empDialog").close();
  render();
}

// ===== 薪資設定對話框 =====
function openSetDialog() {
  $("sLunch").value = state.settings.lunch;
  const ins = state.settings.ins;
  $("sLaborRate").value = ins.laborRate;
  $("sLaborShare").value = ins.laborShare;
  $("sHealthRate").value = ins.healthRate;
  $("sHealthShare").value = ins.healthShare;
  const box = $("rateRows");
  box.innerHTML = "";
  LEAVE_TYPES.forEach((type) => {
    const row = document.createElement("div");
    row.className = "rate-row";
    const label = document.createElement("span");
    label.textContent = type;
    const sel = document.createElement("select");
    sel.dataset.type = type;
    [["1", "全薪"], ["0.5", "半薪"], ["0", "不給薪"]].forEach(([v, t]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    });
    sel.value = String(rateOf(type));
    row.append(label, sel);
    box.appendChild(row);
  });
  $("setDialog").showModal();
}

function saveSetDialog(e) {
  e.preventDefault();
  state.settings.lunch = Math.max(0, Number($("sLunch").value) || 0);
  const pct = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback;
  };
  state.settings.ins = {
    laborRate: pct("sLaborRate", DEFAULT_INS.laborRate),
    laborShare: pct("sLaborShare", DEFAULT_INS.laborShare),
    healthRate: pct("sHealthRate", DEFAULT_INS.healthRate),
    healthShare: pct("sHealthShare", DEFAULT_INS.healthShare),
  };
  $("rateRows").querySelectorAll("select").forEach((sel) => {
    state.settings.rates[sel.dataset.type] = Number(sel.value);
  });
  saveRecords();
  $("setDialog").close();
  render();
}

// ===== 匯出 CSV =====
function csvCell(v) {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(rows, filename) {
  // 開頭加 BOM，Excel 才不會把中文顯示成亂碼
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const keys = Object.keys(records).sort();
  if (keys.length === 0) {
    alert("目前沒有可匯出的紀錄。");
    return;
  }
  const rows = [["日期", "星期", "上班", "下班", "工時(小時)", "假別", "請假長度", "備註"]];
  keys.forEach((key) => {
    const rec = records[key];
    const d = new Date(key + "T00:00:00");
    rows.push([
      key,
      "週" + WEEK[d.getDay()],
      rec.in || "",
      rec.out || "",
      workHours(rec),
      rec.leave || "",
      rec.leave ? (Number(rec.unit) === 0.5 ? "半天" : "全天") : "",
      rec.note || "",
    ]);
  });
  downloadCsv(rows, `打卡紀錄_${currentEmp().name}_${dateKey(new Date())}.csv`);
}

// ===== 初始化 =====
function init() {
  $("fLeave").innerHTML =
    `<option value="">無</option>` + LEAVE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");

  const now = new Date();
  $("monthPicker").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  $("btnIn").onclick = () => punch("in");
  $("btnOut").onclick = () => punch("out");
  $("btnAdd").onclick = () => openDialog();
  $("btnExport").onclick = exportCsv;
  $("btnCancel").onclick = () => $("editDialog").close();
  $("editForm").onsubmit = saveDialog;

  $("empSelect").onchange = () => setCurrent($("empSelect").value);
  $("btnEmp").onclick = openEmpDialog;
  $("btnEmpAdd").onclick = () => {
    draft.push({ id: newId(), name: "", salary: 0, laborBase: 0, healthBase: 0, dependents: 0 });
    renderEmpRows();
  };
  $("btnEmpCancel").onclick = () => $("empDialog").close();
  $("empForm").onsubmit = saveEmpDialog;

  $("btnSettings").onclick = openSetDialog;
  $("btnSetCancel").onclick = () => $("setDialog").close();
  $("setForm").onsubmit = saveSetDialog;
  $("btnPayCsv").onclick = exportPayCsv;

  $("monthPicker").onchange = () => { syncAdjInputs(); renderPay(); renderTable(); };
  $("inBonus").oninput = () => setAdj("bonus", $("inBonus").value);
  $("inAllow").oninput = () => setAdj("allowance", $("inAllow").value);
  $("statYear").onchange = renderStats;

  updateClock();
  setInterval(updateClock, 1000);
  render();
}

init();
