@import Foundation;
@import CoreServices;

static NSArray<NSString *> *BRDefaultContentTypes(void) {
  return @[
    @"net.daringfireball.markdown",
    @"public.plain-text",
    @"org.idpf.epub-container"
  ];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "Usage: register_defaults <bundle-id>\n");
      return 64;
    }

    NSString *bundleID = [NSString stringWithUTF8String:argv[1]];
    if (!bundleID.length) {
      fprintf(stderr, "Missing bundle id\n");
      return 64;
    }

    for (NSString *contentType in BRDefaultContentTypes()) {
      OSStatus status = LSSetDefaultRoleHandlerForContentType(
        (__bridge CFStringRef)contentType,
        kLSRolesAll,
        (__bridge CFStringRef)bundleID
      );
      if (status != noErr) {
        fprintf(stderr, "Failed to register %s: %d\n", contentType.UTF8String, status);
        return 1;
      }
    }

    printf("Registered default handlers for Markdown, TXT, and EPUB.\n");
  }
  return 0;
}
