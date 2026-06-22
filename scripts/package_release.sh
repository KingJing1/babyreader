#!/bin/zsh

set -euo pipefail

APP_NAME="BabyReader"

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR}/.."
BUILD_DIR="${ROOT_DIR}/build"
APP_BUNDLE="${BUILD_DIR}/${APP_NAME}.app"
DIST_DIR="${ROOT_DIR}/dist"

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${ROOT_DIR}/native/Info.plist")
MACOS_MIN_VERSION=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "${ROOT_DIR}/native/Info.plist")
ARCHIVE="${DIST_DIR}/${APP_NAME}-v${VERSION}.zip"

BR_SKIP_INSTALL=1 "${SCRIPT_DIR}/build.sh"

BIN_MIN_VERSION=$(otool -l "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}" | awk '/minos/{print $2; exit}')
if [[ "${BIN_MIN_VERSION}" != "${MACOS_MIN_VERSION}" ]]; then
  echo "Binary minimum macOS ${BIN_MIN_VERSION} does not match Info.plist ${MACOS_MIN_VERSION}" >&2
  exit 1
fi

xattr -cr "${APP_BUNDLE}"
codesign --verify --deep --strict "${APP_BUNDLE}"

mkdir -p "${DIST_DIR}"
rm -f "${ARCHIVE}"

ditto -c -k --keepParent --norsrc --noextattr --noqtn "${APP_BUNDLE}" "${ARCHIVE}"

echo "Release archive: ${ARCHIVE}"
