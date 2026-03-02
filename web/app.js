import init, { parse_pcap_to_diameter_json } from "../wasm/pkg/diameter_pcap_wasm.js";

const $ = (s) => document.querySelector(s);
const defaultAvps = [
  "Session-Id","Auth-Application-Id","Origin-Host","Origin-Realm","Destination-Host","Destination-Realm",
  "Origin-State-Id","CC-Request-Type","CC-Request-Number","Framed-IP-Address","Subscription-Id",
  "Subscription-Id-Type","Subscription-Id-Data","Bearer-Operation","IP-CAN-Type","Called-Station-Id","3GPP-MS-TimeZone"
];
$("#avpList").value = defaultAvps.join("\n");

let allMsgs = [];
let filtered = [];
let selected = -1;
let extractedRows = [];

function compileFilter(exprRaw){
  const expr = (exprRaw||"").trim();
  if (!expr) return () => true;
  const bin = expr.match(/^([\w.-]+)\s*(==|!=)\s*(.+)$/);
  if (!bin) return () => true;
  const left = bin[1].trim();
  const op = bin[2];
  const right = bin[3].trim().replace(/^['"]|['"]$/g, "");
  return (m) => {
    const v = String(evalLeft(left, m));
    return op === "==" ? v === right : v !== right;
  };
}

function evalLeft(left, m){
  if (left === "diameter.cmd.code") return m.cmd_code;
  const found = findFirstAvpByName(m.avps || [], left);
  return found ? (found.content ?? "") : "";
}

function findFirstAvpByName(avps, name){
  for (const a of avps){
    if (a.name === name) return a;
    if (a.children?.length){
      const x = findFirstAvpByName(a.children, name);
      if (x) return x;
    }
  }
  return null;
}

function renderList(){
  const box = $("#msgList");
  if (!filtered.length){
    box.innerHTML = `<div class="item"><b>无匹配</b></div>`;
    $("#treeView").textContent = "";
    $("#tblBody").innerHTML = "";
    return;
  }

  box.innerHTML = filtered.map((m,i)=>`
    <div class="item ${i===selected?"active":""}" data-i="${i}">
      <div><b>${escapeHtml(m.app_name || "-")} · ${escapeHtml(m.msg_type || "-")}</b></div>
      <div class="muted" style="font-size:12px">${escapeHtml(m.cmd_name)} #${m.cmd_code} · flags=${escapeHtml(m.flags)}</div>
    </div>
  `).join("");

  box.querySelectorAll(".item[data-i]").forEach(el=>{
    el.addEventListener("click", ()=>{
      selected = parseInt(el.dataset.i,10);
      renderList();
      renderTree();
    });
  });
}

function renderTree(){
  if (selected < 0) return;
  const m = filtered[selected];
  const lines = [];
  lines.push(`Diameter ${m.app_name || "-"} ${m.msg_type || "-"} cmd_code=${m.cmd_code} app_id=${m.app_id} flags=${m.flags}`);
  lines.push(`hop_by_hop=${m.hop_by_hop}`);
  lines.push(`end_to_end=${m.end_to_end}`);
  lines.push(`AVPs count=${(m.avps||[]).length}`);
  lines.push("");
  for (const a of (m.avps||[])) renderAvpNode(a, 0, lines);
  $("#treeView").textContent = lines.join("\n");
}

function renderAvpNode(a, depth, lines){
  const head = `${"  ".repeat(depth)}- ${a.name} [code=${a.code}${a.vendor_id!=null?`,v=${a.vendor_id}`:""}] flags=${a.flags}`;
  const val = a.content ? ` : ${a.content}` : "";
  lines.push(head + val);
  for (const c of (a.children || [])) renderAvpNode(c, depth+1, lines);
}

function extractRows(){
  const wanted = $("#avpList").value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const wantedSet = new Set(wanted);
  const rows = [];

  function walk(a, pathArr, idx, depth){
    const here = a.name || "";
    const newPath = pathArr.concat(here).filter(Boolean);
    const parentHit = pathArr.some(p => wantedSet.has(p));
    const hit = wantedSet.has(here) || parentHit;
    if (hit){
      rows.push({
        Index: idx,
        Path: newPath.join(" > "),
        "AVP Name": here,
        "AVP Content": a.content || "",
        "AVP Flags": a.flags || "",
        _depth: depth || 0,
      });
    }
    for (const c of (a.children||[])) walk(c, newPath, idx, (depth || 0) + 1);
  }

  filtered.forEach((m, idx) => (m.avps||[]).forEach(a => walk(a, [], idx, 0)));
  extractedRows = rows;

  const body = $("#tblBody");
  if (!rows.length){
    body.innerHTML = `<tr><td colspan="5" class="muted">无匹配 AVP</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(r=>`
    <tr>
      <td>${escapeHtml(String(r.Index))}</td>
      <td class="muted">${escapeHtml(r.Path)}</td>
      <td style="padding-left:${10 + (r._depth||0)*18}px">${escapeHtml(r["AVP Name"])}</td>
      <td>${escapeHtml(r["AVP Content"])}</td>
      <td>${escapeHtml(r["AVP Flags"])}</td>
    </tr>
  `).join("");
}

function setError(msg){
  $("#errBox").textContent = msg || "";
}

function applyFilter(){
  try {
    const fn = compileFilter($("#filterExpr").value);
    filtered = allMsgs.filter(fn);
    selected = filtered.length ? 0 : -1;
    $("#kpi").textContent = `总消息：${allMsgs.length}，过滤后：${filtered.length}`;
    renderList();
    if (selected >= 0) renderTree();
    extractRows();
    setError("");
  } catch (e) {
    setError(`过滤失败：${e?.message || e}`);
  }
}

$("#btnApply").addEventListener("click", applyFilter);

$("#btnExport").addEventListener("click", ()=>{
  try {
    if (!extractedRows.length) return alert("无可导出的数据");
    if (!window.XLSX) throw new Error("XLSX 未加载，请刷新页面重试");
    const wb = window.XLSX.utils.book_new();
    const sheet = window.XLSX.utils.json_to_sheet(extractedRows, { header: ["Index","Path","AVP Name","AVP Content","AVP Flags"] });
    window.XLSX.utils.book_append_sheet(wb, sheet, "Extracted AVPs");
    window.XLSX.writeFile(wb, `diameter_extract_${Date.now()}.xlsx`);
    setError("");
  } catch (e) {
    setError(`导出失败：${e?.message || e}`);
  }
});

$("#pcapFile").addEventListener("change", async (e)=>{
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    setError("");
    await init();
    const port = parseInt($("#tcpPort").value, 10) || 3868;
    const buf = new Uint8Array(await f.arrayBuffer());
    const parsed = parse_pcap_to_diameter_json(buf, port);
    if (!Array.isArray(parsed)) {
      throw new Error("WASM 返回结果异常（非数组）");
    }
    allMsgs = parsed;
    applyFilter();
  } catch (err) {
    allMsgs = [];
    filtered = [];
    selected = -1;
    renderList();
    $("#tblBody").innerHTML = "";
    $("#kpi").textContent = "总消息：0，过滤后：0";
    setError(`解析失败：${err?.message || err}`);
  }
});

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
