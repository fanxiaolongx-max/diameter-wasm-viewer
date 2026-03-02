import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), "diameter-viewer-upload") });
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.post("/api/parse", upload.single("file"), async (req, res) => {
  const file = req.file;
  const rawPort = req.body?.port;
  const parsedPort = Number.parseInt(rawPort, 10);
  const filterPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null;

  if (!file) {
    return res.status(400).json({ error: "Missing multipart file field 'file' (.pcap/.pcapng)." });
  }

  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext && ext !== ".pcap" && ext !== ".pcapng") {
    await safeUnlink(file.path);
    return res.status(400).json({ error: "Unsupported file type. Use .pcap or .pcapng" });
  }

  try {
    const tsharkJson = await runTsharkJson(file.path, filterPort);
    const normalized = normalizePackets(tsharkJson, { filterPort });
    const id = randomUUID();
    sessions.set(id, {
      id,
      createdAt: new Date().toISOString(),
      fileName: file.originalname,
      port: filterPort,
      ...normalized,
    });

    res.json({
      sessionId: id,
      summary: buildSummary(sessions.get(id)),
    });
  } catch (err) {
    const code = err?.code === "TSHARK_NOT_FOUND" ? 500 : 400;
    res.status(code).json({
      error: err?.message || "Failed to parse capture",
      hint:
        err?.code === "TSHARK_NOT_FOUND"
          ? "Install tshark (Wireshark CLI), e.g. 'sudo apt install tshark', then retry."
          : undefined,
    });
  } finally {
    await safeUnlink(file.path);
  }
});

app.get("/api/sessions/:id/summary", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(buildSummary(session));
});

app.get("/api/sessions/:id/packets", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const filter = (req.query.filter || "").toString().trim().toLowerCase();

  let packets = session.packets;
  if (filter) {
    packets = packets.filter((pkt) => packetMatches(pkt, filter));
  }

  const sliced = packets.slice(offset, offset + limit).map(packetListItem);

  res.json({
    total: packets.length,
    offset,
    limit,
    returned: sliced.length,
    packets: sliced,
  });
});

app.get("/api/sessions/:id/packet/:index", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const index = Number.parseInt(req.params.index, 10);
  if (!Number.isFinite(index) || index < 0 || index >= session.packets.length) {
    return res.status(404).json({ error: "Packet index out of range" });
  }
  res.json(session.packets[index]);
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

function runTsharkJson(filePath, filterPort) {
  return new Promise((resolve, reject) => {
    const args = ["-r", filePath, "-T", "json", "-V"];
    if (filterPort) {
      args.push("-Y", `(tcp.port == ${filterPort}) || (udp.port == ${filterPort}) || (sctp.port == ${filterPort})`);
    }

    const child = spawn("tshark", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        const e = new Error("tshark not found in PATH");
        e.code = "TSHARK_NOT_FOUND";
        return reject(e);
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`tshark exited with code ${code}: ${stderr || "unknown error"}`));
      }
      try {
        resolve(JSON.parse(stdout || "[]"));
      } catch (err) {
        reject(new Error(`Invalid tshark JSON output: ${err.message}`));
      }
    });
  });
}

function normalizePackets(items, { filterPort }) {
  const packets = [];
  let parseErrors = 0;
  let diameterDetected = 0;

  for (let i = 0; i < items.length; i++) {
    try {
      const item = items[i];
      const layers = item?._source?.layers || {};
      const packet = {
        index: i,
        frame: extractFrame(layers.frame),
        ethernet: extractEthernet(layers.eth),
        ip: extractIp(layers),
        transport: extractTransport(layers),
        diameter: extractDiameter(layers.diameter),
      };

      if (filterPort && packet.transport?.src_port !== filterPort && packet.transport?.dst_port !== filterPort) {
        continue;
      }

      if (packet.diameter) diameterDetected += 1;
      packets.push(packet);
    } catch (_err) {
      parseErrors += 1;
    }
  }

  return {
    packets,
    diagnostics: {
      total_packets: packets.length,
      diameter_detected: diameterDetected,
      parse_errors: parseErrors,
    },
  };
}

function extractFrame(frameLayer = {}) {
  return {
    number: num(first(frameLayer["frame.number"])),
    time: first(frameLayer["frame.time"]),
    len: num(first(frameLayer["frame.len"])),
    protocol_stack: first(frameLayer["frame.protocols"]),
  };
}

function extractEthernet(eth = {}) {
  if (!eth || Object.keys(eth).length === 0) return null;
  return {
    src: first(eth["eth.src"]),
    dst: first(eth["eth.dst"]),
    type: first(eth["eth.type"]),
  };
}

