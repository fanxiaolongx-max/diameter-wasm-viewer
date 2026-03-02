use etherparse::PacketHeaders;
use pcap_parser::{traits::PcapReaderIterator, LegacyPcapReader, PcapBlockOwned, PcapError, PcapNGReader};
use serde::Serialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_pcap_to_diameter_json(bytes: &[u8], tcp_port: u16) -> Result<JsValue, JsValue> {
    let segments =
        extract_tcp_segments(bytes, tcp_port).map_err(|e| JsValue::from_str(&format!("pcap parse error: {e}")))?;

    let streams = reassemble_streams(segments);

    let mut messages: Vec<DiameterMessageOut> = Vec::new();
    for (_k, buf) in streams {
        let mut offset = 0usize;
        while offset + 20 <= buf.len() {
            if buf[offset] != 1 {
                offset += 1;
                continue;
            }
            let len = read_u24(&buf[offset + 1..offset + 4]) as usize;
            if len < 20 || offset + len > buf.len() {
                break;
            }
            if let Ok((msg, _)) = parse_diameter_message(&buf[offset..offset + len]) {
                messages.push(msg);
            }
            offset += len;
        }
    }

    JsValue::from_serde(&messages).map_err(|e| JsValue::from_str(&format!("json error: {e}")))
}

#[derive(Serialize, Debug, Clone)]
pub struct DiameterMessageOut {
    pub version: u8,
    pub length: u32,
    pub flags: String,
    pub cmd_code: u32,
    pub cmd_name: String,
    pub app_id: u32,
    pub hop_by_hop: u32,
    pub end_to_end: u32,
    pub avps: Vec<AvpNodeOut>,
}

#[derive(Serialize, Debug, Clone)]
pub struct AvpNodeOut {
    pub code: u32,
    pub vendor_id: Option<u32>,
    pub name: String,
    pub flags: String,
    pub length: u32,
    pub content: String,
    pub children: Vec<AvpNodeOut>,
}

#[derive(Debug, Clone)]
struct TcpSeg {
    key: FlowKey,
    seq: u32,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FlowKey {
    a_ip: [u8; 4],
    a_port: u16,
    b_ip: [u8; 4],
    b_port: u16,
}

fn extract_tcp_segments(bytes: &[u8], tcp_port: u16) -> Result<Vec<TcpSeg>, String> {
    if looks_like_pcapng(bytes) {
        extract_from_pcapng(bytes, tcp_port)
    } else {
        extract_from_pcap(bytes, tcp_port)
    }
}

fn looks_like_pcapng(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0..4] == [0x0A, 0x0D, 0x0D, 0x0A]
}

fn extract_from_pcapng(bytes: &[u8], tcp_port: u16) -> Result<Vec<TcpSeg>, String> {
    let mut reader = PcapNGReader::new(65536, bytes).map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();

    loop {
        match reader.next() {
            Ok((offset, block)) => {
                if let PcapBlockOwned::NG(block) = block {
                    if let pcap_parser::Block::EnhancedPacket(epb) = block {
                        if let Some(seg) = parse_one_packet(epb.data, tcp_port) {
                            out.push(seg);
                        }
                    }
                }
                reader.consume(offset);
            }
            Err(PcapError::Eof) => break,
            Err(PcapError::Incomplete(_)) => break,
            Err(e) => return Err(format!("{e:?}")),
        }
    }
    Ok(out)
}

fn extract_from_pcap(bytes: &[u8], tcp_port: u16) -> Result<Vec<TcpSeg>, String> {
    let mut reader = LegacyPcapReader::new(65536, bytes).map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();

    loop {
        match reader.next() {
            Ok((offset, block)) => {
                if let PcapBlockOwned::Legacy(b) = block {
                    if let Some(seg) = parse_one_packet(b.data, tcp_port) {
                        out.push(seg);
                    }
                }
                reader.consume(offset);
            }
            Err(PcapError::Eof) => break,
            Err(PcapError::Incomplete(_)) => break,
            Err(e) => return Err(format!("{e:?}")),
        }
    }
    Ok(out)
}

