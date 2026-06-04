#!/bin/zsh

set -e

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR}/.."
BUILD_DIR="${ROOT_DIR}/build/tests"
WK_RUNNER="${BUILD_DIR}/wkwebview_epub_smoke"
CLANG_MODULE_CACHE="${BUILD_DIR}/module-cache"

echo "Checking JavaScript syntax..."
node "${ROOT_DIR}/tests/epub-parser.test.js"
node "${ROOT_DIR}/tests/native-window-hitzones.test.js"
node --check "${ROOT_DIR}/web/app.js"

echo "Building WKWebView EPUB smoke runner..."
mkdir -p "${BUILD_DIR}"
mkdir -p "${CLANG_MODULE_CACHE}"
clang \
  -fmodules \
  -fmodules-cache-path="${CLANG_MODULE_CACHE}" \
  -fobjc-arc \
  -framework Cocoa \
  -framework WebKit \
  "${ROOT_DIR}/tests/wkwebview_epub_smoke.m" \
  -o "${WK_RUNNER}"

echo "Running WKWebView EPUB smoke test..."
"${WK_RUNNER}" "${ROOT_DIR}" "${ROOT_DIR}/tests/wkwebview_markdown_smoke.js"
"${WK_RUNNER}" "${ROOT_DIR}" "${ROOT_DIR}/tests/wkwebview_epub_smoke.js"

echo "Building BabyReader..."
"${ROOT_DIR}/scripts/build.sh"

echo "All tests passed."