function extractIp(layers) {
  const ipv4 = layers.ip || {};
  const ipv6 = layers.ipv6 || {};
  if (Object.keys(ipv4).length) {
    return {
      version: 4,
      src: first(ipv4["ip.src"]),
      dst: first(ipv4["ip.dst"]),
      proto: first(ipv4["ip.proto"]),
    };
  }
  if (Object.keys(ipv6).length) {
    return {
      version: 6,
      src: first(ipv6["ipv6.src"]),
      dst: first(ipv6["ipv6.dst"]),
      proto: first(ipv6["ipv6.nxt"]),
    };
  }
  return null;
}

function extractTransport(layers) {
  const tcp = layers.tcp || {};
  const udp = layers.udp || {};
  const sctp = layers.sctp || {};

  if (Object.keys(tcp).length) {
    return {
      type: "tcp",
      src_port: num(first(tcp["tcp.srcport"])),
      dst_port: num(first(tcp["tcp.dstport"])),
      stream: num(first(tcp["tcp.stream"])),
    };
  }
  if (Object.keys(udp).length) {
    return {
      type: "udp",
      src_port: num(first(udp["udp.srcport"])),
      dst_port: num(first(udp["udp.dstport"])),
    };
  }
  if (Object.keys(sctp).length) {
    return {
      type: "sctp",
      src_port: num(first(sctp["sctp.srcport"])),
      dst_port: num(first(sctp["sctp.dstport"])),
      verification_tag: first(sctp["sctp.verification_tag"]),
    };
  }
  return null;
}

function extractDiameter(diameterLayer) {
  if (!diameterLayer || Object.keys(diameterLayer).length === 0) return null;

  const avpTrees = collectAvpTrees(diameterLayer);
  return {
    version: num(first(diameterLayer["diameter.version"])),
    length: num(first(diameterLayer["diameter.length"])),
    flags: first(diameterLayer["diameter.flags"]),
    cmd_code: num(first(diameterLayer["diameter.cmd.code"])),
    application_id: num(first(diameterLayer["diameter.applicationId"])),
    hop_by_hop_id: first(diameterLayer["diameter.hopbyhopid"]),
    end_to_end_id: first(diameterLayer["diameter.endtoendid"]),
    avps: avpTrees,
  };
}

function collectAvpTrees(diameterLayer) {
  const trees = [];
  for (const [k, v] of Object.entries(diameterLayer)) {
    if (!k.includes("avp")) continue;
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (entry && typeof entry === "object") {
          const n = normalizeAvpNode(entry);
          if (n) trees.push(n);
        }
      }
    } else if (v && typeof v === "object") {
      const n = normalizeAvpNode(v);
      if (n) trees.push(n);
    }
  }
  return trees;
}

function normalizeAvpNode(node) {
  const code = first(node["diameter.avp.code"]);
  const name =
    first(node["diameter.avp.code_tree"]) ||
    first(node["diameter.avp.name"]) ||
    first(node["diameter.avp"]);

  const children = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const it of value) {
        if (it && typeof it === "object") {
          const sub = normalizeAvpNode(it);
          if (sub) children.push(sub);
        }
      }
    } else if (value && typeof value === "object") {
      const sub = normalizeAvpNode(value);
      if (sub) children.push(sub);
    }
  }

  if (!code && !name && children.length === 0) return null;

  return {
    code: num(code),
    name: name || null,
    flags: first(node["diameter.avp.flags"]),
    vendor_id: num(first(node["diameter.avp.vendorId"])),
    raw_value: first(node["diameter.avp.data"]),
    children,
  };
}

function buildSummary(session) {
  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    fileName: session.fileName,
    port: session.port,
    diagnostics: session.diagnostics,
  };
}

function packetListItem(pkt) {
  return {
    index: pkt.index,
    frame: pkt.frame,
    ip: pkt.ip,
    transport: pkt.transport,
    diameter: pkt.diameter
      ? {
          cmd_code: pkt.diameter.cmd_code,
          application_id: pkt.diameter.application_id,
          flags: pkt.diameter.flags,
          avp_count: pkt.diameter.avps?.length || 0,
        }
      : null,
  };
}

function packetMatches(pkt, filter) {
  const haystack = [
    pkt.ip?.src,
    pkt.ip?.dst,
    pkt.transport?.type,
    pkt.transport?.src_port,
    pkt.transport?.dst_port,
    pkt.diameter?.cmd_code,
    pkt.diameter?.application_id,
    JSON.stringify(pkt.diameter?.avps || []),
  ]
    .filter((x) => x !== undefined && x !== null)
    .join(" ")
    .toLowerCase();

  return haystack.includes(filter);
}

function first(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}
