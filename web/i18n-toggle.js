(() => {
  // 中英双语映射表：key=英文原文，value=中文翻译
  const BILINGUAL = {
    // ── 顶栏菜单按钮 ─────────────────────────────────────
    'Endpoints': '端点统计',
    'Response Time': '响应时间',
    'Statistics': '统计信息',
    'Export Objects': '导出对象',
    'Misc': '其他分析',
    // ── 通用 UI 词汇 ──────────────────────────────────────
    'Session-Id Filter': 'Session-Id 过滤',
    'Single': '单选',
    'Multi': '多选',
    'Select All': '全选',
    'Unselect All': '取消全选',
    'Filter session-id...': '筛选 Session-Id...',
    'No session-id matched.': '没有匹配的 Session-Id。',
    'Clear': '清空',
    'Cancel': '取消',
    'Apply': '应用',
    'Open': '打开',
    'Close': '关闭',
    'Search': '搜索',
    'Filter': '过滤',
    'Download': '下载',
    'Upload': '上传',
    'Export': '导出',
    'Import': '导入',
    'Settings': '设置',
    'Help': '帮助',
    'Capture': '抓包',
    'Frame': '帧',
    'Protocol': '协议',
    'Source': '源地址',
    'Destination': '目的地址',
    'Length': '长度',
    'Info': '信息',
    'Apply display filter': '应用显示过滤器',
    'Clear display filter': '清除显示过滤器'
  }

  // 双语格式：英文 (中文)
  function bilingualText(en) {
    const zh = BILINGUAL[en.trim()]
    if (!zh) return null
    return `${en.trim()} (${zh})`
  }

  function maybeTranslateTextNode(node) {
    if (!node || !node.nodeValue) return
    const raw = node.nodeValue
    if (!raw.trim()) return
    // Store original
    if (!node.__i18nOrig) node.__i18nOrig = raw.trim()
    const result = bilingualText(node.__i18nOrig)
    if (result && node.nodeValue !== result) node.nodeValue = result
  }

  function maybeTranslateAttr(el, attr) {
    if (!el || !el.getAttribute) return
    const cur = el.getAttribute(attr)
    if (!cur || !cur.trim()) return
    const key = `__i18nOrig_${attr}`
    if (!el[key]) el[key] = cur.trim()
    const result = bilingualText(el[key])
    if (result && result !== cur) el.setAttribute(attr, result)
  }

  function applyI18n(root) {
    if (!root) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const p = node.parentElement
      if (!p) continue
      const tag = (p.tagName || '').toLowerCase()
      if (tag === 'script' || tag === 'style') continue
      maybeTranslateTextNode(node)
    }

    root.querySelectorAll?.('input[placeholder],input[title],button[title],*[aria-label],*[title]').forEach(el => {
      maybeTranslateAttr(el, 'placeholder')
      maybeTranslateAttr(el, 'title')
      maybeTranslateAttr(el, 'aria-label')
    })
  }

  let timer = null
  function scheduleApply() {
    clearTimeout(timer)
    timer = setTimeout(() => applyI18n(document.body), 120)
  }

  window.WEBSHARK_I18N = { bilingualText, applyI18n }

  document.addEventListener('DOMContentLoaded', () => {
    applyI18n(document.body)
    const obs = new MutationObserver(() => scheduleApply())
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })
})()

