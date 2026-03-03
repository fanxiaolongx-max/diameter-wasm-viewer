(() => {
  const STATE = {
    mounted: false,
    panel: null,
    tableWrap: null,
    status: null,
    captureInput: null,
    frameInput: null,
    dragHandle: null,
    drag: { active: false, dx: 0, dy: 0 }
  }

  const POS_KEY = 'diameter_fixed_panel_pos_v1'

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function getCaptureName() {
    try {
      const path = decodeURIComponent(location.pathname || '')
      const m = path.match(/\/webshark\/(.+\.pcapng?|.+\.pcap)$/i)
      if (m && m[1]) return m[1]
    } catch {}

    const txt = document.body.innerText || ''
    const m = txt.match(/([\w .\-]+\.pcapng?)/i)
    return m ? m[1] : ''
  }

  function extractFrameFromText(s) {
    const t = String(s || '')
    const m = t.match(/\b(\d{1,7})\b/)
    return m ? Number(m[1]) : ''
  }

  function getCurrentFrame() {
    // 1) common selected markers
    const selected = document.querySelector(
      '[aria-selected="true"], tr.selected, .selected, .is-selected, .packet-selected'
    )
    if (selected) {
      // Prefer first cell text if available (packet list usually has frame no in first cell)
      const firstCell = selected.querySelector('td, [role="gridcell"], div')
      const n1 = extractFrameFromText(firstCell ? firstCell.textContent : '')
      if (n1) return n1

      const n2 = extractFrameFromText(selected.textContent)
      if (n2) return n2
    }

    // 2) details pane text fallback
    const txt = document.body.innerText || ''
    const m = txt.match(/Frame\s+(\d+)\s*:/i)
    if (m) return Number(m[1])

    return ''
  }

  function syncCaptureAndFrame() {
    const frame = getCurrentFrame()
    if (frame) STATE.frameInput.value = frame

    const cap = getCaptureName()
    if (cap) STATE.captureInput.value = cap
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

  async function loadDiameter() {
    syncCaptureAndFrame()

    const capture = (STATE.captureInput.value || '').trim()
    const frame = (STATE.frameInput.value || '').trim()

    if (!capture || !frame) {
      STATE.status.textContent = 'capture/frame 不能为空（请先在包列表选中一行，或手动填写）'
      return
    }

    STATE.status.textContent = 'Loading Diameter AVP...'
    STATE.tableWrap.innerHTML = ''

    try {
      const url = `/webshark/diameter-avps?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(frame)}`
      const res = await fetch(url)
      const data = await res.json()
      STATE.tableWrap.innerHTML = renderRows(data.rows || [])
      STATE.status.textContent = `Loaded ${Array.isArray(data.rows) ? data.rows.length : 0} AVP(s)`
    } catch (e) {
      STATE.status.textContent = `Load failed: ${e.message || String(e)}`
    }
  }

  function savePanelPos() {
    if (!STATE.panel) return
    const left = parseInt(STATE.panel.style.left || '0', 10)
    const top = parseInt(STATE.panel.style.top || '0', 10)
    if (Number.isFinite(left) && Number.isFinite(top)) {
      localStorage.setItem(POS_KEY, JSON.stringify({ left, top }))
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
    })
  }

  function mount() {
    if (STATE.mounted) return

    // fixed independent panel, no relation with built-in tabs
    const panel = document.createElement('div')
    panel.id = 'diameter-fixed-panel'
    panel.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:10px',
      'width:46vw',
      'max-width:760px',
      'height:38vh',
      'min-height:220px',
      'background:#fff',
      'border:1px solid #3f51b5',
      'border-radius:6px',
      'box-shadow:0 4px 14px rgba(0,0,0,.18)',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'font-size:12px'
    ].join(';')

    panel.innerHTML = `
      <div id="dia-drag-handle" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#3f51b5;color:#fff;font-weight:600;user-select:none;">
        <span>DIAMETER</span>
        <span style="opacity:.85;font-weight:400;">(independent panel, draggable)</span>
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

    panel.querySelector('#dia-load').addEventListener('click', loadDiameter)

    // keep frame synced when user selects another packet (click + keyboard)
    document.addEventListener(
      'click',
      () => {
        syncCaptureAndFrame()
      },
      true
    )

    document.addEventListener('keyup', e => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        syncCaptureAndFrame()
      }
    })

    // fallback: observe selected-row class/aria changes
    const mo = new MutationObserver(() => {
      syncCaptureAndFrame()
    })
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected']
    })

    initDrag()

    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved) applyPanelPos(saved)
    } catch {}

    window.addEventListener('resize', () => {
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
        if (saved) applyPanelPos(saved)
      } catch {}
    })

    STATE.mounted = true
  }

  setTimeout(mount, 800)
})()
