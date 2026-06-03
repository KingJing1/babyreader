/* ============================================================
   BabyReader — app.js
   ============================================================ */

'use strict';

/* --- State --- */
const state = {
  isNative: !!window.webkit?.messageHandlers?.native,
  mode: 'read',        // 'read' | 'edit'
  theme: 'dark',       // 'dark' | 'light'
  currentPath: null,
  currentName: null,
  content: '',
  epubHtml: '',
  toc: [],
  tocOpen: true,
  epubBook: null,
  epubRendition: null,
  contentType: 'text',   // 'text' | 'epub'
  dirty: false
};

/* --- Native Bridge --- */
function sendNative(type, payload = {}) {
  if (!state.isNative) return;
  window.webkit.messageHandlers.native.postMessage({ type, payload });
}

function setDirty(nextDirty, notify = true) {
  state.dirty = !!nextDirty;
  if (notify) {
    sendNative('dirtyChanged', {
      dirty: state.dirty,
      content: state.contentType === 'text' ? state.content : ''
    });
  }
}

function storageKey(prefix) {
  if (!state.currentPath) return null;
  return `babyreader:${prefix}:${state.contentType}:${state.currentPath}`;
}

function savedPosition() {
  const key = storageKey('position');
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function savePosition(value) {
  const key = storageKey('position');
  if (!key || !value) return;
  localStorage.setItem(key, JSON.stringify(value));
}

function saveHighlights(highlights) {
  const key = storageKey('highlights');
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(highlights || []));
}

