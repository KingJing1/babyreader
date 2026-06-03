#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..');

function loadParserContext() {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    navigator: { platform: 'MacIntel' },
    document: {
      addEventListener() {},
      createElement() { return {}; },
      getElementById() { return null; }
    },
    window: {}
  };

  context.globalThis = context;
  context.self = context;
  context.window.window = context.window;
  vm.createContext(context);

  vm.runInContext(
    fs.readFileSync(path.join(rootDir, 'web/lib/jszip.min.js'), 'utf8'),
    context,
    { filename: 'jszip.min.js' }
  );
  context.JSZip = context.window.JSZip;
  vm.runInContext(
    fs.readFileSync(path.join(rootDir, 'web/app.js'), 'utf8'),
    context,
    { filename: 'app.js' }
  );

  return context;
}

async function makeEpub({ manifestItems, spineItems, files }) {
  const { JSZip } = loadParserContext();
  const zip = new JSZip();

  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container>
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`);
  for (const [filePath, value] of Object.entries(files)) {
    zip.file(filePath, value);
  }

  return zip.generateAsync({ type: 'base64' });
}

async function testManifestAttributesCanBeInAnyOrder() {
  const context = loadParserContext();
  const base64 = await makeEpub({
    manifestItems: '<item href="Text/chapter1.html" id="chapter1" media-type="application/xhtml+xml"/>',
    spineItems: '<itemref idref="chapter1"/>',
    files: {
      'OEBPS/Text/chapter1.html': `<?xml version="1.0"?>
<html>
  <body>
    <p>Readable chapter text</p>
  </body>
</html>`
    }
  });

  const epub = await context.parseEpub(base64);

  assert.match(epub.html, /Readable chapter text/);
}

async function testRelativeImagesAreInlined() {
  const context = loadParserContext();
  const base64 = await makeEpub({
    manifestItems: `
      <item href="Text/chapter1.html" id="chapter1" media-type="application/xhtml+xml"/>
      <item href="Images/example.png" id="img1" media-type="image/png"/>
    `,
    spineItems: '<itemref idref="chapter1"/>',
    files: {
      'OEBPS/Text/chapter1.html': `<?xml version="1.0"?>
<html>
  <body>
    <p>Before image</p>
    <img src="../Images/example.png" alt="Example">
  </body>
</html>`,
      'OEBPS/Images/example.png': 'png-bytes'
    }
  });

  const epub = await context.parseEpub(base64);

  assert.match(epub.html, /<img src="data:image\/png;base64,/);
  assert.match(epub.html, /alt="Example"/);
  assert.doesNotMatch(epub.html, /\.\.\/Images\/example\.png/);
}

async function testNavTocTargetsChapterAnchors() {
  const context = loadParserContext();
  const base64 = await makeEpub({
    manifestItems: `
      <item href="Text/chapter1.html" id="chapter1" media-type="application/xhtml+xml"/>
      <item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>
    `,
    spineItems: '<itemref idref="chapter1"/>',
    files: {
      'OEBPS/Text/chapter1.html': `<?xml version="1.0"?>
<html>
  <body>
    <h1>Chapter One</h1>
  </body>
</html>`,
      'OEBPS/nav.xhtml': `<?xml version="1.0"?>
<html>
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/chapter1.html">01 从零开始</a></li>
      </ol>
    </nav>
  </body>
</html>`
    }
  });

  const epub = await context.parseEpub(base64);

  assert.equal(
    JSON.stringify(epub.toc),
    JSON.stringify([{ label: '01 从零开始', target: '#br-chapter-1' }])
  );
  assert.match(epub.html, /id="br-chapter-1"/);
}

async function testUnsafeEpubHtmlIsStripped() {
  const context = loadParserContext();
  const base64 = await makeEpub({
    manifestItems: '<item href="Text/chapter1.html" id="chapter1" media-type="application/xhtml+xml"/>',
    spineItems: '<itemref idref="chapter1"/>',
    files: {
      'OEBPS/Text/chapter1.html': `<?xml version="1.0"?>
<html>
  <body>
    <script>alert('x')</script>
    <p onclick="alert('x')">Safe text</p>
    <a href="javascript:alert('x')">Bad link</a>
  </body>
</html>`
    }
  });

  const epub = await context.parseEpub(base64);

  assert.match(epub.html, /Safe text/);
  assert.doesNotMatch(epub.html, /<script/);
  assert.doesNotMatch(epub.html, /onclick=/);
  assert.doesNotMatch(epub.html, /javascript:/);
}

(async () => {
  await testManifestAttributesCanBeInAnyOrder();
  await testRelativeImagesAreInlined();
  await testNavTocTargetsChapterAnchors();
  await testUnsafeEpubHtmlIsStripped();
  console.log('epub parser tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
