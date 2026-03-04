(() => {
  const KEY = 'webshark_lang'
  const FALLBACK = 'en'
  const MAP = {
    zh: {
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
    },
    en: {}
  }

  function getLang() {
    const v = (localStorage.getItem(KEY) || FALLBACK).toLowerCase()
    return v === 'zh' ? 'zh' : 'en'
  }

  function setLang(lang) {
    const v = lang === 'zh' ? 'zh' : 'en'
    localStorage.setItem(KEY, v)
    document.documentElement.setAttribute('lang', v === 'zh' ? 'zh-CN' : 'en')
    applyI18n(document.body)
    updateButton()
  }

  function t(text) {
    const lang = getLang()
    if (lang === 'en') return text
    return MAP[lang][text] || text
  }

  function maybeTranslateTextNode(node) {
    if (!node || !node.nodeValue) return
    const raw = node.nodeValue
    if (!raw.trim()) return
    if (!node.__i18nOrig) node.__i18nOrig = raw
    const translated = t(node.__i18nOrig)
    if (translated !== node.nodeValue) node.nodeValue = translated
  }

  function maybeTranslateAttr(el, attr) {
    if (!el || !el.getAttribute) return
    const cur = el.getAttribute(attr)
    if (!cur) return
    const key = `__i18nOrig_${attr}`
    if (!el[key]) el[key] = cur
    const translated = t(el[key])
    if (translated !== cur) el.setAttribute(attr, translated)
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

  function createButton() {
    let btn = document.getElementById('ws-lang-toggle')
    if (btn) return btn
    btn = document.createElement('button')
    btn.id = 'ws-lang-toggle'
    btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:100003;background:#3f51b5;color:#fff;border:1px solid #3f51b5;border-radius:16px;padding:6px 10px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);'
    btn.addEventListener('click', () => {
      setLang(getLang() === 'zh' ? 'en' : 'zh')
    })
    document.body.appendChild(btn)
    return btn
  }

  function updateButton() {
    const btn = createButton()
    const zh = getLang() === 'zh'
    btn.textContent = zh ? '中文 / EN' : 'EN / 中文'
    btn.title = zh ? '切换到英文' : 'Switch to Chinese'
  }

  let timer = null
  function scheduleApply() {
    clearTimeout(timer)
    timer = setTimeout(() => applyI18n(document.body), 100)
  }

  window.WEBSHARK_I18N = { t, getLang, setLang }

  document.addEventListener('DOMContentLoaded', () => {
    setLang(getLang())
    updateButton()
    applyI18n(document.body)

    const obs = new MutationObserver(() => scheduleApply())
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
  })
})()
