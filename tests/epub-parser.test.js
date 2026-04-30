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

async function makeEpub({ manifestItem }) {
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
    ${manifestItem}
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`);
  zip.file('OEBPS/Text/chapter1.html', `<?xml version="1.0"?>
<html>
  <body>
    <p>Readable chapter text</p>
  </body>
</html>`);

  return zip.generateAsync({ type: 'base64' });
}

async function testManifestAttributesCanBeInAnyOrder() {
  const context = loadParserContext();
  const base64 = await makeEpub({
    manifestItem: '<item href="Text/chapter1.html" id="chapter1" media-type="application/xhtml+xml"/>'
  });

  const html = await context.parseEpub(base64);

  assert.match(html, /Readable chapter text/);
}

(async () => {
  await testManifestAttributesCanBeInAnyOrder();
  console.log('epub parser tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
