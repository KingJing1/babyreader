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
  toc: [],
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
    .replace(/\s+(href|src)\s*=\s*(["'])javascript:[\s\S]*?\2/gi, ' $1="#"');
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
    body {
      background: ${colors.bg} !important;
      color: ${colors.text} !important;
      font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif !important;
      font-size: ${fontSize} !important;
      line-height: 1.9 !important;
      max-width: 760px !important;
      margin: 0 auto !important;
      padding: 0 24px !important;
    }
    p, li {
      color: ${colors.text} !important;
      line-height: 1.9 !important;
      text-align: justify !important;
    }
    h1, h2, h3, h4, h5, h6 {
      color: ${colors.textStrong} !important;
      line-height: 1.35 !important;
    }
    a {
      color: ${colors.accent} !important;
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
    .epubjs-hl { fill: ${highlightColor()} !important; fill-opacity: 1 !important; mix-blend-mode: multiply; }
  `;
}

function applyEpubTheme() {
  if (!state.epubRendition) return;
  state.epubRendition.themes.register('babyreader', getEpubThemeCss());
  state.epubRendition.themes.select('babyreader');
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

  applyEpubTheme();
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
}

let _highlightPill = null;
let _highlightPillTimeout = null;
let _pendingCfiRange = null;

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
  const pill = _highlightPill;
  if (pill) {
    pill.classList.remove('visible');
  }
}

function showHighlightPill(x, y, cfiRange) {
  const pill = getHighlightPill();
  dismissHighlightPill();
  _pendingCfiRange = cfiRange;

  pill.style.left = x + 'px';
  pill.style.top = y + 'px';
  pill.classList.add('visible');

  _highlightPillTimeout = setTimeout(dismissHighlightPill, 3000);
}

function setupHighlightInteraction() {
  if (!state.epubRendition) return;

  state.epubRendition.on('selected', (cfiRange, contents) => {
    const sel = contents.window.getSelection();
    if (!sel || sel.isCollapsed) return;

    let x = 0;
    let y = 0;
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const iframes = document.querySelectorAll('#epubViewer iframe');
      let iframeRect = { left: 0, top: 0 };
      for (const iframe of iframes) {
        if (iframe.contentWindow === contents.window) {
          iframeRect = iframe.getBoundingClientRect();
          break;
        }
      }
      x = iframeRect.left + rect.left + rect.width / 2 - 30;
      y = iframeRect.top + rect.top - 40;
    } catch {
      return;
    }

    const pill = getHighlightPill();

    const oldHandler = pill._clickHandler;
    if (oldHandler) pill.removeEventListener('click', oldHandler);

    const handler = () => {
      dismissHighlightPill();
      const cfi = cfiRange;
      const highlights = loadHighlights();
      if (highlights.some(h => h.cfi === cfi)) {
        contents.window.getSelection().removeAllRanges();
        return;
      }
      state.epubRendition.annotations.highlight(cfi, {}, (e) => {
        e.stopPropagation();
        state.epubRendition.annotations.remove(cfi, 'highlight');
        const remaining = loadHighlights().filter(x => x.cfi !== cfi);
        saveHighlights(remaining);
      });
      let text = '';
      try {
        text = sel.toString().slice(0, 200);
      } catch {
        // ignore
      }
      highlights.push({ cfi, text });
      saveHighlights(highlights);
      contents.window.getSelection().removeAllRanges();
    };
    pill._clickHandler = handler;
    pill.addEventListener('click', handler);

    showHighlightPill(x, y, cfiRange);
  });

}

function destroyEpub() {
  dismissHighlightPill();
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
  if (typeof ePub !== 'function') {
    throw new Error('EPUB renderer is not available');
  }

  destroyEpub();

  const viewer = document.getElementById('epubViewer');
  if (!viewer) throw new Error('EPUB viewer is missing');

  state.epubBook = ePub(base64ToArrayBuffer(base64data));
  state.epubRendition = state.epubBook.renderTo(viewer, {
    width: '100%',
    height: '100%',
    flow: 'scrolled-doc',
    manager: 'continuous',
    spread: 'none',
    allowScriptedContent: false
  });

  applyEpubTheme();

  const navigation = await state.epubBook.loaded.navigation;
  state.toc = flattenToc(navigation?.toc || []);
  renderToc();

  state.epubRendition.on('relocated', (location) => {
    const cfi = location?.start?.cfi;
    if (cfi) savePosition({ cfi });
  });

  setupHighlightInteraction();

  const saved = savedPosition();
  try {
    await state.epubRendition.display(saved?.cfi || undefined);
  } catch {
    await state.epubRendition.display();
  }

  const highlights = loadHighlights();
  for (const h of highlights) {
    try {
      state.epubRendition.annotations.highlight(h.cfi, {}, (e) => {
        e.stopPropagation();
        state.epubRendition.annotations.remove(h.cfi, 'highlight');
        const remaining = loadHighlights().filter(x => x.cfi !== h.cfi);
        saveHighlights(remaining);
      });
    } catch {
      // ignore stale CFI
    }
  }
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
    toc
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
    if (article) article.style.display = 'none';
    if (epubShell) epubShell.style.display = '';
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
  document.body.classList.toggle('has-toc', hasToc);
  if (!list || !hasToc) return;

  list.innerHTML = state.toc.map((item) => {
    const depth = Math.min(Number(item.depth || 0), 3);
    return `<li class="toc-depth-${depth}"><a href="#" data-target="${escapeHtmlAttribute(item.target)}">${escapeHtml(item.label)}</a></li>`;
  }).join('');
}

function restoreTextScroll() {
  if (state.contentType !== 'text') return;
  const reader = document.getElementById('reader');
  const saved = savedPosition();
  if (!reader || typeof saved?.scrollTop !== 'number') return;

  requestAnimationFrame(() => {
    reader.scrollTop = Math.max(0, saved.scrollTop);
  });
}

const saveTextScroll = debounce(() => {
  if (state.contentType !== 'text' || !state.currentPath || state.mode !== 'read') return;
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
   Highlight Export
   ============================================================ */
function exportHighlights() {
  if (state.contentType !== 'epub') return;
  const highlights = loadHighlights();
  if (!highlights.length) return;

  const bookName = (state.currentName || '未知书籍').replace(/\.epub$/i, '');
  const date = new Date().toISOString().slice(0, 10);

  let md = `# 《${bookName}》划线笔记\n\n`;
  md += `导出日期：${date}\n\n---\n\n`;

  for (const h of highlights) {
    if (h.text) {
      md += `> ${h.text}\n\n`;
    }
  }

  navigator.clipboard.writeText(md).then(() => {
    const fileNameEl = document.getElementById('fileName');
    if (!fileNameEl) return;
    const prev = fileNameEl.textContent;
    fileNameEl.textContent = `已复制 ${highlights.length} 条划线`;
    fileNameEl.style.color = 'var(--accent)';
    setTimeout(() => {
      fileNameEl.textContent = prev;
      fileNameEl.style.color = '';
    }, 1600);
  });
}

/* ============================================================
   Keyboard Shortcuts
   ============================================================ */
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const mod   = isMac ? e.metaKey : e.ctrlKey;

    if (!mod) return;

    switch (e.key.toLowerCase()) {
      case 'o':
        e.preventDefault();
        if (state.isNative) {
          sendNative('open');
        } else {
          openFileBrowser();
        }
        break;

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
        break;

      case '=':
      case '+':
        e.preventDefault();
        zoomLevel = Math.min(200, zoomLevel + 10);
        applyZoom();
        break;

      case '-':
        e.preventDefault();
        zoomLevel = Math.max(60, zoomLevel - 10);
        applyZoom();
        break;

      case '0':
        e.preventDefault();
        zoomLevel = 100;
        applyZoom();
        break;

      case 'h':
        if (state.contentType === 'epub' && _pendingCfiRange) {
          e.preventDefault();
          const pill = _highlightPill;
          if (pill && pill._clickHandler) pill._clickHandler();
        }
        break;

      case 'e':
        if (e.shiftKey && state.contentType === 'epub') {
          e.preventDefault();
          exportHighlights();
          return;
        }
        if (!e.shiftKey && state.contentType !== 'epub') {
          e.preventDefault();
          setMode(state.mode === 'read' ? 'edit' : 'read');
        }
        break;
    }
  });
}

function setupTocNavigation() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('.toc a[data-target]');
    if (!link) return;

    e.preventDefault();
    const target = link.getAttribute('data-target');
    if (state.epubRendition && target) {
      state.epubRendition.display(target);
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
    renderToc();

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
  setupPositionTracking();

  document.addEventListener('click', (e) => {
    if (_highlightPill && e.target !== _highlightPill) {
      dismissHighlightPill();
    }
  });

  // Tell native layer the web view is ready
  sendNative('ready');
});
