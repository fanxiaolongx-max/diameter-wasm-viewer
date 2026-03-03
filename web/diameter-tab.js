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
    autoLoadTimer: null
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
    const capture = (STATE.captureInput && STATE.captureInput.value || '').trim()
    const frame = (STATE.frameInput && STATE.frameInput.value || '').trim()
    if (!capture || !frame) return ''
    return `${capture}#${frame}`
  }

  function syncCaptureAndFrame() {
    const oldCap = (STATE.captureInput && STATE.captureInput.value || '').trim()
    const oldFrame = (STATE.frameInput && STATE.frameInput.value || '').trim()

    const frame = getCurrentFrame()
    if (frame && STATE.frameInput) STATE.frameInput.value = frame

    const cap = getCaptureName()
    if (cap && STATE.captureInput) {
      STATE.captureInput.value = cap
      try {
        localStorage.setItem(CAP_KEY, cap)
      } catch {}
    }

    const newCap = (STATE.captureInput && STATE.captureInput.value || '').trim()
    const newFrame = (STATE.frameInput && STATE.frameInput.value || '').trim()
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
    const head = '<thead><tr><th style="text-align:left;padding:4px">AVP Name</th><th style="text-align:left;padding:4px">AVP Content</th><th style="text-align:left;padding:4px">AVP Flags</th></tr></thead>'
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

    // Heuristic search for display-filter input in WebShark UI.
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
    const candidate = inputs.find(el => {
      if (!el || el.id === 'dia-cap' || el.id === 'dia-frame') return false
      const text = `${el.id || ''} ${el.name || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase()
      return text.includes('filter') || text.includes('display')
    })

    if (!candidate) return false

    const cur = String(candidate.value || '').trim()
    if (cur) return true

    candidate.value = target
    candidate.dispatchEvent(new Event('input', { bubbles: true }))
    candidate.dispatchEvent(new Event('change', { bubbles: true }))

    // Try submit by Enter for UIs that apply on key press.
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
      if (ok || filterTry >= 20) clearInterval(filterTimer)
    }, 300)

    panel.querySelector('#dia-load').addEventListener('click', () => loadDiameter({ auto: false }))

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
    })
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected']
    })

    // Persist manual resize
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

    STATE.mounted = true
  }

  setTimeout(mount, 800)
})()
