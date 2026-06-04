(async () => {
  const failures = [];
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function assert(condition, message) {
    if (!condition) failures.push(message);
  }

  async function waitFor(predicate, message, timeout = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (predicate()) return true;
      } catch {
        // Keep polling while EPUB iframe settles.
      }
      await sleep(80);
    }
    failures.push(message);
    return false;
  }

  function computed(selector, prop, root = document) {
    const node = root.querySelector(selector);
    return node ? getComputedStyle(node)[prop] : null;
  }

  function highlightKey() {
    return Object.keys(localStorage).find(key => key.startsWith('babyreader:highlights:epub:'));
  }

  function highlightCount() {
    const key = highlightKey();
    if (!key) return 0;
    return JSON.parse(localStorage.getItem(key) || '[]').length;
  }

  localStorage.removeItem('babyreader-theme');
  localStorage.setItem('babyreader-toc-open', '1');
  window.__nativeMessages = [];
  const originalSendNative = window.sendNative;
  window.sendNative = function(type, payload) {
    window.__nativeMessages.push({ type, payload: payload || {} });
    return originalSendNative(type, payload);
  };
  if (document.body.classList.contains('theme-light')) {
    window.appHost.toggleTheme();
  }
  assert(computed('#topbar', 'display') !== 'none', 'Welcome screen should show the app topbar');
  assert(computed('.app-name', 'display') === 'none', 'Welcome screen should hide the app name in the topbar');

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">babyreader-smoke</dc:identifier><dc:title>BabyReader Test</dc:title><dc:creator>Smoke</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest><item href="Text/chapter1.xhtml" id="c1" media-type="application/xhtml+xml"/><item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/></spine></package>');
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="Text/chapter1.xhtml">Chapter One</a></li></ol></nav></body></html>');
  zip.file('OEBPS/Text/chapter1.xhtml', `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <title>Chapter One</title>
        <style>
          html, body { background: #ffffff !important; color: #000000 !important; }
          p, h1, span, strong { color: #000000 !important; }
        </style>
      </head>
      <body>
        <h1>Chapter One</h1>
        <p id="p1" style="font-size:42px;font-weight:900;color:#000000;"><span>BabyReader regression text for highlighting and zoom testing inside WebKit.</span></p>
        <p>Second paragraph for scroll, layout and theme background checks.</p>
      </body>
    </html>`);

  const data = await zip.generateAsync({ type: 'base64' });
  await window.appHost.receiveDocument({
    path: '/tmp/babyreader-smoke.epub',
    name: 'babyreader-smoke.epub',
    type: 'epub',
    data
  });

  await waitFor(() => document.querySelector('#article #p1'), 'EPUB paragraph did not render');

  assert(document.body.classList.contains('is-epub'), 'EPUB mode did not mark body.is-epub');
  assert(computed('#btnEdit', 'display') === 'none', 'EPUB mode still shows Edit button');
  assert(computed('#btnRead', 'display') === 'none', 'EPUB mode still shows Read button');
  assert(!document.querySelector('#btnToc').hidden, 'TOC toggle is hidden for EPUB with TOC');
  assert(document.body.classList.contains('toc-open'), 'TOC should default open when fixture has TOC');

  const articleLeftWithToc = document.querySelector('#article').getBoundingClientRect().left;
  const tocRight = document.querySelector('#toc').getBoundingClientRect().right;
  assert(articleLeftWithToc >= tocRight, `TOC overlaps article: toc right ${tocRight}, article left ${articleLeftWithToc}`);
  document.querySelector('#btnToc').click();
  await sleep(120);
  assert(!document.body.classList.contains('toc-open'), 'TOC toggle did not hide the TOC');
  const articleLeftWithoutToc = document.querySelector('#article').getBoundingClientRect().left;
  assert(articleLeftWithToc > articleLeftWithoutToc, `TOC open did not reserve space for article: ${articleLeftWithToc} -> ${articleLeftWithoutToc}`);
  document.querySelector('#btnToc').click();
  await sleep(120);
  assert(document.body.classList.contains('toc-open'), 'TOC toggle did not show the TOC again');

  const darkBodyBg = computed('body', 'backgroundColor');
  const darkTextColor = computed('#p1 span', 'color');
  const paragraphWeight = computed('#p1 span', 'fontWeight');
  const paragraphWidth = document.querySelector('#p1').getBoundingClientRect().width;
  assert(darkBodyBg === 'rgb(30, 30, 30)', `Dark EPUB background was ${darkBodyBg}`);
  assert(darkTextColor !== 'rgb(0, 0, 0)', `Dark EPUB text remained black: ${darkTextColor}`);
  assert(Number(paragraphWeight) < 500 || paragraphWeight === 'normal', `EPUB paragraph stayed bold: ${paragraphWeight}`);
  assert(paragraphWidth <= 820, `EPUB paragraph width escaped reader measure: ${paragraphWidth}`);
  assert(!document.querySelector('#p1').hasAttribute('style'), 'EPUB inline style was not stripped');

  const initialFont = parseFloat(computed('#p1', 'fontSize'));
  const keyEvent = document.createEvent('Event');
  keyEvent.initEvent('keydown', true, true);
  Object.defineProperty(keyEvent, 'key', { value: '=' });
  Object.defineProperty(keyEvent, 'metaKey', { value: true });
  document.dispatchEvent(keyEvent);
  await sleep(180);
  const zoomedFont = parseFloat(computed('#p1', 'fontSize'));
  assert(zoomedFont > initialFont, `EPUB keyboard zoom did not increase font size: ${initialFont} -> ${zoomedFont}`);
  window.appHost.zoomReset();
  await sleep(120);
  const resetFont = parseFloat(computed('#p1', 'fontSize'));
  assert(Math.abs(resetFont - initialFont) < 0.2, `EPUB zoom reset did not restore font size: ${resetFont} vs ${initialFont}`);

  document.querySelector('#btnTheme').click();
  await sleep(220);
  const lightBodyBg = computed('body', 'backgroundColor');
  assert(localStorage.getItem('babyreader-theme') === 'light', 'Light theme was not persisted');
  assert(lightBodyBg === 'rgb(252, 248, 241)', `Light EPUB background was ${lightBodyBg}`);
  document.querySelector('#btnTheme').click();
  await sleep(220);
  assert(localStorage.getItem('babyreader-theme') === 'dark', 'Dark theme was not persisted after switching back');

  const textNode = document.querySelector('#p1 span').firstChild;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 28);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const selectionEvent = document.createEvent('Event');
  selectionEvent.initEvent('selectionchange', true, true);
  document.dispatchEvent(selectionEvent);
  const mouseEvent = document.createEvent('MouseEvents');
  mouseEvent.initMouseEvent('mouseup', true, true, window, 1, 0, 0, 10, 10, false, false, false, false, 0, null);
  document.querySelector('#article').dispatchEvent(mouseEvent);
  const sawHighlightPill = await waitFor(() => document.querySelector('.highlight-pill.visible'), 'Selecting EPUB text did not show highlight pill');
  if (sawHighlightPill) {
    document.querySelector('.highlight-pill').click();
  }
  await waitFor(() => {
    const key = highlightKey();
    if (!key) return false;
    return JSON.parse(localStorage.getItem(key) || '[]').length === 1;
  }, 'Clicking highlight pill did not save a highlight');
  const highlightBoxes = [...document.querySelectorAll('.br-highlight-box')];
  assert(highlightBoxes.length > 0, 'Saved highlight did not render overlay boxes');
  assert(!document.querySelector('mark.br-highlight'), 'Highlight should not wrap article DOM with mark');
  assert(highlightBoxes.every(box => box.getBoundingClientRect().width < paragraphWidth), 'Highlight overlay expanded to full article width');

  const sameRange = document.createRange();
  sameRange.setStart(textNode, 0);
  sameRange.setEnd(textNode, 28);
  selection.removeAllRanges();
  selection.addRange(sameRange);
  document.querySelector('#btnHighlight').click();
  await waitFor(() => highlightCount() === 0, 'Selecting an existing highlight and pressing Highlight did not remove it');
  assert(document.querySelectorAll('.br-highlight-box').length === 0, 'Removed highlight left overlay boxes behind');

  const reAddRange = document.createRange();
  reAddRange.setStart(textNode, 0);
  reAddRange.setEnd(textNode, 28);
  selection.removeAllRanges();
  selection.addRange(reAddRange);
  document.querySelector('#btnHighlight').click();
  await waitFor(() => highlightCount() === 1, 'Highlight button did not add highlight after toggle removal');

  window.appHost.exportHighlights();
  await waitFor(() => window.__nativeMessages?.some?.(message => message.type === 'exportFile' && message.payload && message.payload.filename === 'babyreader-smoke.md'), 'Export highlights did not request a visible Markdown file export');
  window.appHost.notifyHighlightFileWritten({ path: '/tmp/babyreader-smoke.md', silent: false });
  await waitFor(() => document.querySelector('#fileName').textContent.startsWith('已导出到'), 'Export highlights did not show exported feedback');

  return {
    ok: failures.length === 0,
    failures,
    details: {
      darkBodyBg,
      darkTextColor,
      paragraphWeight,
      paragraphWidth,
      lightBodyBg,
      initialFont,
      zoomedFont,
      resetFont,
      bodyClass: document.body.className,
      highlightCount: JSON.parse(localStorage.getItem(highlightKey()) || '[]').length
    }
  };
})()
