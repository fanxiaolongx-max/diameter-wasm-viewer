(() => {
  const STATE = { mounted: false, panel: null, btn: null }

  const TAB_TEXTS = ['HEX', 'BINARY', 'TEXT']

  function findTabElements() {
    const nodes = Array.from(document.querySelectorAll('[role="tab"], button, .mdc-tab'))
    const map = {}
    for (const n of nodes) {
      const t = (n.textContent || '').trim().toUpperCase()
      if (TAB_TEXTS.includes(t) && !map[t]) map[t] = n
    }
    return map
  }

  function getCaptureName() {
    // Prefer URL path: /webshark/<capture file>
    try {
      const path = decodeURIComponent(location.pathname || '')
      const m = path.match(/\/webshark\/(.+\.pcapng?|.+\.pcap)$/i)
      if (m && m[1]) return m[1]
    } catch {}

    // Fallback from body text
    const txt = document.body.innerText || ''
    const m = txt.match(/([\w .\-]+\.pcapng?)/i)
    return m ? m[1] : null
  }

  function getCurrentFrame() {
    // 1) Selected row in packet table
    const selected = document.querySelector('[aria-selected="true"]')
    if (selected) {
      const firstNum = (selected.textContent || '').match(/\b(\d{1,7})\b/)
      if (firstNum) return Number(firstNum[1])
    }

    // 2) Protocol tree text like "Frame 1234: ..."
    const txt = document.body.innerText || ''
    const m = txt.match(/Frame\s+(\d+)\s*:/i)
    if (m) return Number(m[1])

    return null
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function renderRows(rows) {
    if (!rows.length) return '<div style="opacity:.7">No Diameter AVP found in this frame.</div>'
    const head = '<thead><tr><th style="text-align:left;padding:4px">AVP Name</th><th style="text-align:left;padding:4px">AVP Content</th><th style="text-align:left;padding:4px">AVP Flags</th></tr></thead>'
    const body = rows.map(r => `<tr><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpName || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpContent || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpFlags || '')}</td></tr>`).join('')
    return `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`
  }

  function ensurePanel() {
    if (STATE.panel) return STATE.panel
    const panel = document.createElement('div')
    panel.id = 'diameter-avp-panel'
    panel.style.cssText = 'display:none;max-height:260px;overflow:auto;background:#fff;border-top:1px solid #ddd;padding:8px;font-size:12px;'
    panel.innerHTML = '<div style="opacity:.7">Select a Diameter packet row first, then click DIAMETER.</div>'

    // Try to place near right-bottom content area; fallback to fixed
    const rightPane = document.querySelector('.hex-grid, .packet-view, .mat-mdc-tab-body-content')
    if (rightPane && rightPane.parentElement) {
      rightPane.parentElement.appendChild(panel)
    } else {
      panel.style.position = 'fixed'
      panel.style.left = '50%'
      panel.style.bottom = '8px'
      panel.style.width = '48%'
      panel.style.zIndex = '9999'
      panel.style.transform = 'translateX(-2%)'
      panel.style.border = '1px solid #ddd'
      document.body.appendChild(panel)
    }

    STATE.panel = panel
    return panel
  }

  async function loadDiameter() {
    const panel = ensurePanel()
    const capture = getCaptureName()
    const frame = getCurrentFrame()

    if (!capture || !frame) {
      panel.innerHTML = '<div style="color:#b00020">Cannot detect capture/frame. Please click a packet row first.</div>'
      return
    }

    panel.innerHTML = '<div style="opacity:.7">Loading Diameter AVP...</div>'
    try {
      const url = `/webshark/diameter-avps?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(frame)}`
      const res = await fetch(url)
      const data = await res.json()
      panel.innerHTML = renderRows(data.rows || [])
    } catch (e) {
      panel.innerHTML = `<div style="color:#b00020">Load failed: ${escapeHtml(e.message || String(e))}</div>`
    }
  }

  function mount() {
    if (STATE.mounted) return
    const tabs = findTabElements()
    if (!tabs.HEX || !tabs.BINARY || !tabs.TEXT) return

    // robust tab container (avoid appending inside label span)
    const tabContainer = tabs.HEX.closest('[role="tablist"]') || tabs.HEX.parentElement
    if (!tabContainer) return

    if (Array.from(tabContainer.querySelectorAll('*')).some(el => (el.textContent || '').trim().toUpperCase() === 'DIAMETER')) {
      STATE.mounted = true
      return
    }

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = 'DIAMETER'
    btn.style.cssText = 'margin-left:8px;padding:2px 8px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:12px;line-height:20px;border-radius:3px;'
    btn.onclick = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const panel = ensurePanel()
      panel.style.display = 'block'
      await loadDiameter()
    }

    tabContainer.appendChild(btn)
    STATE.btn = btn
    ensurePanel()
    STATE.mounted = true
  }

  setInterval(mount, 1000)
})()
