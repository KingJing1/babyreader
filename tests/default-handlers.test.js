#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const files = [
  'native/main.m',
  'scripts/register_defaults.m',
];
const requiredTypes = [
  'net.daringfireball.markdown',
  'public.plain-text',
  'org.idpf.epub-container',
];

for (const file of files) {
  const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
  for (const contentType of requiredTypes) {
    assert.match(
      source,
      new RegExp(contentType.replaceAll('.', '\\.')),
      `${file} must register ${contentType}`
    );
  }
}

const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
assert.match(readme, /\.md`, `\.txt`, and `\.epub`/, 'README must mention all supported default-open formats');

console.log('default handler tests passed');
