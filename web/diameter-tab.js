(() => {
  const STATE = {
    mounted: false,
    panel: null,
    tableWrap: null,
    status: null,
    captureInput: null,
    frameInput: null
  }

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

  function getCurrentFrame() {
    const selected = document.querySelector('[aria-selected="true"]')
    if (selected) {
      const firstNum = (selected.textContent || '').match(/\b(\d{1,7})\b/)
      if (firstNum) return Number(firstNum[1])
    }

    const txt = document.body.innerText || ''
    const m = txt.match(/Frame\s+(\d+)\s*:/i)
    if (m) return Number(m[1])

    return ''
  }

  function renderRows(rows) {
    if (!rows.length) return '<div style="opacity:.7">No Diameter AVP found in this frame.</div>'
    const head = '<thead><tr><th style="text-align:left;padding:4px">AVP Name</th><th style="text-align:left;padding:4px">AVP Content</th><th style="text-align:left;padding:4px">AVP Flags</th></tr></thead>'
    const body = rows.map(r => `<tr><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpName || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpContent || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpFlags || '')}</td></tr>`).join('')
    return `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`
  }

  async function loadDiameter() {
    const capture = (STATE.captureInput.value || '').trim()
    const frame = (STATE.frameInput.value || '').trim()

    if (!capture || !frame) {
      STATE.status.textContent = 'capture/frame 不能为空（先点一行包可自动填充）'
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
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#3f51b5;color:#fff;font-weight:600;">
        <span>DIAMETER</span>
        <span style="opacity:.85;font-weight:400;">(independent panel)</span>
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
    STATE.tableWrap = panel.querySelector('#dia-table')
    STATE.status = panel.querySelector('#dia-status')
    STATE.captureInput = panel.querySelector('#dia-cap')
    STATE.frameInput = panel.querySelector('#dia-frame')

    STATE.captureInput.value = getCaptureName()
    STATE.frameInput.value = getCurrentFrame() || ''

    panel.querySelector('#dia-load').addEventListener('click', loadDiameter)

    // keep frame synced when user selects another packet
    document.addEventListener('click', () => {
      const frame = getCurrentFrame()
      if (frame) STATE.frameInput.value = frame
      const cap = getCaptureName()
      if (cap) STATE.captureInput.value = cap
    }, true)

    STATE.mounted = true
  }

  setTimeout(mount, 800)
})()