function loadHighlights() {
  const key = storageKey('highlights');
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

/* ============================================================
   Custom Block Preprocessor
   ============================================================ */

/**
 * Replace [[TYPE]]...[[/TYPE]] blocks with <div class="block-type">...</div>
 * before passing the remainder to marked.
 *
 * Supported types:
 *   TITLE, SUBTITLE, SIGN, HEADING — single-content, rendered as-is
 *   LEDE, QUOTE                    — multi-paragraph (split on \n\n)
 *   META                           — lines joined with <br>
 *   BREAK                          — visual separator (renders as <hr>)
 *
 * Returns an object { html, remaining } where:
 *   html      — fully pre-rendered HTML string for all custom blocks
 *   remaining — the leftover text that marked should handle
 *
 * Strategy: walk the content top-to-bottom, collect custom-block segments
 * as pre-rendered HTML, and leave the rest for marked.
 */
function preprocessCustomBlocks(content) {
  // Supported block types (case-insensitive match)
  const BLOCK_TYPES = ['TITLE', 'SUBTITLE', 'LEDE', 'META', 'HEADING', 'QUOTE', 'SIGN', 'BREAK'];
  const typePattern = BLOCK_TYPES.join('|');

  // Regex: [[TYPE]] ... [[/TYPE]]  — DOTALL via workaround
  const blockRegex = new RegExp(
    `\\[\\[(${typePattern})\\]\\]([\\s\\S]*?)\\[\\[\\/(${typePattern})\\]\\]`,
    'gi'
  );

  // Also detect first h1 and restyle it
  let isFirstH1 = true;

  const segments = []; // { type: 'custom'|'markdown', content: string }
  let lastIndex = 0;

  let match;
  blockRegex.lastIndex = 0;

  while ((match = blockRegex.exec(content)) !== null) {
    const openType  = match[1].toUpperCase();
    const innerRaw  = match[2];
    const closeType = match[3].toUpperCase();

    // Collect markdown text before this block
    if (match.index > lastIndex) {
      segments.push({ type: 'markdown', content: content.slice(lastIndex, match.index) });
    }

    // Only process if open/close tags match
    if (openType === closeType) {
      segments.push({ type: 'custom', blockType: openType, content: innerRaw.trim() });
    } else {
      // Mismatched tags — treat as plain markdown
      segments.push({ type: 'markdown', content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last block
  if (lastIndex < content.length) {
    segments.push({ type: 'markdown', content: content.slice(lastIndex) });
  }

  // Now build output HTML
  let outputHTML = '';

  for (const seg of segments) {
    if (seg.type === 'markdown') {
      // Render through marked; then post-process first h1
      let mdHTML = marked.parse(seg.content);
      if (isFirstH1) {
        // Add .is-title class to the very first <h1> in the document
        mdHTML = mdHTML.replace(/<h1([ >])/, (m, rest) => {
          isFirstH1 = false;
          return `<h1 class="is-title"${rest === '>' ? '>' : ' ' + rest}`;
        });
      }
      outputHTML += mdHTML;
    } else {
      outputHTML += renderCustomBlock(seg.blockType, seg.content);
    }
  }

  return outputHTML;
}

/**
 * Render a single custom block to HTML.
 */
function renderCustomBlock(type, inner) {
  const cls = 'block-' + type.toLowerCase();

  switch (type) {
    case 'LEDE':
    case 'QUOTE': {
      // Split on double newlines → multiple <p> tags
      const paragraphs = inner
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${inlineMarkdown(p)}</p>`)
        .join('');
      return `<div class="${cls}">${paragraphs}</div>\n`;
    }

    case 'META': {
      // Each line becomes text separated by <br>
      const lines = inner
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => inlineMarkdown(l))
        .join('<br>');
      return `<div class="${cls}">${lines}</div>\n`;
    }

    case 'TITLE':
    case 'SUBTITLE':
    case 'SIGN': {
      return `<div class="${cls}">${inlineMarkdown(inner)}</div>\n`;
    }

    case 'HEADING': {
      return `<div class="${cls}">${escapeHtml(inner)}</div>\n`;
    }

    case 'BREAK': {
      return '<hr class="block-break">\n';
    }

    default: {
      // Unknown type — wrap generically
      return `<div class="${cls}">${inlineMarkdown(inner)}</div>\n`;
    }
  }
}

/**
 * Process inline markdown (bold, italic, code, links) but not block-level.
 * Uses a lightweight approach rather than a full marked.parse to avoid
 * wrapping in <p> tags.
 */
function inlineMarkdown(text) {
  // We use marked's lexer trick: parse and strip the outer <p> wrapper.
  const html = marked.parseInline(text);
  return html;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeXmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function getXmlAttribute(tag, name) {
  const attrRe = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(attrRe);
  if (!match) return null;
  return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

function escapeHtmlAttribute(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripXmlTags(str) {
  return decodeXmlEntities(String(str).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

function getDirPath(filePath) {
  return filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/') + 1) : '';
}

function normalizeZipPath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function resolveZipPath(baseDir, href) {
  const cleanHref = String(href || '').split('#')[0].split('?')[0];
  return normalizeZipPath(baseDir + cleanHref);
}

function splitHref(href) {
  const value = String(href || '');
  const hashIndex = value.indexOf('#');
  return {
    path: hashIndex >= 0 ? value.slice(0, hashIndex) : value,
    fragment: hashIndex >= 0 ? value.slice(hashIndex + 1) : ''
  };
}

function getZipFile(zip, filePath) {
  const normalized = normalizeZipPath(filePath);
  return zip.file(normalized) || zip.file(decodeURIComponent(normalized));
}

function mimeFromPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const mimes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif'
  };
  return mimes[ext] || 'application/octet-stream';
}

function sanitizeEpubHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*(["'])javascript:[\s\S]*?\2/gi, ' $1="#"')
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
}

async function inlineResourceRefs(html, chapterPath, zip, mediaTypes) {
  const chapterDir = getDirPath(chapterPath);
  const tags = [...html.matchAll(/<(img|image)\b[^>]*>/gi)];
  let output = html;

  for (const match of tags) {
    const tag = match[0];
    const attrName = getXmlAttribute(tag, 'src') ? 'src'
      : getXmlAttribute(tag, 'href') ? 'href'
      : getXmlAttribute(tag, 'xlink:href') ? 'xlink:href'
      : null;
    if (!attrName) continue;

    const href = getXmlAttribute(tag, attrName);
    if (!href || /^(data:|https?:|file:|blob:)/i.test(href)) continue;

    const imagePath = resolveZipPath(chapterDir, href);
    const imageFile = getZipFile(zip, imagePath);
    if (!imageFile) continue;

    const mime = mediaTypes[imagePath] || mimeFromPath(imagePath);
    const dataUrl = `data:${mime};base64,${await imageFile.async('base64')}`;
    const attrRe = new RegExp(`(${attrName.replace(':', '\\:')}\\s*=\\s*)(["'])${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`, 'i');
    const nextTag = tag.replace(attrRe, `$1$2${escapeHtmlAttribute(dataUrl)}$2`);
    output = output.replace(tag, nextTag);
  }

  return output;
}

function parseNavToc(navHtml, navPath, chapterTargets) {
  const navMatch = navHtml.match(/<nav\b[^>]*(?:epub:type|type)\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)
    || navHtml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  if (!navMatch) return [];

  const navDir = getDirPath(navPath);
  const entries = [];
  const linkRe = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(navMatch[1])) !== null) {
    const rawHref = decodeXmlEntities(m[2]);
    const label = stripXmlTags(m[3]);
    if (!rawHref || !label) continue;

    const split = splitHref(rawHref);
    const chapterPath = resolveZipPath(navDir, split.path);
    const fallbackTarget = chapterTargets[chapterPath];
    const target = split.fragment ? `#${split.fragment}` : fallbackTarget;
    if (target) entries.push({ label, target });
  }
  return entries;
}

function parseNcxToc(ncxXml, ncxPath, chapterTargets) {
  const ncxDir = getDirPath(ncxPath);
  const entries = [];
  const pointRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
  let m;
  while ((m = pointRe.exec(ncxXml)) !== null) {
    const labelMatch = m[1].match(/<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>/i);
    const contentMatch = m[1].match(/<content\b[^>]*src\s*=\s*(["'])(.*?)\1[^>]*\/?>/i);
    if (!labelMatch || !contentMatch) continue;

    const label = stripXmlTags(labelMatch[1]);
    const rawHref = decodeXmlEntities(contentMatch[2]);
    const split = splitHref(rawHref);
    const chapterPath = resolveZipPath(ncxDir, split.path);
    const fallbackTarget = chapterTargets[chapterPath];
    const target = split.fragment ? `#${split.fragment}` : fallbackTarget;
    if (label && target) entries.push({ label, target });
  }
  return entries;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function flattenToc(items, depth = 0) {
  const output = [];
  for (const item of items || []) {
    if (item?.label && item?.href) {
      output.push({ label: item.label, target: item.href, depth });
    }
    if (item?.subitems?.length) {
      output.push(...flattenToc(item.subitems, depth + 1));
    }
  }
  return output;
}

function themeColors() {
  if (state.theme === 'light') {
    return {
      bg: '#FCF8F1',
      text: '#3A342E',
      textMuted: '#8B8378',
      textStrong: '#161513',
      accent: '#C8A26C',
      surface: '#FBF7EF'
    };
  }

  return {
    bg: '#1e1e1e',
    text: '#e8e0d4',
    textMuted: '#cdbfb2',
    textStrong: '#f0e8dc',
    accent: '#DA7756',
    surface: '#232323'
  };
}

function highlightColor() {
  return state.theme === 'light'
    ? 'rgba(200, 162, 108, 0.25)'
    : 'rgba(218, 119, 86, 0.25)';
}

function getEpubThemeCss() {
  const fontSize = (zoomLevel / 100 * 18).toFixed(2) + 'px';
  const colors = themeColors();
  return `
    html, body {
      background: ${colors.bg} !important;
      color: ${colors.text} !important;
    }
    body {
      font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif !important;
      font-size: ${fontSize} !important;
      font-weight: 400 !important;
      line-height: 1.9 !important;
      max-width: 760px !important;
      margin: 0 auto !important;
      padding: 32px 24px 64px !important;
      box-sizing: border-box !important;
    }
    body, body * {
      color: inherit !important;
      font-family: inherit !important;
      font-size: inherit !important;
      font-weight: 400 !important;
      letter-spacing: 0 !important;
      box-sizing: border-box !important;
    }
    body > *,
    p, li, div, section, article, blockquote {
      max-width: 760px !important;
    }
    p, li, div, section, article {
      color: ${colors.text} !important;
      line-height: 1.9 !important;
    }
    p, li {
      text-align: justify !important;
      margin-top: 0 !important;
      margin-bottom: 1.1em !important;
    }
    h1, h2, h3, h4, h5, h6 {
      color: ${colors.textStrong} !important;
      line-height: 1.35 !important;
      font-weight: 700 !important;
      margin: 1.6em 0 0.75em !important;
      text-align: left !important;
    }
    h1 {
      font-size: 1.65em !important;
    }
    h2 {
      font-size: 1.35em !important;
    }
    h3, h4, h5, h6 {
      font-size: 1.12em !important;
    }
    a {
      color: ${colors.accent} !important;
    }
    strong, b, strong *, b * {
      color: ${colors.textStrong} !important;
      font-weight: 650 !important;
    }
    img, svg {
      max-width: 100% !important;
      height: auto !important;
    }
    blockquote {
      border-left: 3px solid ${colors.accent} !important;
      color: ${colors.textMuted} !important;
      margin-left: 0 !important;
      padding-left: 1.2em !important;
    }
    pre, code {
      background: ${colors.surface} !important;
      color: ${colors.text} !important;
    }
    ::selection {
      background: ${highlightColor()} !important;
      color: ${colors.textStrong} !important;
    }
    .epubjs-hl { fill: ${highlightColor()} !important; fill-opacity: 1 !important; mix-blend-mode: multiply; }
  `;
}

function applyThemeToEpubFrames() {
  const colors = themeColors();
  const viewer = document.getElementById('epubViewer');
  if (viewer) viewer.style.background = colors.bg;

  bindCurrentEpubContents();

  document.querySelectorAll('#epubViewer iframe').forEach((iframe) => {
    iframe.style.background = colors.bg;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      let style = doc.getElementById('babyreader-epub-theme');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'babyreader-epub-theme';
        (doc.head || doc.documentElement || doc.body)?.appendChild(style);
      }
      style.textContent = getEpubThemeCss();
      if (doc.documentElement) {
        doc.documentElement.style.background = colors.bg;
        doc.documentElement.style.color = colors.text;
      }
      if (doc.body) {
        doc.body.style.background = colors.bg;
        doc.body.style.color = colors.text;
        doc.body.style.fontSize = (zoomLevel / 100 * 18).toFixed(2) + 'px';
      }
    } catch {
      // Cross-origin frames should not happen for local EPUBs, but don't break theme switching.
    }
  });
}

function bindCurrentEpubContents() {
  if (!state.epubRendition || typeof state.epubRendition.getContents !== 'function') return;
  try {
    for (const contents of state.epubRendition.getContents()) {
      setupEpubContentKeyboard(contents);
      setupEpubContentSelection(contents);
    }
  } catch {
    // The rendition may be between chapter mounts; the next rendered pass will retry.
  }
}

function applyEpubTheme() {
  if (!state.epubRendition) return;
  state.epubRendition.themes.register('babyreader', getEpubThemeCss());
  state.epubRendition.themes.select('babyreader');
  requestAnimationFrame(applyThemeToEpubFrames);
}

function themeIconSvg(nextTheme) {
  if (nextTheme === 'light') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v2"></path><path d="M12 20v2"></path>
        <path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path>
        <path d="M2 12h2"></path><path d="M20 12h2"></path>
        <path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20.4 14.4A7.3 7.3 0 0 1 9.6 3.6a8.7 8.7 0 1 0 10.8 10.8Z"></path>
    </svg>
  `;
}

function applyTheme(theme, persist = true) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', state.theme === 'light');

  const btnTheme = document.getElementById('btnTheme');
  if (btnTheme) {
    const isLight = state.theme === 'light';
    btnTheme.innerHTML = themeIconSvg(isLight ? 'dark' : 'light');
    btnTheme.setAttribute('aria-label', isLight ? '切换深色模式' : '切换浅色模式');
    btnTheme.setAttribute('title', isLight ? '切换深色模式' : '切换浅色模式');
  }

  if (persist) {
    localStorage.setItem('babyreader-theme', state.theme);
  }

  sendNative('themeChanged', { theme: state.theme });
  applyEpubTheme();
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
}

function highlightIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="m14.5 2.5 5 5-9.5 9.5H5V12Z"></path>
      <path d="M3 22h18"></path>
    </svg>
  `;
}

function exportIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
      <path d="M12 14V3"></path>
      <path d="m8 7 4-4 4 4"></path>
    </svg>
  `;
}

let _highlightPill = null;
let _highlightPillTimeout = null;
let _pendingCfiRange = null;
let _pendingDomHighlight = null;
let _fileNameFlashTimeout = null;

function getHighlightPill() {
  if (!_highlightPill) {
    _highlightPill = document.createElement('button');
    _highlightPill.className = 'highlight-pill';
    _highlightPill.textContent = '划线';
    document.body.appendChild(_highlightPill);
  }
  return _highlightPill;
}

function dismissHighlightPill() {
  clearTimeout(_highlightPillTimeout);
  _pendingCfiRange = null;
  _pendingDomHighlight = null;
  const pill = _highlightPill;
  if (pill) {
    pill.classList.remove('visible');
  }
  updateTopbarState();
}

function showHighlightPill(x, y, cfiRange = null) {
  const pill = getHighlightPill();
  dismissHighlightPill();
  _pendingCfiRange = cfiRange;

  pill.style.left = x + 'px';
  pill.style.top = y + 'px';
  pill.classList.add('visible');
  updateTopbarState();

  _highlightPillTimeout = setTimeout(dismissHighlightPill, 3000);
}

function runPendingHighlight() {
  const pill = _highlightPill;
  if (state.contentType === 'epub' && _pendingDomHighlight && pill?._clickHandler) {
    pill._clickHandler();
    return true;
  }
  if (state.contentType === 'epub' && _pendingCfiRange && pill?._clickHandler) {
    pill._clickHandler();
    return true;
  }
  return false;
}

function updateTopbarState() {
  const isEpub = state.contentType === 'epub';
  const hasToc = isEpub && state.toc.length > 0;
  const btnToc = document.getElementById('btnToc');
  const btnEdit = document.getElementById('btnEdit');

  document.body.classList.toggle('is-epub', isEpub);
  document.body.classList.toggle('has-toc', hasToc);
  document.body.classList.toggle('toc-open', hasToc && state.tocOpen);

  if (btnToc) {
    btnToc.hidden = !hasToc;
    btnToc.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16"/><path d="M4 12h12"/><path d="M4 18h16"/></svg>`;
    const tocLabel = state.tocOpen ? '隐藏目录' : '显示目录';
    btnToc.setAttribute('aria-label', tocLabel);
    btnToc.setAttribute('title', tocLabel);
  }

  if (btnEdit) {
    btnEdit.disabled = isEpub;
  }

  const btnHighlight = document.getElementById('btnHighlight');
  if (btnHighlight) {
    btnHighlight.hidden = !isEpub;
    btnHighlight.innerHTML = highlightIconSvg();
  }

  const btnExport = document.getElementById('btnExportHighlights');
  if (btnExport) {
    btnExport.hidden = !isEpub;
    btnExport.innerHTML = exportIconSvg();
  }
}

function toggleToc() {
  state.tocOpen = !state.tocOpen;
  localStorage.setItem('babyreader-toc-open', state.tocOpen ? '1' : '0');
  updateTopbarState();
  requestAnimationFrame(redrawDomHighlights);
}

function highlightId() {
  return `br-hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function selectedTextSignature(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function highlightFileName() {
  const bookName = (state.currentName || '未知书籍').replace(/\.epub$/i, '');
  return `${bookName}.md`;
}

function highlightFilePathLabel(filename = highlightFileName()) {
  return `~/Documents/BabyReader/${filename}`;
}

function clearReaderSelection() {
  const sel = window.getSelection?.();
  sel?.removeAllRanges?.();
}

function ensureHighlightLayer() {
  const article = document.getElementById('article');
  if (!article) return null;

  let layer = article.querySelector(':scope > .highlight-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'highlight-layer';
    layer.setAttribute('aria-hidden', 'true');
    article.prepend(layer);
  }
  return layer;
}

function clearRenderedHighlights() {
  const layer = document.querySelector('#article > .highlight-layer');
  if (layer) layer.innerHTML = '';
}

function drawHighlightRects(id, range) {
  const layer = ensureHighlightLayer();
  const article = document.getElementById('article');
  if (!layer || !article || !range) return false;

  const articleRect = article.getBoundingClientRect();
  let drew = false;
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue;
    const box = document.createElement('span');
    box.className = 'br-highlight-box';
    box.dataset.highlightId = id;
    box.style.left = `${rect.left - articleRect.left}px`;
    box.style.top = `${rect.top - articleRect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    layer.appendChild(box);
    drew = true;
  }
  return drew;
}

function findRangeForHighlightText(text) {
  const article = document.getElementById('article');
  const needle = selectedTextSignature(text);
  if (!article || !needle) return null;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('.highlight-layer')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.includes(needle)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const node = walker.nextNode();
  if (!node) return null;

  const start = node.nodeValue.indexOf(needle);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + needle.length);
  return range;
}

function saveDomHighlight(id, text) {
  const highlights = loadHighlights();
  if (highlights.some(h => h.id === id)) return;

  highlights.push({
    id,
    text: selectedTextSignature(text),
    date: new Date().toISOString().slice(0, 10)
  });
  saveHighlights(highlights);
  autoSaveHighlights();
  updateTopbarState();
}

function removeHighlightsByText(text) {
  const signature = selectedTextSignature(text);
  if (!signature) return false;

  const highlights = loadHighlights();
  const remaining = highlights.filter(h => selectedTextSignature(h.text) !== signature);
  if (remaining.length === highlights.length) return false;

  saveHighlights(remaining);
  autoSaveHighlights();
  redrawDomHighlights();
  updateTopbarState();
  clearReaderSelection();
  return true;
}

function applyDomHighlightFromRange(range, text) {
  if (!range || range.collapsed) return false;

  if (removeHighlightsByText(text)) return true;

  const id = highlightId();
  if (!drawHighlightRects(id, range)) return false;
  saveDomHighlight(id, text);
  clearReaderSelection();
  return true;
}

function setPendingDomHighlight(range, text) {
  if (!range || range.collapsed || !selectedTextSignature(text)) return;

  const article = document.getElementById('article');
  const common = range.commonAncestorContainer;
  const commonElement = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
  if (!article || !commonElement || !article.contains(commonElement)) return;

  let rect;
  try {
    rect = range.getBoundingClientRect();
  } catch {
    return;
  }
  if (!rect || (!rect.width && !rect.height)) return;

  const pill = getHighlightPill();
  const oldHandler = pill._clickHandler;
  if (oldHandler) pill.removeEventListener('click', oldHandler);

  const sig = selectedTextSignature(text);
  const isExisting = sig && loadHighlights().some(h => selectedTextSignature(h.text) === sig);
  pill.textContent = isExisting ? '删除划线' : '划线';

  const clonedRange = range.cloneRange();
  const handler = () => {
    const pending = _pendingDomHighlight;
    dismissHighlightPill();
    if (pending) applyDomHighlightFromRange(pending.range, pending.text);
  };
  pill._clickHandler = handler;
  pill.addEventListener('click', handler);

  showHighlightPill(rect.left + rect.width / 2 - 28, rect.top - 42);
  _pendingDomHighlight = { range: clonedRange, text };
}

function setupDomHighlightInteraction() {
  const article = document.getElementById('article');
  if (!article || article._babyreaderDomHighlightBound) return;
  article._babyreaderDomHighlightBound = true;

  const readSelection = () => {
    if (state.contentType !== 'epub') return;
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    setPendingDomHighlight(range, sel.toString());
  };

  article.addEventListener('mouseup', () => setTimeout(readSelection, 0));
  article.addEventListener('keyup', () => setTimeout(readSelection, 0));
  article.addEventListener('touchend', () => setTimeout(readSelection, 120));
}

function highlightCurrentDomSelection() {
  if (state.contentType !== 'epub') return false;
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  return applyDomHighlightFromRange(range, sel.toString());
}

function redrawDomHighlights() {
  const highlights = loadHighlights();
  const article = document.getElementById('article');
  if (!article) return;

  clearRenderedHighlights();
  ensureHighlightLayer();
  for (const h of highlights) {
    const range = findRangeForHighlightText(h.text);
    if (range) drawHighlightRects(h.id, range);
  }
}

function iframeRectForContents(contents) {
  for (const iframe of document.querySelectorAll('#epubViewer iframe')) {
    if (iframe.contentWindow === contents?.window) {
      return iframe.getBoundingClientRect();
    }
  }
  return { left: 0, top: 0 };
}

function addHighlight(cfi, text, contents) {
  if (!cfi || !state.epubRendition) return;

  const highlights = loadHighlights();
  if (highlights.some(h => h.cfi === cfi)) {
    contents?.window?.getSelection()?.removeAllRanges();
    return;
  }

  state.epubRendition.annotations.highlight(cfi, {}, (e) => {
    e.stopPropagation();
    state.epubRendition.annotations.remove(cfi, 'highlight');
    const remaining = loadHighlights().filter(x => x.cfi !== cfi);
    saveHighlights(remaining);
    autoSaveHighlights();
    updateTopbarState();
  });

  highlights.push({
    cfi,
    text: String(text || '').slice(0, 500),
    date: new Date().toISOString().slice(0, 10)
  });
  saveHighlights(highlights);
  autoSaveHighlights();
  updateTopbarState();
  contents?.window?.getSelection()?.removeAllRanges();
}

function setPendingHighlight(cfiRange, contents, range, text) {
  if (!cfiRange || !contents || !range) return;

  let x = 0;
  let y = 0;
  try {
    const rect = range.getBoundingClientRect();
    const iframeRect = iframeRectForContents(contents);
    x = iframeRect.left + rect.left + rect.width / 2 - 28;
    y = iframeRect.top + rect.top - 42;
  } catch {
    return;
  }

  const pill = getHighlightPill();
  const oldHandler = pill._clickHandler;
  if (oldHandler) pill.removeEventListener('click', oldHandler);

  const handler = () => {
    const cfi = cfiRange;
    dismissHighlightPill();
    addHighlight(cfi, text, contents);
  };
  pill._clickHandler = handler;
  pill.addEventListener('click', handler);
  showHighlightPill(x, y, cfiRange);
}

function setupHighlightInteraction() {
  if (!state.epubRendition) return;

  state.epubRendition.on('selected', (cfiRange, contents) => {
    const sel = contents.window.getSelection();
    if (!sel || sel.isCollapsed) return;

    try {
      const range = sel.getRangeAt(0);
      setPendingHighlight(cfiRange, contents, range, sel.toString());
    } catch {
      return;
    }
  });

}

function destroyEpub() {
  dismissHighlightPill();
  state.epubMetadata = null;
  state.epubHtml = '';
  if (state.epubRendition) {
    state.epubRendition.destroy();
    state.epubRendition = null;
  }
  if (state.epubBook) {
    state.epubBook.destroy();
    state.epubBook = null;
  }

  const viewer = document.getElementById('epubViewer');
  if (viewer) viewer.innerHTML = '';
}

async function renderEpubDocument(base64data) {
  destroyEpub();
  const epub = await parseEpub(base64data);
  state.epubHtml = epub.html;
  state.epubMetadata = epub.metadata || {};
  state.toc = epub.toc || [];
  renderToc();
  updateTopbarState();
}

/* ============================================================
   EPUB Parser
   ============================================================ */
async function parseEpub(base64data) {
  const zip = await JSZip.loadAsync(base64data, { base64: true });

  // 1. Find OPF path from META-INF/container.xml
  const containerXml = await zip.file('META-INF/container.xml').async('text');
  const opfMatch = containerXml.match(/full-path="([^"]+\.opf)"/i);
  if (!opfMatch) throw new Error('Cannot find OPF file in EPUB');
  const opfPath = opfMatch[1];
  const opfDir  = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Parse OPF to get spine order
  const opfXml = await zip.file(opfPath).async('text');
  const title = stripXmlTags((opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '');
  const creator = stripXmlTags((opfXml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '');

  // Build manifest: id → item metadata
  const manifest = {};
  const mediaTypes = {};
  const manifestRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = manifestRe.exec(opfXml)) !== null) {
    const id = getXmlAttribute(m[0], 'id');
    const href = getXmlAttribute(m[0], 'href');
    const mediaType = getXmlAttribute(m[0], 'media-type') || '';
    const properties = getXmlAttribute(m[0], 'properties') || '';
    if (id && href) {
      const fullPath = resolveZipPath(opfDir, href);
      manifest[id] = { href, fullPath, mediaType, properties };
      if (mediaType) mediaTypes[fullPath] = mediaType;
    }
  }

  // Get spine order (idref list)
  const spineRe = /<itemref\b[^>]*>/gi;
  const spineIds = [];
  while ((m = spineRe.exec(opfXml)) !== null) {
    const idref = getXmlAttribute(m[0], 'idref');
    if (idref) spineIds.push(idref);
  }

  // 3. Read each chapter XHTML and extract body content
  const chapters = [];
  const chapterTargets = {};
  for (const id of spineIds) {
    const item = manifest[id];
    if (!item) continue;
    const fullPath = item.fullPath;
    const file = getZipFile(zip, fullPath);
    if (!file) continue;

    const xhtml = await file.async('text');
    // Extract body content
    const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : xhtml;
    // Strip namespace attributes and xml:lang etc
    const chapterId = `br-chapter-${chapters.length + 1}`;
    chapterTargets[fullPath] = `#${chapterId}`;
    const cleaned = await inlineResourceRefs(sanitizeEpubHtml(bodyContent), fullPath, zip, mediaTypes)
      .then(content => content
      .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '')
      .replace(/\s+xml:\w+="[^"]*"/g, '')
      .replace(/<svg\b/gi, '<svg class="epub-svg"')
      );
    chapters.push(`<section class="epub-chapter" id="${chapterId}" data-source-path="${escapeHtmlAttribute(fullPath)}">${cleaned}</section>`);
  }

  if (!chapters.length) {
    throw new Error('No readable chapters found in EPUB');
  }

  let toc = [];
  const navItem = Object.values(manifest).find(item => /\bnav\b/i.test(item.properties));
  if (navItem) {
    const navFile = getZipFile(zip, navItem.fullPath);
    if (navFile) toc = parseNavToc(await navFile.async('text'), navItem.fullPath, chapterTargets);
  }

  if (!toc.length) {
    const ncxItem = Object.values(manifest).find(item => item.mediaType === 'application/x-dtbncx+xml')
      || manifest[(opfXml.match(/<spine\b[^>]*toc\s*=\s*(["'])(.*?)\1/i) || [])[2]];
    if (ncxItem) {
      const ncxFile = getZipFile(zip, ncxItem.fullPath);
      if (ncxFile) toc = parseNcxToc(await ncxFile.async('text'), ncxItem.fullPath, chapterTargets);
    }
  }

  return {
    html: chapters.join('\n<hr class="chapter-break">\n'),
    toc,
    metadata: { title, creator }
  };
}

/* ============================================================
   Marked Configuration
   ============================================================ */
function configureMarked() {
  if (typeof marked === 'undefined') return;

  marked.setOptions({
    gfm: true,
    breaks: false
  });
}

/* ============================================================
   Rendering
   ============================================================ */
function renderArticle() {
  const article = document.getElementById('article');
  const reader = document.getElementById('reader');
  const welcome = document.getElementById('welcome');
  const epubShell = document.getElementById('epubShell');
  const isWelcome = !state.currentPath && (!state.content || !state.content.trim());

  if (reader) reader.classList.toggle('is-welcome', isWelcome);
  document.body.classList.toggle('is-welcome', isWelcome);

  if (isWelcome) {
    if (epubShell) epubShell.style.display = 'none';
    if (article) article.style.display = '';
    article.innerHTML = '';
    if (welcome) {
      welcome.style.display = '';
      article.appendChild(welcome);
    }
    return;
  }

  if (!state.content || !state.content.trim()) {
    if (epubShell) epubShell.style.display = 'none';
    if (article) article.style.display = '';
    article.innerHTML = '';
    return;
  }

  if (state.contentType === 'epub') {
    if (epubShell) epubShell.style.display = 'none';
    if (article) {
      article.style.display = '';
      article.innerHTML = state.epubHtml || '';
      ensureHighlightLayer();
      requestAnimationFrame(redrawDomHighlights);
    }
  } else {
    if (epubShell) epubShell.style.display = 'none';
    if (article) article.style.display = '';
    // Markdown — run through preprocessor + marked
    const html = preprocessCustomBlocks(state.content);
    article.innerHTML = html;
  }
}

function ensureTocElement() {
  let toc = document.getElementById('toc');
  if (toc) return toc;

  toc = document.createElement('aside');
  toc.id = 'toc';
  toc.className = 'toc';
  toc.innerHTML = '<div class="toc-title">目录</div><ol id="tocList"></ol>';
  document.body.appendChild(toc);
  return toc;
}

function renderToc() {
  const toc = ensureTocElement();
  const list = document.getElementById('tocList');
  const hasToc = state.contentType === 'epub' && state.toc.length > 0;

  toc.style.display = hasToc ? '' : 'none';
  updateTopbarState();
  if (!list || !hasToc) return;

  list.innerHTML = state.toc.map((item) => {
    const depth = Math.min(Number(item.depth || 0), 3);
    return `<li class="toc-depth-${depth}"><a href="#" data-target="${escapeHtmlAttribute(item.target)}">${escapeHtml(item.label)}</a></li>`;
  }).join('');
}

function restoreTextScroll() {
  const reader = document.getElementById('reader');
  const saved = savedPosition();
  if (!reader || typeof saved?.scrollTop !== 'number') return;

  requestAnimationFrame(() => {
    reader.scrollTop = Math.max(0, saved.scrollTop);
  });
}

const saveTextScroll = debounce(() => {
  if (!state.currentPath || state.mode !== 'read') return;
  const reader = document.getElementById('reader');
  if (!reader) return;
  savePosition({ scrollTop: reader.scrollTop });
}, 250);

function renderPreview() {
  const preview = document.getElementById('preview');
  if (!preview) return;

  const raw = document.getElementById('editor')?.value || '';
  const html = preprocessCustomBlocks(raw);
  preview.innerHTML = html;
}

/* ============================================================
   Mode Switching
   ============================================================ */
function setMode(mode) {
  // EPUB files are read-only — never enter edit mode
  if (mode === 'edit' && state.contentType === 'epub') return;

  const prevMode = state.mode;
  state.mode = mode;

  const reader          = document.getElementById('reader');
  const editorContainer = document.getElementById('editorContainer');
  const btnRead         = document.getElementById('btnRead');
  const btnEdit         = document.getElementById('btnEdit');
  const editor          = document.getElementById('editor');

  if (mode === 'read') {
    // Flush editor content before switching — only if coming from edit mode
    if (prevMode === 'edit' && editor) {
      state.content = editor.value;
      // Auto-save to disk when leaving edit mode
      if (state.isNative && state.currentPath && state.contentType !== 'epub' && state.dirty) {
        sendNative('save');
      }
    }

    reader.style.display          = '';
    editorContainer.style.display = 'none';
    btnRead.classList.add('active');
    btnEdit.classList.remove('active');
    renderArticle();

  } else if (mode === 'edit') {
    reader.style.display          = 'none';
    editorContainer.style.display = 'flex';
    btnRead.classList.remove('active');
    btnEdit.classList.add('active');

    // Populate textarea with raw content
    editor.value = state.content;

    // Render initial preview
    renderPreview();

    // Focus editor
    editor.focus();
  }
}

/* ============================================================
   Debounce
   ============================================================ */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/* ============================================================
   Zoom
   ============================================================ */
let zoomLevel = 100; // percentage

function applyZoom() {
  document.documentElement.style.fontSize = (zoomLevel / 100 * 16) + 'px';
  applyEpubTheme();
  applyThemeToEpubFrames();
  requestAnimationFrame(redrawDomHighlights);
}

/* ============================================================
   File Operations — Browser Fallback
   ============================================================ */
function openFileBrowser() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.md,.txt,.epub,text/markdown,text/plain,application/epub+zip';

  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const isEpub = /\.epub$/i.test(file.name);
      const result = ev.target.result || '';
      window.appHost.receiveDocument({
        path: file.name,
        name: file.name,
        type: isEpub ? 'epub' : 'text',
        content: isEpub ? '' : result,
        data: isEpub ? String(result).split(',')[1] : undefined
      });
    };

    if (/\.epub$/i.test(file.name)) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file, 'UTF-8');
    }
  };

  input.click();
}

function saveFileBrowser() {
  const blob = new Blob([state.content || ''], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = state.currentName || 'document.md';
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Highlight Export & Auto-save
   ============================================================ */
function formatHighlightsMd(highlights) {
  const bookName = (state.currentName || '未知书籍').replace(/\.epub$/i, '');
  const author = state.epubMetadata?.creator || '';

  let md = `# 《${bookName}》划线笔记\n\n`;
  if (author) md += `作者：${author}\n\n`;
  md += `---\n\n`;

  for (const h of highlights) {
    if (h.text) {
      md += h.date ? `- [${h.date}] ${h.text}\n\n` : `- ${h.text}\n\n`;
    }
  }
  return md;
}

function autoSaveHighlights() {
  if (!state.isNative || state.contentType !== 'epub') return;
  const highlights = loadHighlights();
  const md = formatHighlightsMd(highlights);
  sendNative('writeFile', { filename: highlightFileName(), content: md, silent: true });
}

function exportHighlights() {
  if (state.contentType !== 'epub') return;
  const highlights = loadHighlights();
  if (!highlights.length) {
    showHighlightHint('还没有 EPUB 划线');
    return;
  }

  const md = formatHighlightsMd(highlights);

  const showCopied = () => {
    flashFileName(`已导出 ${highlights.length} 条划线`, 2600);
  };

  if (state.isNative) {
    sendNative('writeFile', { filename: highlightFileName(), content: md, silent: false });
    sendNative('copyText', { text: md });
    showCopied();
    return;
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = highlightFileName();
  a.click();
  URL.revokeObjectURL(url);
  navigator.clipboard?.writeText?.(md).catch(() => {});
  showCopied();
}

function flashFileName(message, duration = 1600) {
  const fileNameEl = document.getElementById('fileName');
  if (!fileNameEl) return;

  const wasHidden = getComputedStyle(fileNameEl).display === 'none';
  const prev = fileNameEl.dataset.flashPrev ?? fileNameEl.textContent;
  fileNameEl.dataset.flashPrev = prev;
  clearTimeout(_fileNameFlashTimeout);

  if (wasHidden) fileNameEl.style.display = 'block';
  fileNameEl.textContent = message;
  fileNameEl.style.color = 'var(--accent)';
  _fileNameFlashTimeout = setTimeout(() => {
    fileNameEl.textContent = fileNameEl.dataset.flashPrev || '';
    fileNameEl.style.color = '';
    if (wasHidden) fileNameEl.style.display = '';
    delete fileNameEl.dataset.flashPrev;
  }, duration);
}

function showHighlightHint(message) {
  flashFileName(message, 1600);
}

/* ============================================================
   Keyboard Shortcuts
   ============================================================ */
function isShortcutModifierDown(e) {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  return isMac ? e.metaKey : e.ctrlKey;
}

function handleKeyboardShortcut(e) {
  if (!isShortcutModifierDown(e)) return false;

  switch (e.key.toLowerCase()) {
    case 'o':
      e.preventDefault();
      if (state.isNative) {
        sendNative('open');
      } else {
        openFileBrowser();
      }
      return true;

    case 's':
      e.preventDefault();
      // Sync editor content to state before saving
      if (state.mode === 'edit') {
        const editor = document.getElementById('editor');
        if (editor) state.content = editor.value;
      }
      if (state.isNative) {
        sendNative('save', { content: state.content, path: state.currentPath });
      } else {
        saveFileBrowser();
      }
      return true;

    case '=':
    case '+':
      e.preventDefault();
      zoomLevel = Math.min(200, zoomLevel + 10);
      applyZoom();
      return true;

    case '-':
      e.preventDefault();
      zoomLevel = Math.max(60, zoomLevel - 10);
      applyZoom();
      return true;

    case '0':
      e.preventDefault();
      zoomLevel = 100;
      applyZoom();
      return true;

    case 'h':
      if (state.contentType === 'epub') {
        e.preventDefault();
        if (!runPendingHighlight() && !highlightCurrentDomSelection()) {
          showHighlightHint('先选中一段 EPUB 文本');
        }
        return true;
      }
      return false;

    case 'e':
      if (e.shiftKey && state.contentType === 'epub') {
        e.preventDefault();
        exportHighlights();
        return true;
      }
      if (!e.shiftKey && state.contentType !== 'epub') {
        e.preventDefault();
        setMode(state.mode === 'read' ? 'edit' : 'read');
        return true;
      }
      return false;

    default:
      return false;
  }
}

function setupKeyboard() {
  document.addEventListener('keydown', handleKeyboardShortcut);
}

function setupEpubContentKeyboard(contents) {
  const doc = contents?.document;
  const win = contents?.window;
  if (!doc) return;
  if (doc._babyreaderShortcutsBound) return;
  doc._babyreaderShortcutsBound = true;
  doc.addEventListener('keydown', handleKeyboardShortcut, true);
  win?.addEventListener?.('keydown', handleKeyboardShortcut, true);
}

function setupEpubContentSelection(contents) {
  const doc = contents?.document;
  const win = contents?.window;
  if (!doc || !win || doc._babyreaderSelectionBound) return;
  doc._babyreaderSelectionBound = true;

  const readSelection = () => {
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    let range;
    let cfiRange;
    try {
      range = sel.getRangeAt(0);
      if (typeof contents.cfiFromRange === 'function') {
        cfiRange = contents.cfiFromRange(range);
      } else if (typeof contents.section?.cfiFromRange === 'function') {
        cfiRange = contents.section.cfiFromRange(range);
      } else if (state.epubBook?.cfiFromRange) {
        cfiRange = state.epubBook.cfiFromRange(range);
      }
    } catch {
      return;
    }

    if (!cfiRange) return;
    setPendingHighlight(cfiRange, contents, range, sel.toString());
  };

  doc.addEventListener('mouseup', () => setTimeout(readSelection, 0));
  doc.addEventListener('keyup', () => setTimeout(readSelection, 0));
  doc.addEventListener('touchend', () => setTimeout(readSelection, 120));
  doc.addEventListener('selectionchange', () => setTimeout(readSelection, 0));
}

function setupTocNavigation() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('.toc a[data-target]');
    if (!link) return;

    e.preventDefault();
    const target = link.getAttribute('data-target');
    if (state.epubRendition && target) {
      state.epubRendition.display(target);
      return;
    }

    const node = target?.startsWith('#')
      ? document.getElementById(decodeURIComponent(target.slice(1)))
      : null;
    if (node) {
      node.scrollIntoView({ block: 'start' });
    }
  });
}

function setupThemeToggle() {
  const savedTheme = localStorage.getItem('babyreader-theme');
  applyTheme(savedTheme || 'dark', false);

  const btnTheme = document.getElementById('btnTheme');
  if (btnTheme) {
    btnTheme.addEventListener('click', toggleTheme);
  }
}

function setupTocToggle() {
  const savedTocOpen = localStorage.getItem('babyreader-toc-open');
  state.tocOpen = savedTocOpen === null ? true : savedTocOpen === '1';

  const btnToc = document.getElementById('btnToc');
  if (btnToc) {
    btnToc.addEventListener('click', toggleToc);
  }
}

function setupHighlightButtons() {
  const btnHighlight = document.getElementById('btnHighlight');
  if (btnHighlight) {
    btnHighlight.addEventListener('click', () => {
      if (state.contentType !== 'epub') return;
      if (!runPendingHighlight() && !highlightCurrentDomSelection()) {
        showHighlightHint('先选中一段 EPUB 文本');
      }
    });
  }

  const btnExport = document.getElementById('btnExportHighlights');
  if (btnExport) {
    btnExport.addEventListener('click', exportHighlights);
  }
}

function setupPositionTracking() {
  const reader = document.getElementById('reader');
  if (reader) {
    reader.addEventListener('scroll', saveTextScroll);
  }
}

/* ============================================================
   appHost API — called by native layer
   ============================================================ */
window.appHost = {
  async receiveDocument({ path, name, type, content, data }) {
    state.currentPath  = path;
    state.currentName  = name;
    state.contentType  = (type === 'epub') ? 'epub' : 'text';
    state.toc          = [];
    _pendingCfiRange   = null;
    renderToc();
    updateTopbarState();

    const fileNameEl = document.getElementById('fileName');
    if (fileNameEl) fileNameEl.textContent = name;

    if (type === 'epub' && data) {
      // Show loading state
      const article = document.getElementById('article');
      const epubShell = document.getElementById('epubShell');
      if (article) {
        article.style.display = '';
        article.innerHTML = '<p style="color:var(--text-dim);padding:80px 40px;">正在打开 EPUB…</p>';
      }
      if (epubShell) epubShell.style.display = 'none';

      try {
        state.content = '[epub]';
        renderArticle();
        await renderEpubDocument(data);
      } catch (err) {
        destroyEpub();
        state.content = `<p style="color:var(--accent)">EPUB 解析失败：${err.message}</p>`;
        state.contentType = 'text';
      }
    } else {
      destroyEpub();
      state.content = content || '';
    }

    setDirty(false);
    setMode('read');
    renderArticle();
    restoreTextScroll();
    renderToc();
    updateTopbarState();
  },

  notifySaved({ path, name } = {}) {
    if (path) state.currentPath = path;
    if (name) state.currentName = name;
    setDirty(false, false);

    const fileNameEl = document.getElementById('fileName');
    if (!fileNameEl) return;

    const displayName = name || state.currentName;
    fileNameEl.textContent = '已保存';
    fileNameEl.style.color = 'var(--accent)';

    setTimeout(() => {
      fileNameEl.textContent = displayName;
      fileNameEl.style.color = '';
    }, 1200);
  },

  notifyHighlightFileWritten({ path, silent } = {}) {
    if (silent) return;
    if (path) flashFileName(`已导出到 ${path}`, 4200);
  },

  getContent() {
    if (state.mode === 'edit') {
      const editor = document.getElementById('editor');
      if (editor) state.content = editor.value;
    }
    return state.contentType === 'epub' ? '' : state.content;
  },

  toggleEditMode() {
    // Don't allow editing EPUB files
    if (state.contentType === 'epub') return;
    setMode(state.mode === 'read' ? 'edit' : 'read');
  },

  toggleTheme,

  highlightSelection() {
    if (state.contentType !== 'epub') return;
    if (!runPendingHighlight() && !highlightCurrentDomSelection()) {
      showHighlightHint('先选中一段 EPUB 文本');
    }
  },

  exportHighlights,

  zoomIn()    { zoomLevel = Math.min(200, zoomLevel + 10); applyZoom(); },
  zoomOut()   { zoomLevel = Math.max(60, zoomLevel - 10);  applyZoom(); },
  zoomReset() { zoomLevel = 100; applyZoom(); },

  setImmersive(on) {
    document.body.classList.toggle('immersive', !!on);
  }
};

/* ============================================================
   DOMContentLoaded — Boot
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  configureMarked();
  setupThemeToggle();
  setupTocToggle();
  setupHighlightButtons();

  // Set up editor live preview with debounce
  const editor = document.getElementById('editor');
  if (editor) {
    const debouncedPreview = debounce(() => {
      state.content = editor.value;
      renderPreview();
    }, 300);

    editor.addEventListener('input', () => {
      state.content = editor.value;
      setDirty(true);
      debouncedPreview();
    });
  }

  setupKeyboard();
  setupTocNavigation();
  setupDomHighlightInteraction();
  setupPositionTracking();
  renderArticle();
  updateTopbarState();
  window.addEventListener('resize', debounce(redrawDomHighlights, 120));

  document.addEventListener('click', (e) => {
    if (_highlightPill && e.target !== _highlightPill) {
      dismissHighlightPill();
    }
  });

  // Tell native layer the web view is ready
  sendNative('ready');
});
