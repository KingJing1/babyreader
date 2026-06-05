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
      fprintf(stderr, "Usage: default-handlers-query <expected-bundle-id>\n");
      return 64;
    }

    NSString *expectedBundleID = [NSString stringWithUTF8String:argv[1]];
    for (NSString *contentType in BRDefaultContentTypes()) {
      CFStringRef handler = LSCopyDefaultRoleHandlerForContentType(
        (__bridge CFStringRef)contentType,
        kLSRolesAll
      );
      NSString *actualBundleID = CFBridgingRelease(handler);
      if (![actualBundleID isEqualToString:expectedBundleID]) {
        fprintf(
          stderr,
          "%s default handler is %s, expected %s\n",
          contentType.UTF8String,
          actualBundleID.UTF8String ?: "(none)",
          expectedBundleID.UTF8String
        );
        return 1;
      }
    }

    printf("default document handlers point to %s\n", expectedBundleID.UTF8String);
  }
  return 0;
}