fn parse_one_packet(pkt: &[u8], tcp_port: u16) -> Option<TcpSeg> {
    let ph = PacketHeaders::from_ethernet_slice(pkt).ok()?;

    let (src_ip, dst_ip) = match ph.net? {
        etherparse::NetHeaders::Ipv4(h, _) => (h.source, h.destination),
        _ => return None,
    };

    let tcp = match ph.transport? {
        etherparse::TransportHeader::Tcp(t) => t,
        _ => return None,
    };

    let src_port = tcp.source_port;
    let dst_port = tcp.destination_port;
    if src_port != tcp_port && dst_port != tcp_port {
        return None;
    }

    let payload = ph.payload.slice().to_vec();
    if payload.is_empty() {
        return None;
    }

    Some(TcpSeg {
        key: FlowKey {
            a_ip: src_ip,
            a_port: src_port,
            b_ip: dst_ip,
            b_port: dst_port,
        },
        seq: tcp.sequence_number,
        payload,
    })
}

fn reassemble_streams(segs: Vec<TcpSeg>) -> HashMap<FlowKey, Vec<u8>> {
    let mut grouped: HashMap<FlowKey, Vec<TcpSeg>> = HashMap::new();
    for s in segs {
        grouped.entry(s.key.clone()).or_default().push(s);
    }

    let mut out: HashMap<FlowKey, Vec<u8>> = HashMap::new();
    for (k, mut v) in grouped {
        v.sort_by_key(|s| s.seq);
        let mut buf: Vec<u8> = Vec::new();
        let mut expected_seq: Option<u32> = None;

        for s in v {
            match expected_seq {
                None => {
                    expected_seq = Some(s.seq.wrapping_add(s.payload.len() as u32));
                    buf.extend_from_slice(&s.payload);
                }
                Some(exp) if s.seq == exp => {
                    buf.extend_from_slice(&s.payload);
                    expected_seq = Some(exp.wrapping_add(s.payload.len() as u32));
                }
                Some(exp) if s.seq < exp => {
                    let overlap = (exp - s.seq) as usize;
                    if overlap < s.payload.len() {
                        buf.extend_from_slice(&s.payload[overlap..]);
                        expected_seq = Some(exp.wrapping_add((s.payload.len() - overlap) as u32));
                    }
                }
                Some(_) => {
                    buf.extend_from_slice(&s.payload);
                    expected_seq = Some(s.seq.wrapping_add(s.payload.len() as u32));
                }
            }
        }

        out.insert(k, buf);
    }

    out
}

fn parse_diameter_message(buf: &[u8]) -> Result<(DiameterMessageOut, usize), String> {
    if buf.len() < 20 {
        return Err("too short".into());
    }

    let version = buf[0];
    let length = read_u24(&buf[1..4]);
    let flags = format!("0x{:02x}", buf[4]);
    let cmd_code = read_u24(&buf[5..8]);
    let app_id = u32::from_be_bytes(buf[8..12].try_into().unwrap());
    let hop_by_hop = u32::from_be_bytes(buf[12..16].try_into().unwrap());
    let end_to_end = u32::from_be_bytes(buf[16..20].try_into().unwrap());

    let cmd_name = match cmd_code {
        272 => "Credit-Control".to_string(),
        _ => format!("Cmd-{cmd_code}"),
    };

    let mut avps = Vec::new();
    let mut off = 20usize;
    while off + 8 <= buf.len() {
        let (node, used) = parse_avp(&buf[off..])?;
        avps.push(node);
        off += used;
        if off >= buf.len() {
            break;
        }
    }

    Ok((
        DiameterMessageOut {
            version,
            length,
            flags,
            cmd_code,
            cmd_name,
            app_id,
            hop_by_hop,
            end_to_end,
            avps,
        },
        length as usize,
    ))
}

