#!/bin/zsh

set -euo pipefail

APP_NAME="BabyReader"

SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR}/.."
BUILD_DIR="${ROOT_DIR}/build"
APP_BUNDLE="${BUILD_DIR}/${APP_NAME}.app"
DIST_DIR="${ROOT_DIR}/dist"

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${ROOT_DIR}/native/Info.plist")
ARCHIVE="${DIST_DIR}/${APP_NAME}-v${VERSION}.zip"

"${SCRIPT_DIR}/build.sh"

xattr -cr "${APP_BUNDLE}"
codesign --verify --deep --strict "${APP_BUNDLE}"

mkdir -p "${DIST_DIR}"
rm -f "${ARCHIVE}"

ditto -c -k --keepParent --norsrc --noextattr --noqtn "${APP_BUNDLE}" "${ARCHIVE}"

echo "Release archive: ${ARCHIVE}"
