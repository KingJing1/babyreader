#!/bin/zsh

set -e

APP_NAME="BabyReader"

# Determine root directory relative to this script's location
SCRIPT_DIR="${0:A:h}"
ROOT_DIR="${SCRIPT_DIR}/.."

BUILD_DIR="${ROOT_DIR}/build"
APP_BUNDLE="${BUILD_DIR}/${APP_NAME}.app"
CONTENTS="${APP_BUNDLE}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES_WEB="${CONTENTS}/Resources/web"
RESOURCES_WEB_LIB="${RESOURCES_WEB}/lib"

echo "Building ${APP_NAME}..."

# Always start from a clean build directory to prevent asset drift
rm -rf "${BUILD_DIR}"

# Create .app bundle structure
mkdir -p "${MACOS}"
mkdir -p "${RESOURCES_WEB}"
mkdir -p "${RESOURCES_WEB_LIB}"

# Copy Info.plist
cp "${ROOT_DIR}/native/Info.plist" "${CONTENTS}/Info.plist"

# Copy web files
cp "${ROOT_DIR}/web/index.html"  "${RESOURCES_WEB}/index.html"
cp "${ROOT_DIR}/web/styles.css"  "${RESOURCES_WEB}/styles.css"
cp "${ROOT_DIR}/web/app.js"      "${RESOURCES_WEB}/app.js"

# Copy marked.min.js
cp "${ROOT_DIR}/web/lib/marked.min.js" "${RESOURCES_WEB_LIB}/marked.min.js"
cp "${ROOT_DIR}/web/lib/jszip.min.js"  "${RESOURCES_WEB_LIB}/jszip.min.js"
cp "${ROOT_DIR}/web/lib/epub.min.js"   "${RESOURCES_WEB_LIB}/epub.min.js"

# Copy web assets (cat logo, etc.)
if [ -d "${ROOT_DIR}/web/assets" ]; then
    cp -R "${ROOT_DIR}/web/assets" "${RESOURCES_WEB}/assets"
fi

# Copy app icon
if [ -f "${ROOT_DIR}/native/AppIcon.icns" ]; then
    cp "${ROOT_DIR}/native/AppIcon.icns" "${CONTENTS}/Resources/AppIcon.icns"
fi

# Compile native/main.m
clang \
    -fmodules \
    -fobjc-arc \
    -framework Cocoa \
    -framework WebKit \
    -framework CoreServices \
    "${ROOT_DIR}/native/main.m" \
    -o "${MACOS}/${APP_NAME}"

# Ensure binary is executable
chmod +x "${MACOS}/${APP_NAME}"

# Remove quarantine and ad-hoc sign so macOS Gatekeeper doesn't block it
xattr -cr "${APP_BUNDLE}"
codesign --force --deep --sign - "${APP_BUNDLE}" 2>/dev/null

# Install to ~/Applications for proper macOS integration
INSTALL_DIR="${HOME}/Applications"
mkdir -p "${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null
cp -R "${APP_BUNDLE}" "${INSTALL_DIR}/${APP_NAME}.app"
xattr -cr "${INSTALL_DIR}/${APP_NAME}.app"
codesign --force --deep --sign - "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null

# Register with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null

echo "Done. Installed: ${INSTALL_DIR}/${APP_NAME}.app"
