use etherparse::PacketHeaders;
use pcap_parser::{traits::PcapReaderIterator, LegacyPcapReader, PcapBlockOwned, PcapError, PcapNGReader};
use serde::Serialize;
use serde_wasm_bindgen::to_value;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_pcap_to_diameter_json(bytes: &[u8], tcp_port: u16) -> Result<JsValue, JsValue> {
    let segments =
        extract_tcp_segments(bytes, tcp_port).map_err(|e| JsValue::from_str(&format!("pcap parse error: {e}")))?;

    let streams = reassemble_streams(segments);

    let mut messages: Vec<DiameterMessageOut> = Vec::new();
    for (_k, bufs) in streams {
        for buf in bufs {
            let mut offset = 0usize;
            while offset + 20 <= buf.len() {
                if buf[offset] != 1 {
                    offset += 1;
                    continue;
                }
                let len = read_u24(&buf[offset + 1..offset + 4]) as usize;
                if len < 20 {
                    offset += 1;
                    continue;
                }
                if offset + len > buf.len() {
                    // likely truncated tail in this chunk
                    break;
                }
                match parse_diameter_message(&buf[offset..offset + len]) {
                    Ok((msg, _)) => {
                        messages.push(msg);
                        offset += len;
                    }
                    Err(_) => {
                        // re-sync scan to next possible Diameter version byte
                        offset += 1;
                    }
                }
            }
        }
    }

    to_value(&messages).map_err(|e| JsValue::from_str(&format!("json error: {e}")))
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
struct StreamSeg {
    key: FlowKey,
    order: u32,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FlowKey {
    a_ip: [u8; 4],
    a_port: u16,
    b_ip: [u8; 4],
    b_port: u16,
    l4_proto: u8,      // 6=tcp, 132=sctp
    sctp_stream: u16,  // tcp uses 0
}

fn extract_tcp_segments(bytes: &[u8], tcp_port: u16) -> Result<Vec<StreamSeg>, String> {
    if looks_like_pcapng(bytes) {
        extract_from_pcapng(bytes, tcp_port)
    } else {
        extract_from_pcap(bytes, tcp_port)
    }
}

fn looks_like_pcapng(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0..4] == [0x0A, 0x0D, 0x0D, 0x0A]
}

fn extract_from_pcapng(bytes: &[u8], tcp_port: u16) -> Result<Vec<StreamSeg>, String> {
    let mut reader = PcapNGReader::new(65536, bytes).map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();

    loop {
        match reader.next() {
            Ok((offset, block)) => {
                if let PcapBlockOwned::NG(block) = block {
                    if let pcap_parser::Block::EnhancedPacket(epb) = block {
                        let segs = parse_one_packet(epb.data, tcp_port);
                        out.extend(segs);
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

fn extract_from_pcap(bytes: &[u8], tcp_port: u16) -> Result<Vec<StreamSeg>, String> {
    let mut reader = LegacyPcapReader::new(65536, bytes).map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::new();

    loop {
        match reader.next() {
            Ok((offset, block)) => {
                if let PcapBlockOwned::Legacy(b) = block {
                    let segs = parse_one_packet(b.data, tcp_port);
                    out.extend(segs);
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

fn parse_one_packet(pkt: &[u8], tcp_port: u16) -> Vec<StreamSeg> {
    let ph = match PacketHeaders::from_ethernet_slice(pkt) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let (ip4, ip_proto) = match ph.net {
        Some(etherparse::NetHeaders::Ipv4(h, _)) => {
            let proto = h.protocol.0;
            (h, proto)
        }
        _ => return Vec::new(),
    };
    let src_ip = ip4.source;
    let dst_ip = ip4.destination;

    if let Some(etherparse::TransportHeader::Tcp(tcp)) = ph.transport {
        let src_port = tcp.source_port;
        let dst_port = tcp.destination_port;
        if src_port != tcp_port && dst_port != tcp_port {
            return Vec::new();
        }
        let payload = ph.payload.slice().to_vec();
        if payload.is_empty() {
            return Vec::new();
        }
        return vec![StreamSeg {
            key: FlowKey {
                a_ip: src_ip,
                a_port: src_port,
                b_ip: dst_ip,
                b_port: dst_port,
                l4_proto: 6,
                sctp_stream: 0,
            },
            order: tcp.sequence_number,
            payload,
        }];
    }

    // SCTP: parse DATA chunks and keep only Diameter PPID(46)
    if ip_proto == 132 {
        let sctp_bytes = ph.payload.slice();
        return parse_sctp_data_segments(sctp_bytes, src_ip, dst_ip, tcp_port);
    }

    Vec::new()
}

fn parse_sctp_data_segments(
    sctp: &[u8],
    src_ip: [u8; 4],
    dst_ip: [u8; 4],
    diameter_port: u16,
) -> Vec<StreamSeg> {
    if sctp.len() < 12 {
        return Vec::new();
    }

    let src_port = u16::from_be_bytes([sctp[0], sctp[1]]);
    let dst_port = u16::from_be_bytes([sctp[2], sctp[3]]);
    if src_port != diameter_port && dst_port != diameter_port {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut off = 12usize;
    while off + 4 <= sctp.len() {
        let chunk_type = sctp[off];
        let chunk_len = u16::from_be_bytes([sctp[off + 2], sctp[off + 3]]) as usize;
        if chunk_len < 4 || off + chunk_len > sctp.len() {
            break;
        }

        if chunk_type == 0 && chunk_len >= 16 {
            let tsn = u32::from_be_bytes([sctp[off + 4], sctp[off + 5], sctp[off + 6], sctp[off + 7]]);
            let stream_id = u16::from_be_bytes([sctp[off + 8], sctp[off + 9]]);
            let ppid = u32::from_be_bytes([sctp[off + 12], sctp[off + 13], sctp[off + 14], sctp[off + 15]]);
            let user_data = &sctp[off + 16..off + chunk_len];

            if ppid == 46 && !user_data.is_empty() {
                out.push(StreamSeg {
                    key: FlowKey {
                        a_ip: src_ip,
                        a_port: src_port,
                        b_ip: dst_ip,
                        b_port: dst_port,
                        l4_proto: 132,
                        sctp_stream: stream_id,
                    },
                    order: tsn,
                    payload: user_data.to_vec(),
                });
            }
        }

        off += ((chunk_len + 3) / 4) * 4;
    }

    out
}

fn reassemble_streams(segs: Vec<StreamSeg>) -> HashMap<FlowKey, Vec<Vec<u8>>> {
    let mut grouped: HashMap<FlowKey, Vec<StreamSeg>> = HashMap::new();
    for s in segs {
        grouped.entry(s.key.clone()).or_default().push(s);
    }

    let mut out: HashMap<FlowKey, Vec<Vec<u8>>> = HashMap::new();
    for (k, mut v) in grouped {
        v.sort_by_key(|s| s.order);

        let mut chunks: Vec<Vec<u8>> = Vec::new();
        let mut current: Vec<u8> = Vec::new();
        let mut expected_order: Option<u32> = None;

        for s in v {
            match expected_order {
                None => {
                    current.extend_from_slice(&s.payload);
                    expected_order = Some(s.order.wrapping_add(s.payload.len() as u32));
                }
                Some(exp) if s.order == exp => {
                    current.extend_from_slice(&s.payload);
                    expected_order = Some(exp.wrapping_add(s.payload.len() as u32));
                }
                Some(exp) if s.order < exp => {
                    let overlap = (exp - s.order) as usize;
                    if overlap < s.payload.len() {
                        current.extend_from_slice(&s.payload[overlap..]);
                        expected_order = Some(exp.wrapping_add((s.payload.len() - overlap) as u32));
                    }
                }
                Some(_) => {
                    if !current.is_empty() {
                        chunks.push(std::mem::take(&mut current));
                    }
                    current.extend_from_slice(&s.payload);
                    expected_order = Some(s.order.wrapping_add(s.payload.len() as u32));
                }
            }
        }

        if !current.is_empty() {
            chunks.push(current);
        }

        out.insert(k, chunks);
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

    if vendor == Some(10415) {
        return match code {
            1021 => "Bearer-Operation".to_string(),
            1027 => "IP-CAN-Type".to_string(),
            23 => "3GPP-MS-TimeZone".to_string(),
            _ => format!("3GPP-AVP-{code}"),
        };
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
            278 | 415 => return as_u32_str(data),
            258 => return decode_auth_application_id(data),
            416 => return decode_cc_request_type(data),
            450 => return decode_subscription_id_type(data),
            8 => return decode_ipv4_addr(data),
            1021 => return decode_bearer_operation(data),
            1027 => return decode_ip_can_type(data),
            _ => {}
        }
    } else if vendor == Some(10415) {
        match code {
            1021 => return decode_bearer_operation(data),
            1027 => return decode_ip_can_type(data),
            23 => return decode_3gpp_ms_timezone(data),
            _ => {}
        }
    } else if code == 23 {
        return decode_3gpp_ms_timezone(data);
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

fn decode_auth_application_id(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            16777238 => "3GPP Gx",
            _ => "UNKNOWN",
        };
        format!("{label} ({v})")
    } else {
        as_hex(data)
    }
}

fn decode_subscription_id_type(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            0 => "END_USER_E164",
            1 => "END_USER_IMSI",
            2 => "END_USER_SIP_URI",
            3 => "END_USER_NAI",
            4 => "END_USER_PRIVATE",
            _ => "UNKNOWN",
        };
        format!("{label} ({v})")
    } else {
        as_hex(data)
    }
}

fn decode_3gpp_ms_timezone(data: &[u8]) -> String {
    if data.len() >= 2 {
        let tz = data[0];
        let dst = data[1] & 0b11;

        let low = tz & 0x0F;
        let high = (tz >> 4) & 0x07;
        let qh = (high as u16) * 10 + (low as u16); // quarter-hours in BCD
        let sign_negative = (tz & 0x08) != 0;

        let total_minutes = (qh as i32) * 15;
        let signed_minutes = if sign_negative { -total_minutes } else { total_minutes };
        let hours = signed_minutes.abs() / 60;
        let minutes = signed_minutes.abs() % 60;

        let dst_text = match dst {
            0 => "No adjustment",
            1 => "+1 hour adjustment",
            2 => "+2 hours adjustment",
            _ => "Reserved adjustment",
        };

        let sign = if sign_negative { "-" } else { "+" };
        format!(
            "Timezone: GMT {sign} {hours} hours {minutes} minutes {dst_text}"
        )
    } else {
        as_utf8_or_hex(data)
    }
}

fn decode_bearer_operation(data: &[u8]) -> String {
    if data.len() >= 4 {
        let v = u32::from_be_bytes(data[0..4].try_into().unwrap());
        let label = match v {
            0 => "TERMINATION",
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
