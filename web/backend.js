const $ = (s) => document.querySelector(s);

function getBase() {
  const v = $("#apiBase")?.value?.trim();
  return (v ? v : window.location.origin).replace(/\/$/, "");
}

let sessionId = null;
let packets = [];
let active = -1;

$("#btnUpload").addEventListener("click", uploadAndParse);
$("#btnRefresh").addEventListener("click", refreshPackets);

async function uploadAndParse() {
  const file = $("#pcapFile").files?.[0];
  const base = getBase();
  const port = $("#port").value.trim();
  if (!file) return setError("Select a .pcap/.pcapng file first.");

  setError("");
  setSummary("Parsing...");

  const fd = new FormData();
  fd.append("file", file);
  if (port) fd.append("port", port);

  try {
    const r = await fetch(`${base}/api/parse`, {
      method: "POST",
      body: fd,
      headers: { "bypass-tunnel-reminder": "true" },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Parse failed");

    sessionId = data.sessionId;
    const d = data.summary?.diagnostics || {};
    setSummary(`session=${sessionId} | total=${d.total_packets ?? 0} diameter=${d.diameter_detected ?? 0} parse_errors=${d.parse_errors ?? 0}`);
    await refreshPackets();
  } catch (e) {
    setError(e.message || String(e));
    setSummary("");
  }
}

async function refreshPackets() {
  if (!sessionId) return;
  const base = getBase();
  const filter = $("#filter").value.trim();

  try {
    const q = new URLSearchParams({ offset: "0", limit: "200" });
    if (filter) q.set("filter", filter);

    const r = await fetch(`${base}/api/sessions/${sessionId}/packets?${q.toString()}`, {
      headers: { "bypass-tunnel-reminder": "true" },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Fetch packets failed");

    packets = data.packets || [];
    active = packets.length ? 0 : -1;
    renderList();
    if (active >= 0) await loadPacketDetail(active);
  } catch (e) {
    setError(e.message || String(e));
  }
}

function renderList() {
  const box = $("#packetList");
  if (!packets.length) {
    box.innerHTML = `<div class="item">No packets</div>`;
    $("#packetDetail").innerHTML = "";
    return;
  }

  box.innerHTML = packets
    .map((p, i) => {
      const ip = p.ip ? `${p.ip.src || "?"} -> ${p.ip.dst || "?"}` : "(no ip)";
      const l4 = p.transport ? `${p.transport.type}:${p.transport.src_port || "?"}->${p.transport.dst_port || "?"}` : "(no l4)";
      const dia = p.diameter ? `diameter cmd=${p.diameter.cmd_code ?? "?"}` : "no diameter";
      return `<div class="item ${i === active ? "active" : ""}" data-i="${i}">
        <div><b>#${p.index}</b> ${escapeHtml(ip)}</div>
        <div class="muted">${escapeHtml(l4)} | ${escapeHtml(dia)}</div>
      </div>`;
    })
    .join("");

  box.querySelectorAll(".item[data-i]").forEach((el) => {
    el.addEventListener("click", async () => {
      active = Number.parseInt(el.dataset.i, 10);
      renderList();
      await loadPacketDetail(active);
    });
  });
}

async function loadPacketDetail(listIndex) {
  const pkt = packets[listIndex];
  if (!pkt) return;
  const base = getBase();

  try {
    const r = await fetch(`${base}/api/sessions/${sessionId}/packet/${pkt.index}`, {
      headers: { "bypass-tunnel-reminder": "true" },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Load detail failed");
    renderPacketTree(data);
  } catch (e) {
    setError(e.message || String(e));
  }
}

function renderPacketTree(packet) {
  const container = $("#packetDetail");
  container.innerHTML = "";

  const root = document.createElement("details");
  root.open = true;
  root.innerHTML = `<summary><b>Packet #${packet.index}</b></summary>`;
  root.appendChild(renderNode(packet));
  container.appendChild(root);
}

function renderNode(value, keyName = "") {
  const wrap = document.createElement("div");

  if (value === null || value === undefined) {
    wrap.textContent = `${keyName}: null`;
    return wrap;
  }

  if (typeof value !== "object") {
    wrap.textContent = keyName ? `${keyName}: ${value}` : String(value);
    return wrap;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      wrap.textContent = keyName ? `${keyName}: []` : "[]";
      return wrap;
    }
    value.forEach((item, idx) => {
      const d = document.createElement("details");
      d.open = false;
      d.innerHTML = `<summary>${keyName || "item"}[${idx}]</summary>`;
      d.appendChild(renderNode(item));
      wrap.appendChild(d);
    });
    return wrap;
  }

  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === "object") {
      const d = document.createElement("details");
      d.open = ["frame", "ip", "transport", "diameter"].includes(k);
      d.innerHTML = `<summary>${k}</summary>`;
      d.appendChild(renderNode(v));
      wrap.appendChild(d);
    } else {
      const line = document.createElement("div");
      line.textContent = `${k}: ${v}`;
      wrap.appendChild(line);
    }
  }

  return wrap;
}

function setSummary(t) {
  $("#summary").textContent = t;
}

function setError(t) {
  $("#error").textContent = t;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
