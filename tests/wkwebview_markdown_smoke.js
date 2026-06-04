(async () => {
  const failures = [];
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function assert(condition, message) {
    if (!condition) failures.push(message);
  }

  function computed(selector, prop) {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node)[prop] : null;
  }

  async function waitFor(predicate, message, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (predicate()) return true;
      } catch {
        // Keep polling while layout settles.
      }
      await sleep(60);
    }
    failures.push(message);
    return false;
  }

  localStorage.removeItem('babyreader-theme');
  window.__nativeMessages = [];
  const originalSendNative = window.sendNative;
  window.sendNative = function(type, payload) {
    window.__nativeMessages.push({ type, payload: payload || {} });
    return originalSendNative(type, payload);
  };

  await window.appHost.receiveDocument({
    path: '/tmp/babyreader-markdown-smoke.md',
    name: 'babyreader-markdown-smoke.md',
    type: 'text',
    content: '# Smoke Title\n\nOriginal **body** text.'
  });

  await waitFor(() => !document.body.classList.contains('is-welcome'), 'Markdown document stayed in welcome state');
  assert(!document.body.classList.contains('is-epub'), 'Markdown document was marked as EPUB');
  assert(computed('#btnRead', 'display') !== 'none', 'Markdown Read button is hidden');
  assert(computed('#btnEdit', 'display') !== 'none', 'Markdown Edit button is hidden');
  assert(computed('#btnTheme', 'display') !== 'none', 'Theme button is hidden for Markdown');
  assert(computed('#btnHighlight', 'display') === 'none', 'EPUB-only Highlight button is visible for Markdown');
  assert(document.querySelector('#article').innerText.includes('Original body text.'), 'Markdown article did not render initial content');

  document.querySelector('#btnEdit').click();
  await waitFor(() => computed('#editorContainer', 'display') === 'flex', 'Clicking Edit did not enter edit mode');
  assert(computed('#editorContainer', 'display') === 'flex', 'Editor container is not visible in edit mode');
  assert(computed('#reader', 'display') === 'none', 'Reader is still visible in edit mode');

  const editor = document.querySelector('#editor');
  editor.value = '# Edited Title\n\nUpdated preview text.';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('#preview').innerText.includes('Updated preview text.'), 'Markdown live preview did not update');
  assert(window.__nativeMessages.some(message => message.type === 'dirtyChanged' && message.payload?.dirty === true), 'Markdown dirty change was not sent to native layer');

  document.querySelector('#btnRead').click();
  await waitFor(() => computed('#reader', 'display') !== 'none', 'Clicking Read did not return to read mode');
  assert(document.querySelector('#article').innerText.includes('Updated preview text.'), 'Read mode did not render edited Markdown');

  const beforeTheme = document.body.classList.contains('theme-light');
  document.querySelector('#btnTheme').click();
  await sleep(180);
  assert(document.body.classList.contains('theme-light') !== beforeTheme, 'Theme button did not toggle Markdown theme');

  return {
    ok: failures.length === 0,
    failures,
    details: {
      bodyClass: document.body.className,
      editorDisplay: computed('#editorContainer', 'display'),
      readerDisplay: computed('#reader', 'display'),
      articleText: document.querySelector('#article').innerText.trim(),
      nativeMessages: window.__nativeMessages.map(message => message.type)
    }
  };
})()
