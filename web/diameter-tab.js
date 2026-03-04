(() => {
  const STATE = {
    mounted: false,
    panel: null,
    tableWrap: null,
    status: null,
    captureInput: null,
    frameInput: null,
    dragHandle: null,
    drag: { active: false, dx: 0, dy: 0 },
    loading: false,
    lastLoadedKey: '',
    autoLoadTimer: null,
    flowsModal: null,
    flowsRows: null,
    menuInjectObserver: null,
    frameMetaCache: new Map(),
    suppressFrameSyncUntil: 0,
    freezeFrameSyncWhileFlowsOpen: false,
    reopenBtn: null,
    netIndicator: null,
    currentRows: [],
    currentCapture: '',
    currentFrame: '',
    flowsEditMode: false,
    flowsSelectedIndex: -1,
    flowsCache: new Map(),
    flowsAllRows: [],
    sessionFilterMode: 'multi',
    sessionFilterSet: new Set(),
    sessionFilterText: '',
    captureEpochCache: new Map(),
    timeEnhanceTimer: null,
    filterApplyTicker: null,
    filterApplyPending: false,
    defaultDisplayFilterPrimed: false
  }

  const POS_KEY = 'diameter_fixed_panel_pos_v1'
  const SIZE_KEY = 'diameter_fixed_panel_size_v1'
  const CAP_KEY = 'diameter_fixed_panel_capture_v1'
  const IP_ALIAS_KEY = 'diameter_ip_alias_map_v1'
  const SEQDIAG_SUFFIX_KEY = 'diameter_seqdiag_suffix_v1'

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function t(s) {
    try {
      return window.WEBSHARK_I18N?.t ? window.WEBSHARK_I18N.t(String(s)) : String(s)
    } catch {
      return String(s)
    }
  }

  function loadIpAliasMap() {
    try {
      const raw = localStorage.getItem(IP_ALIAS_KEY) || '{}'
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object') return obj
    } catch { }
    return {}
  }

  function saveIpAliasMap(map) {
    try {
      localStorage.setItem(IP_ALIAS_KEY, JSON.stringify(map || {}))
    } catch { }
  }

  function getIpAlias(ip) {
    const m = loadIpAliasMap()
    return String((m && m[ip]) || '').trim()
  }

  function setIpAlias(ip, alias) {
    const m = loadIpAliasMap()
    const v = String(alias || '').trim()
    if (!v) {
      delete m[ip]
    } else {
      m[ip] = v
    }
    saveIpAliasMap(m)
  }

  function downloadText(filename, text, contentType = 'text/plain;charset=utf-8') {
    const blob = new Blob([String(text || '')], { type: contentType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 600)
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }

  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX)
    return new Promise((resolve, reject) => {
      if (document.getElementById('dia-xlsx-script')) {
        const poll = setInterval(() => {
          if (window.XLSX) { clearInterval(poll); resolve(window.XLSX) }
        }, 50)
        return
      }
      const s = document.createElement('script')
      s.id = 'dia-xlsx-script'
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
      s.onload = () => resolve(window.XLSX)
      s.onerror = () => reject(new Error('Failed to load SheetJS from CDN'))
      document.head.appendChild(s)
    })
  }

  function getSeqDiagSuffix() {
    try {
      const v = localStorage.getItem(SEQDIAG_SUFFIX_KEY)
      if (v !== null) return v
    } catch { }
    return 'Normal AVP list'
  }

  function setSeqDiagSuffix(text) {
    try {
      localStorage.setItem(SEQDIAG_SUFFIX_KEY, String(text || ''))
    } catch { }
  }

  function rowDisplayLabel(r) {
    if (r && r.customLabel) return String(r.customLabel)
    return normalizeDiameterLabel(r && r.info, r && r.ccRequestType)
  }

  function getUniqueSessionIds(rows) {
    const s = new Set()
      ; (rows || []).forEach(r => {
        const sid = String((r && r.sessionId) || '').trim()
        if (sid) s.add(sid)
      })
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }

  function applySessionFilterToRows(rows) {
    const all = Array.isArray(rows) ? rows : []
    const picked = STATE.sessionFilterSet || new Set()
    const kw = String(STATE.sessionFilterText || '').trim().toLowerCase()
    return all.filter(r => {
      const sid = String((r && r.sessionId) || '').trim()
      if (kw && !sid.toLowerCase().includes(kw)) return false
      if (picked.size > 0 && !picked.has(sid)) return false
      return true
    })
  }

  function refreshFlowsByFilter() {
    const all = Array.isArray(STATE.flowsAllRows) ? STATE.flowsAllRows : []
    STATE.flowsRows = applySessionFilterToRows(all)
    STATE.flowsSelectedIndex = -1
    renderDiameterFlows(STATE.flowsRows)
  }

  function openSessionFilterDialog() {
    const all = Array.isArray(STATE.flowsAllRows) ? STATE.flowsAllRows : []
    if (!all.length) return
    const sessions = getUniqueSessionIds(all)

    const modal = document.createElement('div')
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100002;display:flex;align-items:center;justify-content:center;'

    const card = document.createElement('div')
    card.style.cssText = 'width:min(760px,95vw);max-height:80vh;background:#fff;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;'
    const modeMulti = STATE.sessionFilterMode !== 'single'

    card.innerHTML = `
      <div style="padding:10px 12px;background:#3f51b5;color:#fff;font-weight:600;">${escapeHtml(t('Session-Id Filter'))}</div>
      <div style="padding:10px 12px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #eee;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;"><input type="radio" name="dia-s-mode" value="single" ${modeMulti ? '' : 'checked'}> ${escapeHtml(t('Single'))}</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;"><input type="radio" name="dia-s-mode" value="multi" ${modeMulti ? 'checked' : ''}> ${escapeHtml(t('Multi'))}</label>
        <button id="dia-s-select-all" style="padding:4px 8px;font-size:12px;${modeMulti ? '' : 'display:none;'}">${escapeHtml(t('Select All'))}</button>
        <button id="dia-s-unselect-all" style="padding:4px 8px;font-size:12px;${modeMulti ? '' : 'display:none;'}">${escapeHtml(t('Unselect All'))}</button>
        <input id="dia-s-search" placeholder="${escapeHtml(t('Filter session-id...'))}" style="margin-left:auto;min-width:220px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;" value="${escapeHtml(STATE.sessionFilterText || '')}">
      </div>
      <div id="dia-s-list" style="padding:8px 12px;overflow:auto;flex:1;"></div>
      <div style="padding:10px 12px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #eee;">
        <button id="dia-s-clear" style="padding:5px 10px;">${escapeHtml(t('Clear'))}</button>
        <button id="dia-s-cancel" style="padding:5px 10px;">${escapeHtml(t('Cancel'))}</button>
        <button id="dia-s-apply" style="padding:5px 10px;background:#3f51b5;color:#fff;border:1px solid #3f51b5;border-radius:4px;">${escapeHtml(t('Apply'))}</button>
      </div>
    `

    modal.appendChild(card)
    document.body.appendChild(modal)

    const listEl = card.querySelector('#dia-s-list')
    const searchEl = card.querySelector('#dia-s-search')
    const selectAllBtn = card.querySelector('#dia-s-select-all')
    const unselectAllBtn = card.querySelector('#dia-s-unselect-all')
    const selected = new Set(Array.from(STATE.sessionFilterSet || []))

    function getFilteredSessions() {
      const kw = String(searchEl.value || '').trim().toLowerCase()
      return sessions.filter(s => !kw || s.toLowerCase().includes(kw))
    }

    function drawList() {
      const mode = card.querySelector('input[name="dia-s-mode"]:checked')?.value || 'multi'
      const filtered = getFilteredSessions()

      if (selectAllBtn) selectAllBtn.style.display = mode === 'multi' ? '' : 'none'
      if (unselectAllBtn) unselectAllBtn.style.display = mode === 'multi' ? '' : 'none'

      listEl.innerHTML = filtered
        .map(s => {
          const checked = selected.has(s) ? 'checked' : ''
          const t = mode === 'single' ? 'radio' : 'checkbox'
          return `<label style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12px;"><input type="${t}" name="dia-s-item" data-sid="${encodeURIComponent(s)}" ${checked}><span>${escapeHtml(s)}</span></label>`
        })
        .join('') || `<div style="opacity:.7;font-size:12px;">${escapeHtml(t('No session-id matched.'))}</div>`

      listEl.querySelectorAll('input[name="dia-s-item"]').forEach(inp => {
        inp.addEventListener('change', () => {
          const sid = decodeURIComponent(inp.getAttribute('data-sid') || '')
          const mode2 = card.querySelector('input[name="dia-s-mode"]:checked')?.value || 'multi'
          if (mode2 === 'single') {
            selected.clear()
            if (inp.checked) selected.add(sid)
            drawList()
            return
          }
          if (inp.checked) selected.add(sid)
          else selected.delete(sid)
        })
      })
    }

    searchEl.addEventListener('input', drawList)
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const mode = card.querySelector('input[name="dia-s-mode"]:checked')?.value || 'multi'
        if (mode !== 'multi') return
        getFilteredSessions().forEach(s => selected.add(s))
        drawList()
      })
    }
    if (unselectAllBtn) {
      unselectAllBtn.addEventListener('click', () => {
        const mode = card.querySelector('input[name="dia-s-mode"]:checked')?.value || 'multi'
        if (mode !== 'multi') return
        getFilteredSessions().forEach(s => selected.delete(s))
        drawList()
      })
    }
    card.querySelectorAll('input[name="dia-s-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.value === 'single' && selected.size > 1) {
          const first = Array.from(selected)[0]
          selected.clear()
          if (first) selected.add(first)
        }
        drawList()
      })
    })

    card.querySelector('#dia-s-cancel').addEventListener('click', () => modal.remove())
    card.querySelector('#dia-s-clear').addEventListener('click', () => {
      selected.clear()
      searchEl.value = ''
      drawList()
    })
    card.querySelector('#dia-s-apply').addEventListener('click', () => {
      STATE.sessionFilterMode = card.querySelector('input[name="dia-s-mode"]:checked')?.value || 'multi'
      STATE.sessionFilterText = String(searchEl.value || '').trim()
      STATE.sessionFilterSet = new Set(Array.from(selected))
      modal.remove()
      refreshFlowsByFilter()
    })

    modal.addEventListener('click', e => {
      if (e.target === modal) modal.remove()
    })

    drawList()
  }

  async function exportFlowsXlsx() {
    const rows = Array.isArray(STATE.flowsRows) ? STATE.flowsRows : []
    if (!rows.length) {
      alert('No flow data to export.')
      return
    }

    const capture = (STATE.currentCapture || '').trim()
    if (!capture) {
      alert('No active capture set for Diameter Flows.')
      return
    }

    if (STATE.status) STATE.status.textContent = 'Loading AVPs for Excel...'

    let XLSX
    try {
      XLSX = await loadSheetJs()
    } catch (e) {
      alert(`Failed to load XLSX library: ${e?.message || e}`)
      return
    }

    const wb = XLSX.utils.book_new()
    const usedNames = new Set()
    const HEADERS = ['AVP Name', 'AVP Content', 'AVP Flags']

    function makeSheetName(raw, index) {
      // Excel sheet names: max 31 chars, cannot contain \ / ? * [ ] :
      let base = String(raw || '').replace(/\s+/g, ' ')
      base = base.replace(/[\\/\?\*\[\]:]/g, '_').trim()
      if (!base) base = `Flow_${index + 1}`
      if (base.length > 31) base = base.slice(0, 31)
      let candidate = base
      let counter = 2
      while (usedNames.has(candidate)) {
        const sfx = '_' + counter++
        candidate = base.slice(0, Math.max(1, 31 - sfx.length)) + sfx
      }
      usedNames.add(candidate)
      return candidate
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (STATE.status) STATE.status.textContent = `Building Excel... (${i + 1}/${rows.length})`

      let avpRows = []
      try {
        const url = `/webshark/diameter-avps?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(r.frame)}`
        const res = await fetch(url)
        const data = await res.json()
        avpRows = Array.isArray(data.rows) ? data.rows : []
      } catch {
        avpRows = []
      }

      const srcAlias = getIpAlias(r.src) || r.src
      const dstAlias = getIpAlias(r.dst) || r.dst
      const label = rowDisplayLabel(r)
      const authApp = String(r.authApplicationId || '').toLowerCase()
      const iface = authApp.includes('3gpp gx') ? 'Gx' : 'Gy'
      const suffix = getSeqDiagSuffix()
      const lineForName = `${srcAlias}->${dstAlias}:${label}\\nRefer to ${iface} ${label} ${suffix}`

      const sheetName = makeSheetName(lineForName, i)
      const data = avpRows.map(a => ({
        'AVP Name': a.avpName || '',
        'AVP Content': a.avpContent || '',
        'AVP Flags': a.avpFlags || ''
      }))

      const ws = XLSX.utils.json_to_sheet(data, { header: HEADERS })

      // Auto column width based on content length (cap at 80 chars)
      const maxW = HEADERS.map(h => h.length)
      data.forEach(row => {
        HEADERS.forEach((h, idx) => {
          const v = String(row[h] || '')
          if (v.length > maxW[idx]) maxW[idx] = v.length
        })
      })
      ws['!cols'] = HEADERS.map((_, idx) => ({ wch: Math.min(80, maxW[idx] + 3) }))

      // Basic styling hints via cell comments (SheetJS is mainly data-focused;
      // consumer can further style if needed).
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
    }

    const baseName = `diameter_flows_${capture || 'capture'}.xlsx`
    try {
      XLSX.writeFile(wb, baseName)
      if (STATE.status) {
        STATE.status.textContent = 'Excel exported!'
        setTimeout(() => {
          if (STATE.status && STATE.status.textContent === 'Excel exported!') {
            STATE.status.textContent = 'Ready'
          }
        }, 2000)
      }
    } catch (e) {
      alert(`XLSX export failed: ${e?.message || e}`)
      if (STATE.status) STATE.status.textContent = 'Excel export failed'
    }
  }

  function exportFlowsTxt() {
    const rows = Array.isArray(STATE.flowsRows) ? STATE.flowsRows : []
    if (!rows.length) return

    const capture = (STATE.currentCapture || '').trim()
    const suffix = getSeqDiagSuffix()

    const lines = []
    rows.forEach(r => {
      const srcAlias = getIpAlias(r.src) || r.src
      const dstAlias = getIpAlias(r.dst) || r.dst
      const label = rowDisplayLabel(r)
      const authApp = String(r.authApplicationId || '').toLowerCase()
      const iface = authApp.includes('3gpp gx') ? 'Gx' : 'Gy'
      lines.push(
        `${srcAlias}->${dstAlias}:${label}\\n` +
        `Refer to ${iface} ${label} ${suffix}`
      )
    })

    const text = lines.join('\n')
    const base = `diameter_seqdiag_${capture || 'capture'}.txt`
    downloadText(base, text)

    // 同时自动在新标签页打开 sequencediagram.org 并预填内容
    try {
      const encoded = encodeURIComponent(text)
      const url = `https://sequencediagram.org/index.html#initialData=${encoded}`
      window.open(url, '_blank')
    } catch { }
  }

  function addFlowRow() {
    const src = window.prompt('Source IP', 'PCEF')
    if (src == null) return
    const dst = window.prompt('Destination IP', 'OCS')
    if (dst == null) return
    const text = window.prompt('Message text', 'CCR-(INITIAL_REQUEST (1))')
    if (text == null) return
    const sid = window.prompt('Session-Id (optional)', '')
    if (sid == null) return
    const frame = window.prompt('Frame number (optional)', '')
    if (frame == null) return

    const row = {
      src: src.trim(),
      dst: dst.trim(),
      frame: Number(frame) || '',
      info: '',
      sessionId: sid.trim(),
      ccRequestType: '',
      customLabel: text.trim() || 'DIAMETER'
    }
    if (!Array.isArray(STATE.flowsAllRows)) STATE.flowsAllRows = []
    STATE.flowsAllRows.push(row)
    if (STATE.currentCapture) STATE.flowsCache.set(STATE.currentCapture, STATE.flowsAllRows)
    refreshFlowsByFilter()
  }

  function editSelectedFlowRow() {
    const i = STATE.flowsSelectedIndex
    const rows = STATE.flowsRows || []
    if (i < 0 || i >= rows.length) return
    const r = rows[i]
    const src = window.prompt('Source IP', r.src || '')
    if (src == null) return
    const dst = window.prompt('Destination IP', r.dst || '')
    if (dst == null) return
    const text = window.prompt('Message text', rowDisplayLabel(r) || '')
    if (text == null) return
    const sid = window.prompt('Session-Id (optional)', r.sessionId || '')
    if (sid == null) return
    const frame = window.prompt('Frame number (optional)', String(r.frame || ''))
    if (frame == null) return

    r.src = src.trim()
    r.dst = dst.trim()
    r.sessionId = sid.trim()
    r.frame = Number(frame) || ''
    r.customLabel = text.trim() || 'DIAMETER'
    if (STATE.currentCapture) STATE.flowsCache.set(STATE.currentCapture, STATE.flowsAllRows)
    renderDiameterFlows(rows)
  }

  function deleteSelectedFlowRow() {
    const i = STATE.flowsSelectedIndex
    const rows = STATE.flowsRows || []
    if (i < 0 || i >= rows.length) return
    const target = rows[i]
    const all = Array.isArray(STATE.flowsAllRows) ? STATE.flowsAllRows : rows
    const idxAll = all.indexOf(target)
    if (idxAll >= 0) all.splice(idxAll, 1)
    STATE.flowsSelectedIndex = -1
    if (STATE.currentCapture) STATE.flowsCache.set(STATE.currentCapture, all)
    refreshFlowsByFilter()
  }

  function formatUtcDateTime(epochSec) {
    const n = Number(epochSec)
    if (!Number.isFinite(n)) return ''
    const d = new Date(n * 1000)
    const Y = d.getUTCFullYear()
    const M = String(d.getUTCMonth() + 1).padStart(2, '0')
    const D = String(d.getUTCDate()).padStart(2, '0')
    const h = String(d.getUTCHours()).padStart(2, '0')
    const m = String(d.getUTCMinutes()).padStart(2, '0')
    const s = String(d.getUTCSeconds()).padStart(2, '0')
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
    return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms} UTC`
  }

  async function getCaptureBaseEpoch(capture) {
    const key = String(capture || '').trim()
    if (!key) return null
    if (STATE.captureEpochCache.has(key)) {
      return await STATE.captureEpochCache.get(key)
    }

    const p = (async () => {
      try {
        const url = `/webshark/json?method=frame&capture=${encodeURIComponent(key)}&frame=1&proto=true`
        const res = await fetch(url)
        const data = await res.json()

        let epoch = null
        function walk(nodes) {
          for (const n of nodes || []) {
            if (!n || typeof n !== 'object') continue
            const l = String(n.l || '')
            const m = l.match(/Epoch Arrival Time:\s*([0-9]+(?:\.[0-9]+)?)/i)
            if (m) {
              epoch = Number(m[1])
              return
            }
            walk(n.n || [])
            if (epoch != null) return
          }
        }

        walk(data && data.tree)
        return Number.isFinite(epoch) ? epoch : null
      } catch {
        return null
      }
    })()

    STATE.captureEpochCache.set(key, p)
    const val = await p
    STATE.captureEpochCache.set(key, Promise.resolve(val))
    return val
  }

  function enhanceWebsharkTimeColumn() {
    const capture = ((STATE.captureInput && STATE.captureInput.value) || getCaptureName() || '').trim()
    if (!capture) return

    getCaptureBaseEpoch(capture)
      .then(baseEpoch => {
        if (!Number.isFinite(baseEpoch)) return
        const rows = document.querySelectorAll('table tr, [role="row"]')
        rows.forEach(tr => {
          const cells = tr.querySelectorAll('td, [role="gridcell"]')
          if (!cells || cells.length < 2) return
          const timeCell = cells[1]
          if (!timeCell) return

          const raw = String(timeCell.getAttribute('data-dia-rel') || (timeCell.textContent || '').trim())
          if (!/^\d+(\.\d+)?$/.test(raw)) return

          const rel = Number(raw)
          if (!Number.isFinite(rel)) return

          const abs = baseEpoch + rel
          const fmt = formatUtcDateTime(abs)
          if (!fmt) return

          if (timeCell.getAttribute('data-dia-timefmt') === '1' && timeCell.textContent === fmt) return

          timeCell.setAttribute('data-dia-timefmt', '1')
          timeCell.setAttribute('data-dia-rel', raw)
          timeCell.setAttribute('title', `relative=${raw}s | epoch=${abs.toFixed(6)}`)
          timeCell.textContent = fmt
        })
      })
      .catch(() => { })
  }

  function scheduleEnhanceWebsharkTimeColumn() {
    if (STATE.timeEnhanceTimer) clearTimeout(STATE.timeEnhanceTimer)
    STATE.timeEnhanceTimer = setTimeout(() => {
      STATE.timeEnhanceTimer = null
      enhanceWebsharkTimeColumn()
    }, 220)
  }

  function tryGetCaptureFromUrl() {
    try {
      const u = new URL(location.href)
      const qCap = u.searchParams.get('capture')
      if (qCap) return decodeURIComponent(qCap).replace(/^\/+/, '')

      const hash = (u.hash || '').replace(/^#/, '')
      if (hash) {
        const hs = new URLSearchParams(hash)
        const hCap = hs.get('capture')
        if (hCap) return decodeURIComponent(hCap).replace(/^\/+/, '')
      }

      const p = decodeURIComponent(u.pathname || '')
      const m = p.match(/\/webshark\/(.+\.pcapng?|.+\.pcap)$/i)
      if (m && m[1]) return m[1].replace(/^\/+/, '')

      const all = decodeURIComponent(location.href || '')
      const m2 = all.match(/([\w .\-]+\.pcapng?)/i)
      if (m2) return m2[1]
    } catch { }
    return ''
  }

  function getCaptureName() {
    const fromUrl = tryGetCaptureFromUrl()
    if (fromUrl) return fromUrl

    const txt = document.body.innerText || ''
    const m = txt.match(/([\w .\-]+\.pcapng?)/i)
    if (m) return m[1]

    try {
      const last = localStorage.getItem(CAP_KEY) || ''
      if (last) return last
    } catch { }

    return ''
  }

  function extractFrameFromText(s) {
    const t = String(s || '')
    const m = t.match(/\b(\d{1,7})\b/)
    return m ? Number(m[1]) : ''
  }

  function getCurrentFrame() {
    const selected = document.querySelector(
      '[aria-selected="true"], tr.selected, .selected, .is-selected, .packet-selected'
    )
    if (selected) {
      const firstCell = selected.querySelector('td, [role="gridcell"], div')
      const n1 = extractFrameFromText(firstCell ? firstCell.textContent : '')
      if (n1) return n1

      const n2 = extractFrameFromText(selected.textContent)
      if (n2) return n2
    }

    const txt = document.body.innerText || ''
    const m = txt.match(/Frame\s+(\d+)\s*:/i)
    if (m) return Number(m[1])

    return ''
  }

  function currentKey() {
    const capture = ((STATE.captureInput && STATE.captureInput.value) || '').trim()
    const frame = ((STATE.frameInput && STATE.frameInput.value) || '').trim()
    if (!capture || !frame) return ''
    return `${capture}#${frame}`
  }

  function syncCaptureAndFrame() {
    const oldCap = ((STATE.captureInput && STATE.captureInput.value) || '').trim()
    const oldFrame = ((STATE.frameInput && STATE.frameInput.value) || '').trim()

    const frame = getCurrentFrame()
    const now = Date.now()
    if (
      frame &&
      STATE.frameInput &&
      now >= STATE.suppressFrameSyncUntil &&
      !STATE.freezeFrameSyncWhileFlowsOpen
    ) {
      STATE.frameInput.value = frame
    }

    const cap = getCaptureName()
    if (cap && STATE.captureInput) {
      STATE.captureInput.value = cap
      try {
        localStorage.setItem(CAP_KEY, cap)
      } catch { }
    }

    const newCap = ((STATE.captureInput && STATE.captureInput.value) || '').trim()
    const newFrame = ((STATE.frameInput && STATE.frameInput.value) || '').trim()
    return oldCap !== newCap || oldFrame !== newFrame
  }

  async function tryAutofillCaptureFromServer() {
    if (!STATE.captureInput) return
    if ((STATE.captureInput.value || '').trim()) return

    try {
      const res = await fetch('/webshark/json?method=files')
      const txt = await res.text()
      let data = null
      try {
        data = JSON.parse(txt)
      } catch {
        return
      }

      const files = Array.isArray(data && data.files) ? data.files : []
      if (!files.length) return

      const online = files.find(f => f && f.status && f.status.online && f.name)
      const picked = (online && online.name) || (files[0] && files[0].name) || ''
      if (picked) {
        STATE.captureInput.value = String(picked).replace(/^\/+/, '')
        try {
          localStorage.setItem(CAP_KEY, STATE.captureInput.value)
        } catch { }
      }
    } catch { }
  }

  function renderRows(rows) {
    if (!rows.length) return '<div style="opacity:.7">No Diameter AVP found in this frame.</div>'
    const head =
      '<thead><tr><th style="text-align:left;padding:4px">AVP Name</th><th style="text-align:left;padding:4px">AVP Content</th><th style="text-align:left;padding:4px">AVP Flags</th></tr></thead>'
    const body = rows
      .map(
        r =>
          `<tr><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpName || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpContent || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpFlags || '')}</td></tr>`
      )
      .join('')
    return `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`
  }

  async function loadDiameter(opts = {}) {
    if (STATE.loading) return
    showDiameterPanel()

    if (!opts.skipSync) {
      syncCaptureAndFrame()
      await tryAutofillCaptureFromServer()
    }

    const capture = (STATE.captureInput.value || '').trim()
    const frame = (STATE.frameInput.value || '').trim()

    if (!capture || !frame) {
      if (!opts.silent) {
        STATE.status.textContent = 'capture/frame 不能为空（请先在包列表选中一行，或手动填写）'
      }
      return
    }

    const key = `${capture}#${frame}`
    if (opts.auto && key === STATE.lastLoadedKey) return

    STATE.loading = true
    STATE.status.textContent = 'Loading Diameter AVP...'
    if (!opts.keepTable) STATE.tableWrap.innerHTML = ''

    try {
      const url = `/webshark/diameter-avps?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(frame)}`
      const res = await fetch(url)
      const data = await res.json()
      const rows = Array.isArray(data.rows) ? data.rows : []
      STATE.currentRows = rows
      STATE.currentCapture = capture
      STATE.currentFrame = frame
      STATE.tableWrap.innerHTML = renderRows(rows)
      STATE.status.textContent = `Loaded ${rows.length} AVP(s)`
      STATE.lastLoadedKey = key
      try {
        localStorage.setItem(CAP_KEY, capture)
      } catch { }
    } catch (e) {
      STATE.status.textContent = `Load failed: ${e.message || String(e)}`
    } finally {
      STATE.loading = false
    }
  }

  function scheduleAutoLoad() {
    if (STATE.freezeFrameSyncWhileFlowsOpen) return
    const key = currentKey()
    if (!key || key === STATE.lastLoadedKey) return
    clearTimeout(STATE.autoLoadTimer)
    STATE.autoLoadTimer = setTimeout(() => {
      loadDiameter({ auto: true, silent: true })
    }, 240)
  }

  function startDisplayFilterProgress() {
    STATE.filterApplyPending = true
    let step = 0
    clearInterval(STATE.filterApplyTicker)
    if (STATE.status) STATE.status.textContent = 'Applying display filter'
    STATE.filterApplyTicker = setInterval(() => {
      step = (step + 1) % 4
      if (STATE.status && STATE.filterApplyPending) {
        STATE.status.textContent = `Applying display filter${'.'.repeat(step)}`
      }
    }, 260)
  }

  function stopDisplayFilterProgress(ok = true) {
    const wasPending = STATE.filterApplyPending
    STATE.filterApplyPending = false
    clearInterval(STATE.filterApplyTicker)
    STATE.filterApplyTicker = null
    if (!wasPending || !STATE.status) return
    STATE.status.textContent = ok ? 'Display filter applied' : 'Display filter apply timeout'
    setTimeout(() => {
      if (!STATE.filterApplyPending && STATE.status && String(STATE.status.textContent || '').includes('Display filter')) {
        STATE.status.textContent = 'Ready'
      }
    }, 1200)
  }

  function getDisplayFilterInputs() {
    const strict = Array.from(
      document.querySelectorAll('input[placeholder="Apply a display filter"], input.field-sticky[placeholder*="display filter"]')
    ).filter(el => el && el.id !== 'dia-cap' && el.id !== 'dia-frame')

    const fallback = Array.from(document.querySelectorAll('input, textarea')).filter(el => {
      if (!el || el.id === 'dia-cap' || el.id === 'dia-frame') return false
      const text = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase()
      return text.includes('apply a display filter') || (text.includes('display') && text.includes('filter'))
    })

    // Merge + de-dup (keep order preference: strict first)
    return Array.from(new Set([...strict, ...fallback]))
  }

  function bindDisplayFilterProgressInput() {
    const list = getDisplayFilterInputs()
    list.forEach(el => {
      if (!el || el.id === 'dia-cap' || el.id === 'dia-frame') return
      if (el.dataset.diaFilterProgressBound === '1') return
      el.dataset.diaFilterProgressBound = '1'
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          // User manually applied filter; never force default filter back.
          STATE.defaultDisplayFilterPrimed = true
          startDisplayFilterProgress()
          setTimeout(() => {
            if (STATE.filterApplyPending) stopDisplayFilterProgress(false)
          }, 8000)
        }
      })
    })
  }

  function applyDefaultDisplayFilter() {
    // Apply only once per page lifetime. If user clears/deletes filter later,
    // do NOT auto-fill it again.
    if (STATE.defaultDisplayFilterPrimed) return false

    const target = 'diameter.cmd.code==272'
    const list = getDisplayFilterInputs()
    const candidate = list.find(el => el.offsetParent !== null) || list[0]
    if (!candidate) return false

    const cur = String(candidate.value || '').trim()
    if (cur) {
      STATE.defaultDisplayFilterPrimed = true
      return true
    }

    candidate.focus()
    candidate.value = target
    candidate.dispatchEvent(new Event('input', { bubbles: true }))
    candidate.dispatchEvent(new Event('change', { bubbles: true }))
    candidate.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    candidate.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))

    STATE.defaultDisplayFilterPrimed = true
    return true
  }

  function savePanelPos() {
    if (!STATE.panel) return
    const left = parseInt(STATE.panel.style.left || '0', 10)
    const top = parseInt(STATE.panel.style.top || '0', 10)
    if (Number.isFinite(left) && Number.isFinite(top)) {
      localStorage.setItem(POS_KEY, JSON.stringify({ left, top }))
    }
  }

  function savePanelSize() {
    if (!STATE.panel) return
    const width = Math.round(STATE.panel.getBoundingClientRect().width)
    const height = Math.round(STATE.panel.getBoundingClientRect().height)
    if (width > 0 && height > 0) {
      localStorage.setItem(SIZE_KEY, JSON.stringify({ width, height }))
    }
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v))
  }

  function applyPanelPos(pos) {
    if (!STATE.panel || !pos) return
    const maxLeft = Math.max(0, window.innerWidth - STATE.panel.offsetWidth)
    const maxTop = Math.max(0, window.innerHeight - STATE.panel.offsetHeight)
    const left = clamp(Number(pos.left) || 0, 0, maxLeft)
    const top = clamp(Number(pos.top) || 0, 0, maxTop)

    STATE.panel.style.left = `${left}px`
    STATE.panel.style.top = `${top}px`
    STATE.panel.style.right = 'auto'
    STATE.panel.style.bottom = 'auto'
  }

  function applyPanelSize(size) {
    if (!STATE.panel || !size) return
    const maxWidth = Math.max(420, window.innerWidth - 20)
    const maxHeight = Math.max(220, window.innerHeight - 20)
    const width = clamp(Number(size.width) || 640, 420, maxWidth)
    const height = clamp(Number(size.height) || 260, 220, maxHeight)
    STATE.panel.style.width = `${width}px`
    STATE.panel.style.height = `${height}px`
  }

  function initDrag() {
    const header = STATE.dragHandle
    if (!header || !STATE.panel) return

    header.style.cursor = 'move'

    header.addEventListener('mousedown', e => {
      if (e.button !== 0) return
      STATE.drag.active = true
      const rect = STATE.panel.getBoundingClientRect()
      STATE.drag.dx = e.clientX - rect.left
      STATE.drag.dy = e.clientY - rect.top
      e.preventDefault()
    })

    document.addEventListener('mousemove', e => {
      if (!STATE.drag.active || !STATE.panel) return
      const maxLeft = Math.max(0, window.innerWidth - STATE.panel.offsetWidth)
      const maxTop = Math.max(0, window.innerHeight - STATE.panel.offsetHeight)
      const left = clamp(e.clientX - STATE.drag.dx, 0, maxLeft)
      const top = clamp(e.clientY - STATE.drag.dy, 0, maxTop)

      STATE.panel.style.left = `${left}px`
      STATE.panel.style.top = `${top}px`
      STATE.panel.style.right = 'auto'
      STATE.panel.style.bottom = 'auto'
    })

    document.addEventListener('mouseup', () => {
      if (!STATE.drag.active) return
      STATE.drag.active = false
      savePanelPos()
      savePanelSize()
    })
  }

  function normalizeDiameterLabel(info, ccType = '') {
    const text = String(info || '')
    const upper = text.toUpperCase()

    const ccTypeMap = {
      INITIAL_REQUEST: 'I',
      UPDATE_REQUEST: 'U',
      TERMINATION_REQUEST: 'T',
      EVENT_REQUEST: 'E'
    }

    const ccTypeText = String(ccType || '').trim()

    let suf = ''
    Object.keys(ccTypeMap).some(k => {
      if (upper.includes(k) || ccTypeText.toUpperCase().includes(k)) {
        suf = ccTypeMap[k]
        return true
      }
      return false
    })

    // Credit-Control (Gy/Gx) messages:
    // - Wireshark verbose: "Credit-Control Request", "Credit-Control Answer"
    // - Short form (info field): "CCR-(INITIAL_REQUEST (1))", "CCA-(TERMINATION_REQUEST (3))", etc.
    const isCcrLike =
      upper.includes('CREDIT-CONTROL REQUEST') ||
      upper.startsWith('CCR-') ||
      upper.startsWith('CCR ')
    const isCcaLike =
      upper.includes('CREDIT-CONTROL ANSWER') ||
      upper.startsWith('CCA-') ||
      upper.startsWith('CCA ')

    if (isCcrLike) {
      // 优先使用缩写：CCR-I / CCR-U / CCR-T / CCR-E
      if (suf) return `CCR-${suf}`
      // 如果 ccType 文本比较完整但没匹配到关键字，退回原始显示
      if (ccTypeText) return `CCR-(${ccTypeText})`
      return 'CCR'
    }
    if (isCcaLike) {
      if (suf) return `CCA-${suf}`
      if (ccTypeText) return `CCA-(${ccTypeText})`
      return 'CCA'
    }
    // Re-Auth: match both "RE-AUTH-REQUEST" (wireshark) and "RE-AUTH REQUEST" (full name)
    if (upper.includes('RE-AUTH-REQUEST') || upper.includes('RE-AUTH REQUEST')) return 'RAR'
    if (upper.includes('RE-AUTH-ANSWER') || upper.includes('RE-AUTH ANSWER')) return 'RAA'
    // Abort-Session
    if (upper.includes('ABORT-SESSION-REQUEST') || upper.includes('ABORT-SESSION REQUEST')) return 'ASR'
    if (upper.includes('ABORT-SESSION-ANSWER') || upper.includes('ABORT-SESSION ANSWER')) return 'ASA'
    // Session-Termination
    if (upper.includes('SESSION-TERMINATION-REQUEST') || upper.includes('SESSION-TERMINATION REQUEST')) return 'STR'
    if (upper.includes('SESSION-TERMINATION-ANSWER') || upper.includes('SESSION-TERMINATION ANSWER')) return 'STA'
    // Accounting
    if (upper.includes('ACCOUNTING-REQUEST') || upper.includes('ACCOUNTING REQUEST')) return 'ACR'
    if (upper.includes('ACCOUNTING-ANSWER') || upper.includes('ACCOUNTING ANSWER')) return 'ACA'
    // AA
    if (upper.includes('AA-REQUEST') || (upper.startsWith('AA ') && upper.includes('REQUEST'))) return 'AAR'
    if (upper.includes('AA-ANSWER') || (upper.startsWith('AA ') && upper.includes('ANSWER'))) return 'AAA'
    if (upper.includes('DEVICE-WATCHDOG REQUEST') || upper.includes('DEVICE-WATCHDOG-REQUEST')) return 'DWR'
    if (upper.includes('DEVICE-WATCHDOG ANSWER') || upper.includes('DEVICE-WATCHDOG-ANSWER')) return 'DWA'
    if (upper.includes('CAPABILITIES-EXCHANGE REQUEST') || upper.includes('CAPABILITIES-EXCHANGE-REQUEST')) return 'CER'
    if (upper.includes('CAPABILITIES-EXCHANGE ANSWER') || upper.includes('CAPABILITIES-EXCHANGE-ANSWER')) return 'CEA'
    if (upper.includes('DISCONNECT-PEER-REQUEST')) return 'DPR'
    if (upper.includes('DISCONNECT-PEER-ANSWER')) return 'DPA'

    return text.replace(/\s*\|.*$/, '').trim() || 'DIAMETER'
  }

  function extractFrameMetaFromTree(tree) {
    let sessionId = ''
    let ccRequestType = ''
    let authApplicationId = ''

    function walk(nodes) {
      for (const n of nodes || []) {
        if (!n || typeof n !== 'object') continue
        const l = String(n.l || '')
        if (!sessionId && l.startsWith('Session-Id:')) {
          sessionId = l.slice('Session-Id:'.length).trim()
        }
        if (!ccRequestType && l.startsWith('CC-Request-Type:')) {
          ccRequestType = l.slice('CC-Request-Type:'.length).trim()
        }
        if (!authApplicationId && l.startsWith('Auth-Application-Id:')) {
          authApplicationId = l.slice('Auth-Application-Id:'.length).trim()
        }
        if (sessionId && ccRequestType && authApplicationId) return
        walk(n.n || [])
        if (sessionId && ccRequestType && authApplicationId) return
      }
    }

    walk(tree || [])
    return { sessionId, ccRequestType, authApplicationId }
  }

  async function getFrameMeta(capture, frame) {
    const key = `${capture}#${frame}`
    if (STATE.frameMetaCache.has(key)) return STATE.frameMetaCache.get(key)

    const p = (async () => {
      try {
        const url = `/webshark/json?method=frame&capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(frame)}&proto=true`
        const res = await fetch(url)
        const data = await res.json()
        return extractFrameMetaFromTree(data && data.tree)
      } catch {
        return { sessionId: '', ccRequestType: '' }
      }
    })()

    STATE.frameMetaCache.set(key, p)
    const result = await p
    STATE.frameMetaCache.set(key, result)
    return result
  }

  async function enrichRowsWithFrameMeta(rows, capture, concurrency = 8, onProgress = null) {
    const out = rows.slice()
    let idx = 0
    let done = 0

    async function worker() {
      while (idx < out.length) {
        const i = idx++
        const r = out[i]
        const meta = await getFrameMeta(capture, r.frame)
        out[i] = { ...r, ...meta }
        done += 1
        if (onProgress) onProgress(done, out.length)
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, out.length)) }, () => worker()))
    return out
  }

  function closeFlowsModal() {
    if (STATE.flowsModal && STATE.flowsModal.parentNode) {
      STATE.flowsModal.parentNode.removeChild(STATE.flowsModal)
    }
    STATE.flowsModal = null
    STATE.freezeFrameSyncWhileFlowsOpen = false
  }

  function showFlowsLoadingModal(text = 'Building Diameter Flows...', ratio = null) {
    STATE.freezeFrameSyncWhileFlowsOpen = true
    if (!STATE.flowsModal) {
      const modal = document.createElement('div')
      modal.style.cssText = [
        'position:fixed',
        'inset:0',
        'background:rgba(0,0,0,.38)',
        'z-index:100000',
        'display:flex',
        'align-items:center',
        'justify-content:center'
      ].join(';')

      modal.innerHTML = `
        <div style="width:min(560px,92vw);background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden;">
          <div style="padding:10px 12px;background:#3f51b5;color:#fff;font-weight:600;">Diameter Flows</div>
          <div style="padding:16px 14px;">
            <div id="dia-flows-loading-text" style="font-size:13px;color:#333;margin-bottom:10px;">${escapeHtml(text)}</div>
            <div style="height:8px;background:#eceff1;border-radius:999px;overflow:hidden;">
              <div id="dia-flows-loading-bar" style="height:100%;width:${ratio == null ? 22 : Math.max(3, Math.min(100, Math.round(ratio * 100)))}%;background:#3f51b5;transition:width .25s ease;"></div>
            </div>
          </div>
        </div>
      `

      document.body.appendChild(modal)
      STATE.flowsModal = modal
    } else {
      const t = STATE.flowsModal.querySelector('#dia-flows-loading-text')
      if (t) t.textContent = text
      const b = STATE.flowsModal.querySelector('#dia-flows-loading-bar')
      if (b && ratio != null) {
        b.style.width = `${Math.max(3, Math.min(100, Math.round(ratio * 100)))}%`
      }
    }
  }

  function renderDiameterFlows(rows) {
    closeFlowsModal()
    STATE.freezeFrameSyncWhileFlowsOpen = true

    const modal = document.createElement('div')
    modal.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,.38)',
      'z-index:100000',
      'display:flex',
      'align-items:center',
      'justify-content:center'
    ].join(';')

    const panel = document.createElement('div')
    panel.style.cssText = [
      'width:min(1200px,96vw)',
      'height:min(86vh,900px)',
      'background:#fff',
      'border-radius:10px',
      'display:flex',
      'flex-direction:column',
      'box-shadow:0 8px 30px rgba(0,0,0,.25)',
      'overflow:hidden'
    ].join(';')

    const head = document.createElement('div')
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#3f51b5;color:#fff;font-weight:600;cursor:move;user-select:none;gap:8px;'
    const title = document.createElement('span')
    title.textContent = 'Diameter Flows (auto-generated)'
    head.appendChild(title)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;align-items:center;gap:6px;'

    const mkBtn = (txt, onClick) => {
      const b = document.createElement('button')
      b.textContent = txt
      b.style.cssText = 'border:1px solid rgba(255,255,255,.45);background:transparent;color:#fff;font-size:12px;padding:3px 7px;border-radius:4px;cursor:pointer;'
      b.addEventListener('mousedown', e => e.stopPropagation())
      b.addEventListener('click', e => {
        e.stopPropagation()
        onClick()
      })
      return b
    }

    const editBtn = mkBtn(STATE.flowsEditMode ? 'Editing: ON' : 'Editing: OFF', () => {
      STATE.flowsEditMode = !STATE.flowsEditMode
      STATE.flowsSelectedIndex = -1
      renderDiameterFlows(STATE.flowsRows || rows)
    })
    const addBtn = mkBtn('+ Line', addFlowRow)
    const editSelBtn = mkBtn('Edit', editSelectedFlowRow)
    const delSelBtn = mkBtn('Delete', deleteSelectedFlowRow)
    const filterBtn = mkBtn(
      STATE.sessionFilterSet && STATE.sessionFilterSet.size ? `Session-Id (${STATE.sessionFilterSet.size})` : 'Session-Id',
      openSessionFilterDialog
    )
    const expTxtBtn = mkBtn('Export sequencediagram', exportFlowsTxt)
    const expXlsxBtn = mkBtn('Export XLSX', exportFlowsXlsx)
    const seqCfgBtn = mkBtn('\u2699', () => {
      const cur = getSeqDiagSuffix()
      const next = window.prompt('Set the suffix text after message label (e.g. \"Normal AVP list\"):', cur)
      if (next === null) return
      setSeqDiagSuffix(next)
    })
    seqCfgBtn.title = 'Customize SeqDiag suffix text'

    if (!STATE.flowsEditMode) {
      addBtn.style.opacity = '.6'
      editSelBtn.style.opacity = '.6'
      delSelBtn.style.opacity = '.6'
      addBtn.style.pointerEvents = 'none'
      editSelBtn.style.pointerEvents = 'none'
      delSelBtn.style.pointerEvents = 'none'
    }

    const closeBtn = mkBtn('✕', closeFlowsModal)

    actions.appendChild(editBtn)
    actions.appendChild(addBtn)
    actions.appendChild(editSelBtn)
    actions.appendChild(delSelBtn)
    actions.appendChild(filterBtn)
    actions.appendChild(expTxtBtn)
    actions.appendChild(expXlsxBtn)
    actions.appendChild(seqCfgBtn)
    actions.appendChild(closeBtn)
    head.appendChild(actions)

    // Draggable modal panel (move by header)
    let drag = { active: false, sx: 0, sy: 0, tx: 0, ty: 0, ox: 0, oy: 0 }
    const applyModalOffset = () => {
      panel.style.transform = `translate(${drag.ox}px, ${drag.oy}px)`
    }
    head.addEventListener('mousedown', e => {
      if (e.button !== 0) return
      drag.active = true
      drag.sx = e.clientX
      drag.sy = e.clientY
      drag.tx = drag.ox
      drag.ty = drag.oy
      e.preventDefault()
    })
    document.addEventListener('mousemove', e => {
      if (!drag.active) return
      drag.ox = drag.tx + (e.clientX - drag.sx)
      drag.oy = drag.ty + (e.clientY - drag.sy)
      applyModalOffset()
    })
    document.addEventListener('mouseup', () => {
      drag.active = false
    })

    const body = document.createElement('div')
    body.style.cssText = 'flex:1;overflow:auto;padding:8px;background:#fafafa;'

    const participants = []
    const pSet = new Set()
    rows.forEach(r => {
      if (!pSet.has(r.src)) {
        pSet.add(r.src)
        participants.push(r.src)
      }
      if (!pSet.has(r.dst)) {
        pSet.add(r.dst)
        participants.push(r.dst)
      }
    })

    const W = Math.max(900, participants.length * 220)
    const H = Math.max(380, rows.length * 44 + 120)
    const xOf = idx => 120 + idx * ((W - 240) / Math.max(1, participants.length - 1))

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', String(H))
    svg.style.background = '#fff'

    participants.forEach((p, idx) => {
      const x = xOf(idx)
      const alias = getIpAlias(p)

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.style.cursor = 'pointer'
      g.addEventListener('click', () => {
        const current = getIpAlias(p)
        const next = window.prompt(`给 ${p} 设置显示名称（留空=清除）`, current || '')
        if (next === null) return
        setIpAlias(p, next)
        if (STATE.flowsRows && STATE.flowsRows.length) renderDiameterFlows(STATE.flowsRows)
      })

      if (alias) {
        const tAlias = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        tAlias.setAttribute('x', String(x))
        tAlias.setAttribute('y', '20')
        tAlias.setAttribute('text-anchor', 'middle')
        tAlias.setAttribute('font-size', '12')
        tAlias.setAttribute('font-family', 'Arial, sans-serif')
        tAlias.setAttribute('font-weight', '600')
        tAlias.textContent = alias
        g.appendChild(tAlias)

        const tIp = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        tIp.setAttribute('x', String(x))
        tIp.setAttribute('y', '34')
        tIp.setAttribute('text-anchor', 'middle')
        tIp.setAttribute('font-size', '10')
        tIp.setAttribute('font-family', 'Arial, sans-serif')
        tIp.setAttribute('fill', '#666')
        tIp.textContent = p
        g.appendChild(tIp)
      } else {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t.setAttribute('x', String(x))
        t.setAttribute('y', '26')
        t.setAttribute('text-anchor', 'middle')
        t.setAttribute('font-size', '12')
        t.setAttribute('font-family', 'Arial, sans-serif')
        t.textContent = p
        g.appendChild(t)
      }

      svg.appendChild(g)

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(x))
      line.setAttribute('x2', String(x))
      line.setAttribute('y1', '42')
      line.setAttribute('y2', String(H - 24))
      line.setAttribute('stroke', '#c7c7c7')
      line.setAttribute('stroke-dasharray', '4 4')
      svg.appendChild(line)
    })

    rows.forEach((r, i) => {
      const y = 56 + i * 38
      const sIdx = participants.indexOf(r.src)
      const dIdx = participants.indexOf(r.dst)
      if (sIdx < 0 || dIdx < 0) return

      const x1 = xOf(sIdx)
      const x2 = xOf(dIdx)
      const label = rowDisplayLabel(r)
      const color = label.startsWith('CCA') || label.endsWith('Answer') ? '#2e7d32' : '#1565c0'

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.style.cursor = 'pointer'
      g.addEventListener('click', async () => {
        if (STATE.flowsEditMode) {
          STATE.flowsSelectedIndex = i
          renderDiameterFlows(STATE.flowsRows || rows)
          return
        }
        await ensureMounted()
        STATE.suppressFrameSyncUntil = Date.now() + 1400
        if (STATE.frameInput) STATE.frameInput.value = String(r.frame)
        await loadDiameter({ auto: false, skipSync: true })
        if (STATE.panel) {
          STATE.panel.style.zIndex = '100001'
        }
      })

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(x1))
      line.setAttribute('x2', String(x2))
      line.setAttribute('y1', String(y))
      line.setAttribute('y2', String(y))
      line.setAttribute('stroke', color)
      line.setAttribute('stroke-width', String(STATE.flowsEditMode && STATE.flowsSelectedIndex === i ? 3 : 1.8))
      g.appendChild(line)

      const arr = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      const dir = x2 >= x1 ? 1 : -1
      const tipX = x2
      const pts = dir > 0
        ? `${tipX},${y} ${tipX - 8},${y - 4} ${tipX - 8},${y + 4}`
        : `${tipX},${y} ${tipX + 8},${y - 4} ${tipX + 8},${y + 4}`
      arr.setAttribute('points', pts)
      arr.setAttribute('fill', color)
      g.appendChild(arr)

      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      txt.setAttribute('x', String((x1 + x2) / 2))
      txt.setAttribute('y', String(y - 8))
      txt.setAttribute('text-anchor', 'middle')
      txt.setAttribute('font-size', '11')
      txt.setAttribute('font-family', 'Arial, sans-serif')
      txt.setAttribute('fill', '#1f1f1f')
      txt.textContent = `${label} (#${r.frame})`
      g.appendChild(txt)

      if (r.sessionId) {
        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t2.setAttribute('x', String((x1 + x2) / 2))
        t2.setAttribute('y', String(y + 8))
        t2.setAttribute('text-anchor', 'middle')
        t2.setAttribute('font-size', '10')
        t2.setAttribute('font-family', 'Arial, sans-serif')
        t2.setAttribute('fill', '#616161')
        t2.textContent = r.sessionId.length > 90 ? `${r.sessionId.slice(0, 87)}...` : r.sessionId
        g.appendChild(t2)
      }

      svg.appendChild(g)
    })

    body.appendChild(svg)

    const foot = document.createElement('div')
    foot.style.cssText = 'padding:8px 12px;border-top:1px solid #eee;font-size:12px;color:#555;background:#fff;'
    foot.textContent = 'Tip: click any arrow/message to auto-load that frame into DIAMETER AVP panel. Click top IP label to set custom name (e.g., OCS / PCEF).'

    panel.appendChild(head)
    panel.appendChild(body)
    panel.appendChild(foot)
    modal.appendChild(panel)

    modal.addEventListener('click', e => {
      if (e.target === modal) closeFlowsModal()
    })

    document.body.appendChild(modal)
    STATE.flowsModal = modal
  }

  async function openDiameterFlows() {
    await ensureMounted()
    syncCaptureAndFrame()
    await tryAutofillCaptureFromServer()

    const capture = (STATE.captureInput.value || '').trim()
    STATE.currentCapture = capture
    if (!capture) {
      STATE.status.textContent = '请先选择 capture 后再打开 Diameter Flows'
      return
    }

    STATE.status.textContent = 'Building Diameter Flows...'

    const cached = STATE.flowsCache.get(capture)
    if (cached && Array.isArray(cached) && cached.length) {
      STATE.flowsAllRows = cached
      STATE.flowsRows = applySessionFilterToRows(cached)
      STATE.flowsSelectedIndex = -1
      renderDiameterFlows(STATE.flowsRows)
      if (STATE.flowsRows[0]) {
        if (STATE.frameInput) STATE.frameInput.value = String(STATE.flowsRows[0].frame)
        loadDiameter({ auto: false, keepTable: false, skipSync: true })
      }
      STATE.status.textContent = `Diameter Flows ready (${STATE.flowsRows.length} messages, cached)`
      return
    }

    showFlowsLoadingModal('Building Diameter Flows...', 0.12)

    try {
      const url = `/webshark/json?method=frames&capture=${encodeURIComponent(capture)}`
      const res = await fetch(url)
      const data = await res.json()
      const all = Array.isArray(data) ? data : []

      const rows = all
        .map(item => {
          const c = Array.isArray(item && item.c) ? item.c : []
          return {
            frame: Number(item.num || c[0] || 0),
            src: String(c[2] || ''),
            dst: String(c[3] || ''),
            proto: String(c[4] || ''),
            info: String(c[6] || '')
          }
        })
        .filter(r => r.frame > 0 && /diameter/i.test(r.proto))
        // Exclude Device-Watchdog messages from sequence chart.
        .filter(r => !/device-watchdog\s+(request|answer)/i.test(r.info))

      if (!rows.length) {
        closeFlowsModal()
        STATE.status.textContent = 'No Diameter frames found in this capture.'
        return
      }

      showFlowsLoadingModal(`Parsing Diameter frames... (0/${rows.length})`, 0.2)
      const enriched = await enrichRowsWithFrameMeta(rows, capture, 8, (done, total) => {
        showFlowsLoadingModal(`Parsing Diameter frames... (${done}/${total})`, 0.2 + (done / Math.max(1, total)) * 0.75)
      })

      STATE.flowsAllRows = enriched
      STATE.flowsRows = applySessionFilterToRows(enriched)
      STATE.flowsSelectedIndex = -1
      STATE.flowsCache.set(capture, enriched)
      renderDiameterFlows(STATE.flowsRows)

      // auto-show panel and load first message as requested
      if (STATE.flowsRows[0]) {
        if (STATE.frameInput) STATE.frameInput.value = String(STATE.flowsRows[0].frame)
        loadDiameter({ auto: false, keepTable: false, skipSync: true })
      }

      STATE.status.textContent = `Diameter Flows ready (${STATE.flowsRows.length} messages)`
    } catch (e) {
      closeFlowsModal()
      STATE.status.textContent = `Diameter Flows failed: ${e.message || String(e)}`
    }
  }

  function tryInjectDiameterFlowsMenu() {
    if (document.querySelector('[data-dia-flows-item="1"]')) return

    const knownItems = new Set([
      'udp multicast streams',
      'rtp streams',
      'protocol hierarchy statistics',
      'voip calls',
      'voip conversations',
      'expert information',
      'all flows',
      'icmp flows',
      'icmpv6 flows',
      'uim flows',
      'tcp flows'
    ])

    const textNodes = Array.from(document.querySelectorAll('button, [role="menuitem"], .mat-mdc-menu-item, .mat-menu-item, li, div, span'))
    const anchor = textNodes.find(el => {
      const t = (el.textContent || '').trim().toLowerCase()
      return knownItems.has(t)
    })

    if (!anchor) return

    const row = anchor.closest('button, [role="menuitem"], .mat-mdc-menu-item, .mat-menu-item, li, div') || anchor
    const host = row.parentElement
    if (!host) return

    const tag = (row.tagName || 'button').toLowerCase()
    const item = document.createElement(tag)
    item.setAttribute('data-dia-flows-item', '1')
    item.textContent = 'Diameter Flows'

    // Reuse current menu item class for consistent look.
    if (row.className) item.className = row.className
    if (row.getAttribute('role')) item.setAttribute('role', row.getAttribute('role'))
    if (row.getAttribute('tabindex')) item.setAttribute('tabindex', row.getAttribute('tabindex'))

    // Ensure clickability even if cloned element is non-button.
    if (tag !== 'button') {
      item.style.cursor = 'pointer'
      item.style.userSelect = 'none'
    }

    item.addEventListener('click', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      openDiameterFlows()
    })

    host.insertBefore(item, row.nextSibling)
  }

  function installMenuInjector() {
    tryInjectDiameterFlowsMenu()
    if (STATE.menuInjectObserver) return

    const mo = new MutationObserver(() => {
      tryInjectDiameterFlowsMenu()
    })
    mo.observe(document.body, { subtree: true, childList: true })
    STATE.menuInjectObserver = mo
  }

  function ensureDiameterLauncherButton() {
    if (STATE.reopenBtn) return STATE.reopenBtn
    const reopenBtn = document.createElement('button')
    reopenBtn.id = 'dia-reopen'
    reopenBtn.textContent = 'DIAMETER'
    reopenBtn.title = 'Open DIAMETER panel'
    reopenBtn.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'z-index:100000',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:8px 12px',
      'border:1px solid #3f51b5',
      'background:#3f51b5',
      'color:#fff',
      'border-radius:16px',
      'cursor:pointer',
      'font-size:12px'
    ].join(';')
    reopenBtn.addEventListener('click', () => {
      if (!STATE.mounted) {
        mount()
      }
      showDiameterPanel()
    })
    document.body.appendChild(reopenBtn)
    STATE.reopenBtn = reopenBtn
    return reopenBtn
  }

  function hideDiameterPanel() {
    if (!STATE.panel) return
    STATE.panel.style.display = 'none'
    ensureDiameterLauncherButton().style.display = 'flex'
  }

  function showDiameterPanel() {
    if (!STATE.panel) {
      if (!STATE.mounted) mount()
      if (!STATE.panel) return
    }
    STATE.panel.style.display = 'flex'
    if (STATE.reopenBtn) STATE.reopenBtn.style.display = 'none'
  }

  function installNetworkProgressHint() {
    if (window.__diaFetchHooked) return
    window.__diaFetchHooked = true

    const box = document.createElement('div')
    box.id = 'dia-net-indicator'
    box.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:100000',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'padding:12px 16px',
      'background:linear-gradient(180deg,rgba(63,81,181,.95) 0%,rgba(48,63,159,.95) 100%)',
      'color:#fff',
      'font-size:14px',
      'font-weight:500',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)'
    ].join(';')
    box.innerHTML = [
      '<span id="dia-net-text" style="margin-bottom:8px;">Loading...</span>',
      '<div style="width:100%;max-width:320px;height:6px;background:rgba(255,255,255,.25);border-radius:999px;overflow:hidden;">',
      '<div id="dia-net-bar" style="height:100%;width:30%;background:#fff;border-radius:999px;animation:diaNetBar 1.2s ease-in-out infinite;"></div>',
      '</div>'
    ].join('')
    document.body.appendChild(box)
    STATE.netIndicator = box

    if (!document.getElementById('dia-net-style')) {
      const st = document.createElement('style')
      st.id = 'dia-net-style'
      st.textContent = [
        '@keyframes diaPulse{0%{opacity:.25}50%{opacity:1}100%{opacity:.25}}',
        '@keyframes diaNetBar{0%{transform:translateX(-100%)}50%{transform:translateX(230%)}100%{transform:translateX(-100%)}}',
        '/* 隐藏左上角拉风箱/菜单按钮 */',
        '[class*="mat-toolbar"] button:first-of-type, header button:first-of-type, .mat-toolbar button:first-of-type { display: none !important; }'
      ].join('\n')
      document.head.appendChild(st)
    }

    let pending = 0
    const origFetch = window.fetch.bind(window)
    function classify(url) {
      const u = String(url || '')
      if (u.includes('/webshark/upload')) return '导入文件中...'
      if (u.includes('method=files')) return '加载文件列表中...'
      if (u.includes('method=frames')) return '加载消息列表中...'
      if (u.includes('method=frame')) return '加载消息详情中...'
      return '处理中...'
    }

    window.fetch = async (...args) => {
      const url = args[0]
      const u = String(url || '')
      const hit = u.includes('/webshark/')
      const isUpload = u.includes('/webshark/upload')
      let msg = ''
      if (hit) {
        pending += 1
        msg = classify(url)
        const t = box.querySelector('#dia-net-text')
        if (t) t.textContent = pending > 1 ? `${msg} (${pending})` : msg
        box.style.display = 'flex'
        box.style.alignItems = 'center'
        if (STATE.panel) STATE.panel.style.display = 'none'
      }
      let resp
      try {
        resp = await origFetch(...args)
        if (isUpload && resp && resp.ok) {
          STATE.flowsCache.clear()
          STATE.captureEpochCache.clear()
        }
        return resp
      } finally {
        if (hit) {
          pending = Math.max(0, pending - 1)
          if (pending === 0) {
            box.style.display = 'none'
            if (STATE.panel) showDiameterPanel()
            if (STATE.filterApplyPending) stopDisplayFilterProgress(true)
          }
        }
      }
    }
  }

  async function ensureMounted() {
    if (STATE.mounted) {
      showDiameterPanel()
      return
    }
    mount()
  }

  function mount() {
    if (STATE.mounted) return

    const panel = document.createElement('div')
    panel.id = 'diameter-fixed-panel'
    panel.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:10px',
      'width:46vw',
      'max-width:980px',
      'min-width:420px',
      'height:38vh',
      'min-height:220px',
      'max-height:92vh',
      'background:#fff',
      'border:1px solid #3f51b5',
      'border-radius:6px',
      'box-shadow:0 4px 14px rgba(0,0,0,.18)',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'font-size:12px',
      'resize:both',
      'overflow:hidden'
    ].join(';')

    panel.innerHTML = `
      <div id="dia-drag-handle" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#3f51b5;color:#fff;font-weight:600;user-select:none;">
        <span>DIAMETER</span>
        <span style="opacity:.85;font-weight:400;">(independent panel, draggable + resizable)</span>
        <button id="dia-close" title="Close" style="margin-left:auto;border:0;background:transparent;color:#fff;font-size:16px;cursor:pointer;">✕</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid #eee;">
        <label>Capture</label>
        <input id="dia-cap" style="flex:1;min-width:140px;padding:3px 6px" />
        <label>Frame</label>
        <input id="dia-frame" style="width:90px;padding:3px 6px" />
        <button id="dia-load" style="padding:4px 10px;border:1px solid #3f51b5;background:#3f51b5;color:#fff;border-radius:4px;cursor:pointer;">Load</button>
        <button id="dia-flows" style="padding:4px 10px;border:1px solid #607d8b;background:#607d8b;color:#fff;border-radius:4px;cursor:pointer;">Diameter Flows</button>
      </div>
      <div id="dia-status" style="padding:6px 10px;color:#333;border-bottom:1px solid #f1f1f1;">Ready</div>
      <div id="dia-table" style="padding:8px 10px;overflow:auto;flex:1"></div>
    `

    document.body.appendChild(panel)

    STATE.panel = panel
    STATE.dragHandle = panel.querySelector('#dia-drag-handle')
    STATE.tableWrap = panel.querySelector('#dia-table')
    STATE.status = panel.querySelector('#dia-status')
    STATE.captureInput = panel.querySelector('#dia-cap')
    STATE.frameInput = panel.querySelector('#dia-frame')

    const reopenBtn = ensureDiameterLauncherButton()
    reopenBtn.title = 'Reopen DIAMETER panel'
    reopenBtn.style.display = 'none'

    panel.querySelector('#dia-close').addEventListener('click', e => {
      e.stopPropagation()
      hideDiameterPanel()
    })

    syncCaptureAndFrame()
    tryAutofillCaptureFromServer().then(() => scheduleAutoLoad())

    // Set default display filter when filter box appears.
    let filterTry = 0
    const filterTimer = setInterval(() => {
      filterTry += 1
      bindDisplayFilterProgressInput()
      const ok = applyDefaultDisplayFilter()
      scheduleEnhanceWebsharkTimeColumn()
      if (ok || filterTry >= 40) clearInterval(filterTimer)
    }, 300)

    panel.querySelector('#dia-load').addEventListener('click', () => loadDiameter({ auto: false }))
    panel.querySelector('#dia-flows').addEventListener('click', () => openDiameterFlows())

    document.addEventListener(
      'click',
      () => {
        const changed = syncCaptureAndFrame()
        if (changed) scheduleAutoLoad()
      },
      true
    )

    document.addEventListener('keyup', e => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        const changed = syncCaptureAndFrame()
        if (changed) scheduleAutoLoad()
      }
    })

    const mo = new MutationObserver(() => {
      const changed = syncCaptureAndFrame()
      if (changed) scheduleAutoLoad()
      bindDisplayFilterProgressInput()
      applyDefaultDisplayFilter()
      tryInjectDiameterFlowsMenu()
      scheduleEnhanceWebsharkTimeColumn()
    })
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected']
    })

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        savePanelSize()
        savePanelPos()
      })
      ro.observe(panel)
    }

    initDrag()

    try {
      const savedSize = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null')
      if (savedSize) applyPanelSize(savedSize)
    } catch { }

    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved) applyPanelPos(saved)
    } catch { }

    window.addEventListener('resize', () => {
      try {
        const savedSize = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null')
        if (savedSize) applyPanelSize(savedSize)
      } catch { }
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
        if (saved) applyPanelPos(saved)
      } catch { }
    })

    installMenuInjector()
    installNetworkProgressHint()

    // Expose APIs for future integration/testing.
    window.DiameterPanel = {
      openFlows: openDiameterFlows,
      loadFrame: async frame => {
        await ensureMounted()
        STATE.suppressFrameSyncUntil = Date.now() + 1400
        if (STATE.frameInput) STATE.frameInput.value = String(frame)
        await loadDiameter({ auto: false, skipSync: true })
      },
      ensureMounted
    }

    STATE.mounted = true
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        installNetworkProgressHint()
        ensureDiameterLauncherButton()
        ensureMounted()
      },
      { once: true }
    )
  } else {
    installNetworkProgressHint()
    ensureDiameterLauncherButton()
    ensureMounted()
  }
})()