fn parse_avp(buf: &[u8]) -> Result<(AvpNodeOut, usize), String> {
    if buf.len() < 8 {
        return Err("avp too short".into());
    }

    let code = u32::from_be_bytes(buf[0..4].try_into().unwrap());
    let flags_b = buf[4];
    let flags = format!("0x{:02x}", flags_b);
    let length = read_u24(&buf[5..8]);
    let total_len = length as usize;

    if total_len < 8 || total_len > buf.len() {
        return Err("invalid avp length".into());
    }

    let has_vendor = (flags_b & 0x80) != 0;
    let mut cursor = 8usize;
    let vendor_id = if has_vendor {
        if total_len < 12 {
            return Err("vendor flag but too short".into());
        }
        let v = u32::from_be_bytes(buf[cursor..cursor + 4].try_into().unwrap());
        cursor += 4;
        Some(v)
    } else {
        None
    };

    let data_len = total_len - cursor;
    let data = &buf[cursor..cursor + data_len];

    let mut children = Vec::new();
    let grouped = is_grouped(code, vendor_id);
    let content = if grouped {
        let mut off = 0usize;
        while off + 8 <= data.len() {
            let (child, used) = parse_avp(&data[off..])?;
            children.push(child);
            off += used;
            if off >= data.len() {
                break;
            }
        }
        String::new()
    } else {
        decode_avp_content(code, vendor_id, data)
    };

    let name = avp_name(code, vendor_id);
    let padded = ((total_len + 3) / 4) * 4;

    Ok((
        AvpNodeOut {
            code,
            vendor_id,
            name,
            flags,
            length,
            content,
            children,
        },
        padded,
    ))
}

fn is_grouped(code: u32, vendor: Option<u32>) -> bool {
    vendor.is_none() && code == 443
}

fn avp_name(code: u32, vendor: Option<u32>) -> String {
    if vendor.is_none() {
        return match code {
            263 => "Session-Id",
            258 => "Auth-Application-Id",
            264 => "Origin-Host",
            296 => "Origin-Realm",
            293 => "Destination-Host",
            283 => "Destination-Realm",
            278 => "Origin-State-Id",
            416 => "CC-Request-Type",
            415 => "CC-Request-Number",
            8 => "Framed-IP-Address",
            443 => "Subscription-Id",
            450 => "Subscription-Id-Type",
            444 => "Subscription-Id-Data",
            1021 => "Bearer-Operation",
            1027 => "IP-CAN-Type",
            30 => "Called-Station-Id",
            _ => return format!("AVP-{code}"),
        }
        .to_string();
    }

    if code == 23 {
        return "3GPP-MS-TimeZone".to_string();
    }

    format!("V{}-AVP-{code}", vendor.unwrap())
}

fn decode_avp_content(code: u32, vendor: Option<u32>, data: &[u8]) -> String {
    if vendor.is_none() {
        match code {
            263 | 264 | 296 | 293 | 283 | 444 | 30 => return as_utf8_or_hex(data),
            258 | 278 | 415 => return as_u32_str(data),
            416 => return decode_cc_request_type(data),
            8 => return decode_ipv4_addr(data),
            1021 => return decode_bearer_operation(data),
            1027 => return decode_ip_can_type(data),
            _ => {}
        }
    } else if code == 23 {
        return as_utf8_or_hex(data);
    }

    as_utf8_or_hex(data)
}

fn decode_ipv4_addr(data: &[u8]) -> String {
    if data.len() >= 4 {
        format!("{}.{}.{}.{}", data[0], data[1], data[2], data[3])
    } else {
        as_hex(data)
    }
}

fn as_u32_str(data: &[u8]) -> String {
    if data.len() >= 4 {
        u32::from_be_bytes(data[0..4].try_into().unwrap()).to_string()
    } else {
        as_hex(data)
    }
}

fn decode_cc_request_type(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            1 => "INITIAL_REQUEST",
            2 => "UPDATE_REQUEST",
            3 => "TERMINATION_REQUEST",
            4 => "EVENT_REQUEST",
            _ => "UNKNOWN",
        };
        format!("{label} ({v})")
    } else {
        as_hex(data)
    }
}

fn decode_bearer_operation(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            1 => "ESTABLISHMENT",
            2 => "MODIFICATION",
            3 => "TERMINATION",
            _ => "UNKNOWN",
        };
        format!("{label} ({v})")
    } else {
        as_hex(data)
    }
}

fn decode_ip_can_type(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            0 => "3GPP",
            1 => "DOCSIS",
            2 => "xDSL",
            3 => "WIMAX",
            _ => "UNKNOWN",
        };
        format!("{label} ({v})")
    } else {
        as_hex(data)
    }
}

fn as_utf8_or_hex(data: &[u8]) -> String {
    match std::str::from_utf8(data) {
        Ok(s) => s.trim_matches('\0').to_string(),
        Err(_) => as_hex(data),
    }
}

fn as_hex(data: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in data.iter().take(64) {
        s.push_str(&format!("{b:02x}"));
    }
    if data.len() > 64 {
        s.push('…');
    }
    s
}

fn read_u24(b: &[u8]) -> u32 {
    ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32)
}
