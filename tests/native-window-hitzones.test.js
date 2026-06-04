#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const nativeSource = fs.readFileSync(path.join(rootDir, 'native/main.m'), 'utf8');

function numberConstant(name) {
  const match = nativeSource.match(new RegExp(`CGFloat\\s+${name}\\s*=\\s*([0-9.]+);`));
  assert.ok(match, `Missing CGFloat constant ${name}`);
  return Number(match[1]);
}

const topbarHeight = numberConstant('topbarHeight');
const rightControlsWidth = numberConstant('rightControlsWidth');
const leftControlsEnd = numberConstant('leftControlsEnd');

assert.doesNotMatch(
  nativeSource,
  /CGFloat\s+leftControlsStart\s*=/,
  'Left hit zone must include the macOS traffic-light controls, not start after them'
);
assert.match(
  nativeSource,
  /BOOL\s+isLeftControl\s*=\s*point\.x\s*<=\s*leftControlsEnd;/,
  'Left hit zone must protect the traffic-light controls plus the TOC button'
);

function shouldDrag({ width = 1000, height = 700, x, y }) {
  const isTopbar = x >= 0 && x <= width && y >= height - topbarHeight;
  const isRightControl = x >= width - rightControlsWidth;
  const isLeftControl = x <= leftControlsEnd;
  return isTopbar && !(isRightControl || isLeftControl);
}

assert.equal(
  shouldDrag({ x: 20, y: 680 }),
  false,
  'macOS close/minimize/zoom buttons must not be swallowed by window dragging'
);
assert.equal(
  shouldDrag({ x: 76, y: 680 }),
  false,
  'left-side TOC toggle must remain clickable'
);
assert.equal(
  shouldDrag({ x: 150, y: 680 }),
  true,
  'empty topbar space should still drag the window'
);
assert.equal(
  shouldDrag({ x: 930, y: 680 }),
  false,
  'right-side web controls must remain clickable'
);
assert.equal(
  shouldDrag({ x: 150, y: 620 }),
  false,
  'content below the topbar must not drag the window'
);

console.log('native window hit-zone tests passed');
