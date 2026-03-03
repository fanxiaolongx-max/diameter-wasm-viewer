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
    frameMetaCache: new Map()
  }

  const POS_KEY = 'diameter_fixed_panel_pos_v1'
  const SIZE_KEY = 'diameter_fixed_panel_size_v1'
  const CAP_KEY = 'diameter_fixed_panel_capture_v1'

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
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
    } catch {}
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
    } catch {}

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
    if (frame && STATE.frameInput) STATE.frameInput.value = frame

    const cap = getCaptureName()
    if (cap && STATE.captureInput) {
      STATE.captureInput.value = cap
      try {
        localStorage.setItem(CAP_KEY, cap)
      } catch {}
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
        } catch {}
      }
    } catch {}
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

    syncCaptureAndFrame()
    await tryAutofillCaptureFromServer()

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
      STATE.tableWrap.innerHTML = renderRows(data.rows || [])
      STATE.status.textContent = `Loaded ${Array.isArray(data.rows) ? data.rows.length : 0} AVP(s)`
      STATE.lastLoadedKey = key
      try {
        localStorage.setItem(CAP_KEY, capture)
      } catch {}
    } catch (e) {
      STATE.status.textContent = `Load failed: ${e.message || String(e)}`
    } finally {
      STATE.loading = false
    }
  }

  function scheduleAutoLoad() {
    const key = currentKey()
    if (!key || key === STATE.lastLoadedKey) return
    clearTimeout(STATE.autoLoadTimer)
    STATE.autoLoadTimer = setTimeout(() => {
      loadDiameter({ auto: true, silent: true })
    }, 240)
  }

  function applyDefaultDisplayFilter() {
    const target = 'diameter.cmd.code==272'

    // Prefer the exact WebShark display-filter input.
    const strict = Array.from(
      document.querySelectorAll('input[placeholder="Apply a display filter"], input.field-sticky[placeholder*="display filter"]')
    ).filter(el => el && el.id !== 'dia-cap' && el.id !== 'dia-frame')

    const visibleStrict = strict.find(el => el.offsetParent !== null) || strict[0]

    // Fallback (older UI variants)
    const fallback = Array.from(document.querySelectorAll('input, textarea')).find(el => {
      if (!el || el.id === 'dia-cap' || el.id === 'dia-frame') return false
      const text = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase()
      return text.includes('apply a display filter') || (text.includes('display') && text.includes('filter'))
    })

    const candidate = visibleStrict || fallback
    if (!candidate) return false

    const cur = String(candidate.value || '').trim()
    if (cur) return true

    candidate.focus()
    candidate.value = target
    candidate.dispatchEvent(new Event('input', { bubbles: true }))
    candidate.dispatchEvent(new Event('change', { bubbles: true }))
    candidate.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    candidate.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))

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

    if (upper.includes('CREDIT-CONTROL REQUEST')) {
      if (ccTypeText) return `CCR-(${ccTypeText})`
      return suf ? `CCR-${suf}` : 'CCR'
    }
    if (upper.includes('CREDIT-CONTROL ANSWER')) {
      if (ccTypeText) return `CCA-(${ccTypeText})`
      return suf ? `CCA-${suf}` : 'CCA'
    }
    if (upper.includes('RE-AUTH-REQUEST')) return 'RAR'
    if (upper.includes('RE-AUTH-ANSWER')) return 'RAA'
    if (upper.includes('DEVICE-WATCHDOG REQUEST')) return 'DWR'
    if (upper.includes('DEVICE-WATCHDOG ANSWER')) return 'DWA'
    if (upper.includes('CAPABILITIES-EXCHANGE REQUEST')) return 'CER'
    if (upper.includes('CAPABILITIES-EXCHANGE ANSWER')) return 'CEA'

    return text.replace(/\s*\|.*$/, '').trim() || 'DIAMETER'
  }

  function extractFrameMetaFromTree(tree) {
    let sessionId = ''
    let ccRequestType = ''

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
        if (sessionId && ccRequestType) return
        walk(n.n || [])
        if (sessionId && ccRequestType) return
      }
    }

    walk(tree || [])
    return { sessionId, ccRequestType }
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

  async function enrichRowsWithFrameMeta(rows, capture, concurrency = 8) {
    const out = rows.slice()
    let idx = 0

    async function worker() {
      while (idx < out.length) {
        const i = idx++
        const r = out[i]
        const meta = await getFrameMeta(capture, r.frame)
        out[i] = { ...r, ...meta }
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
  }

  function renderDiameterFlows(rows) {
    closeFlowsModal()

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
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#3f51b5;color:#fff;font-weight:600;'
    head.innerHTML = '<span>Diameter Flows (auto-generated)</span>'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = 'border:0;background:transparent;color:#fff;font-size:18px;cursor:pointer;'
    closeBtn.addEventListener('click', closeFlowsModal)
    head.appendChild(closeBtn)

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

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      t.setAttribute('x', String(x))
      t.setAttribute('y', '26')
      t.setAttribute('text-anchor', 'middle')
      t.setAttribute('font-size', '12')
      t.setAttribute('font-family', 'Arial, sans-serif')
      t.textContent = p
      svg.appendChild(t)

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(x))
      line.setAttribute('x2', String(x))
      line.setAttribute('y1', '34')
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
      const label = normalizeDiameterLabel(r.info, r.ccRequestType)
      const color = label.startsWith('CCA') || label.endsWith('Answer') ? '#2e7d32' : '#1565c0'

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.style.cursor = 'pointer'
      g.addEventListener('click', async () => {
        await ensureMounted()
        if (STATE.frameInput) STATE.frameInput.value = String(r.frame)
        await loadDiameter({ auto: false })
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
      line.setAttribute('stroke-width', '1.8')
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
    foot.textContent = 'Tip: click any arrow/message to auto-load that frame into DIAMETER AVP panel.'

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
    if (!capture) {
      STATE.status.textContent = '请先选择 capture 后再打开 Diameter Flows'
      return
    }

    STATE.status.textContent = 'Building Diameter Flows...'

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
        STATE.status.textContent = 'No Diameter frames found in this capture.'
        return
      }

      const enriched = await enrichRowsWithFrameMeta(rows, capture)

      STATE.flowsRows = enriched
      renderDiameterFlows(enriched)

      // auto-show panel and load first message as requested
      if (enriched[0]) {
        if (STATE.frameInput) STATE.frameInput.value = String(enriched[0].frame)
        loadDiameter({ auto: false, keepTable: false })
      }

      STATE.status.textContent = `Diameter Flows ready (${enriched.length} messages)`
    } catch (e) {
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

  async function ensureMounted() {
    if (STATE.mounted) return
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

    syncCaptureAndFrame()
    tryAutofillCaptureFromServer().then(() => scheduleAutoLoad())

    // Set default display filter when filter box appears.
    let filterTry = 0
    const filterTimer = setInterval(() => {
      filterTry += 1
      const ok = applyDefaultDisplayFilter()
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
      applyDefaultDisplayFilter()
      tryInjectDiameterFlowsMenu()
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
    } catch {}

    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved) applyPanelPos(saved)
    } catch {}

    window.addEventListener('resize', () => {
      try {
        const savedSize = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null')
        if (savedSize) applyPanelSize(savedSize)
      } catch {}
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
        if (saved) applyPanelPos(saved)
      } catch {}
    })

    installMenuInjector()

    // Expose APIs for future integration/testing.
    window.DiameterPanel = {
      openFlows: openDiameterFlows,
      loadFrame: async frame => {
        await ensureMounted()
        if (STATE.frameInput) STATE.frameInput.value = String(frame)
        await loadDiameter({ auto: false })
      },
      ensureMounted
    }

    STATE.mounted = true
  }

  setTimeout(mount, 800)
})()
