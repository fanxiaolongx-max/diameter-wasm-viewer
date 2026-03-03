(() => {
  const STATE = { mounted: false, panel: null, btn: null }

  function getCaptureName() {
    const txt = document.body.innerText || ''
    const m = txt.match(/([\w .\-]+\.pcapng?)/i)
    return m ? m[1] : null
  }

  function getCurrentFrame() {
    const txt = document.body.innerText || ''
    const m = txt.match(/Frame\s+(\d+)\s*:/i)
    return m ? Number(m[1]) : null
  }

  function findHexButton() {
    const buttons = Array.from(document.querySelectorAll('button,div,[role="tab"]'))
    return buttons.find((el) => el.textContent && el.textContent.trim() === 'HEX')
  }

  function findBinaryButton() {
    const buttons = Array.from(document.querySelectorAll('button,div,[role="tab"]'))
    return buttons.find((el) => el.textContent && el.textContent.trim() === 'BINARY')
  }

  function createPanel() {
    const panel = document.createElement('div')
    panel.id = 'diameter-avp-panel'
    panel.style.cssText = 'display:none;max-height:260px;overflow:auto;background:#fff;border-top:1px solid #ddd;padding:8px;font-size:12px;'
    panel.innerHTML = '<div style="opacity:.7">Select a Diameter frame, then click DIAMETER.</div>'
    return panel
  }

  function renderRows(rows) {
    if (!rows.length) return '<div style="opacity:.7">No Diameter AVP found in this frame.</div>'
    const head = '<thead><tr><th style="text-align:left;padding:4px">AVP Name</th><th style="text-align:left;padding:4px">AVP Content</th><th style="text-align:left;padding:4px">AVP Flags</th></tr></thead>'
    const body = rows.map(r => `<tr><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpName || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpContent || '')}</td><td style="padding:4px;border-top:1px solid #eee">${escapeHtml(r.avpFlags || '')}</td></tr>`).join('')
    return `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  async function loadDiameter() {
    const capture = getCaptureName()
    const frame = getCurrentFrame()
    if (!capture || !frame) {
      STATE.panel.innerHTML = '<div style="color:#b00020">Cannot detect capture/frame. Please click a packet row first.</div>'
      return
    }
    STATE.panel.innerHTML = '<div style="opacity:.7">Loading Diameter AVP...</div>'
    try {
      const url = `/webshark/diameter-avps?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(frame)}`
      const res = await fetch(url)
      const data = await res.json()
      STATE.panel.innerHTML = renderRows(data.rows || [])
    } catch (e) {
      STATE.panel.innerHTML = `<div style="color:#b00020">Load failed: ${escapeHtml(e.message || String(e))}</div>`
    }
  }

  function deactivateOriginalTabs() {
    const hex = findHexButton();
    const bin = findBinaryButton();
    if (hex) hex.classList.remove('mdc-tab--active')
    if (bin) bin.classList.remove('mdc-tab--active')
  }

  function mount() {
    const hexBtn = findHexButton()
    if (!hexBtn || STATE.mounted) return

    const btn = hexBtn.cloneNode(true)
    btn.textContent = 'DIAMETER'
    btn.onclick = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      deactivateOriginalTabs()
      STATE.panel.style.display = 'block'
      await loadDiameter()
    }

    hexBtn.parentElement.appendChild(btn)

    const parentPanel = (document.querySelector('mat-tab-body.mat-mdc-tab-body-active') || hexBtn.closest('div'))
    const panel = createPanel()
    if (parentPanel && parentPanel.parentElement) {
      parentPanel.parentElement.appendChild(panel)
    } else {
      document.body.appendChild(panel)
      panel.style.position = 'fixed'
      panel.style.left = '50%'
      panel.style.bottom = '8px'
      panel.style.width = '48%'
      panel.style.zIndex = '9999'
      panel.style.transform = 'translateX(-2%)'
      panel.style.border = '1px solid #ddd'
    }

    STATE.mounted = true
    STATE.panel = panel
    STATE.btn = btn
  }

  setInterval(mount, 1200)
})()
