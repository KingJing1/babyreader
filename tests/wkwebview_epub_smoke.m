@import Cocoa;
@import WebKit;

@interface BRTestRunner : NSObject <WKNavigationDelegate, WKScriptMessageHandler>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (copy) NSString *scriptPath;
@property (assign) BOOL finished;
@property (assign) int exitCode;
@property (strong) NSMutableArray *nativeMessages;
@end

@implementation BRTestRunner

- (instancetype)initWithRoot:(NSString *)root scriptPath:(NSString *)scriptPath {
  self = [super init];
  if (!self) return nil;

  _scriptPath = scriptPath;
  _nativeMessages = [NSMutableArray array];
  _exitCode = 1;

  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  WKWebpagePreferences *pagePrefs = [[WKWebpagePreferences alloc] init];
  pagePrefs.allowsContentJavaScript = YES;
  config.defaultWebpagePreferences = pagePrefs;

  WKUserContentController *ucc = [[WKUserContentController alloc] init];
  [ucc addScriptMessageHandler:self name:@"native"];
  [ucc addScriptMessageHandler:self name:@"testResult"];
  config.userContentController = ucc;

  _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1180, 860)
                                       styleMask:NSWindowStyleMaskTitled
                                         backing:NSBackingStoreBuffered
                                           defer:NO];
  _webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1180, 860)
                                configuration:config];
  _webView.navigationDelegate = self;
  _webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [_window.contentView addSubview:_webView];
  [_window orderFront:nil];

  NSString *indexPath = [root stringByAppendingPathComponent:@"web/index.html"];
  NSString *webPath = [root stringByAppendingPathComponent:@"web"];
  NSURL *indexURL = [NSURL fileURLWithPath:indexPath];
  NSURL *webURL = [NSURL fileURLWithPath:webPath isDirectory:YES];
  [_webView loadFileURL:indexURL allowingReadAccessToURL:webURL];

  return self;
}

- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message {
  if ([message.name isEqualToString:@"testResult"]) {
    [self finishWithObject:message.body ?: @{}];
    return;
  }

  if ([message.body isKindOfClass:[NSDictionary class]]) {
    [self.nativeMessages addObject:message.body];
  }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  NSError *readError = nil;
  NSString *script = [NSString stringWithContentsOfFile:self.scriptPath
                                               encoding:NSUTF8StringEncoding
                                                  error:&readError];
  if (!script) {
    [self finishWithObject:@{@"ok": @NO, @"error": readError.localizedDescription ?: @"Cannot read test script"}];
    return;
  }

  NSString *wrapped = [NSString stringWithFormat:
    @"void (async function(){ try { const result = await (%@); window.webkit.messageHandlers.testResult.postMessage(result || {}); } catch (error) { window.webkit.messageHandlers.testResult.postMessage({ ok: false, error: String(error && (error.stack || error.message || error)) }); } })();",
    script];

  [webView evaluateJavaScript:wrapped completionHandler:^(id result, NSError *error) {
    if (error) {
      [self finishWithObject:@{
        @"ok": @NO,
        @"error": error.localizedDescription ?: @"WKWebView evaluation failed"
      }];
      return;
    }
  }];
}

- (void)webView:(WKWebView *)webView
 didFailProvisionalNavigation:(WKNavigation *)navigation
      withError:(NSError *)error {
  [self finishWithObject:@{
    @"ok": @NO,
    @"error": [NSString stringWithFormat:@"Provisional navigation failed: %@", error.localizedDescription ?: @"unknown"]
  }];
}

- (void)webView:(WKWebView *)webView
 didFailNavigation:(WKNavigation *)navigation
      withError:(NSError *)error {
  [self finishWithObject:@{
    @"ok": @NO,
    @"error": [NSString stringWithFormat:@"Navigation failed: %@", error.localizedDescription ?: @"unknown"]
  }];
}

- (void)finishWithObject:(id)object {
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  if ([object isKindOfClass:[NSDictionary class]]) {
    [payload addEntriesFromDictionary:object];
  } else {
    payload[@"result"] = object ?: [NSNull null];
  }
  payload[@"nativeMessages"] = self.nativeMessages;

  NSError *jsonError = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:payload
                                                 options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                   error:&jsonError];
  if (json) {
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    fprintf(stdout, "%s\n", text.UTF8String);
  } else {
    fprintf(stderr, "%s\n", (jsonError.localizedDescription ?: @"JSON serialization failed").UTF8String);
  }

  NSNumber *ok = [payload[@"ok"] isKindOfClass:[NSNumber class]] ? payload[@"ok"] : @NO;
  self.exitCode = ok.boolValue ? 0 : 1;
  self.finished = YES;
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "Usage: wkwebview_epub_smoke <repo-root> <test-js>\n");
      return 2;
    }

    NSString *root = [NSString stringWithUTF8String:argv[1]];
    NSString *testHome = [root stringByAppendingPathComponent:@"build/tests/home"];
    [[NSFileManager defaultManager] createDirectoryAtPath:testHome
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    setenv("HOME", testHome.UTF8String, 1);
    setenv("CFFIXED_USER_HOME", testHome.UTF8String, 1);

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    NSString *script = [NSString stringWithUTF8String:argv[2]];
    BRTestRunner *runner = [[BRTestRunner alloc] initWithRoot:root scriptPath:script];

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:45.0];
    while (!runner.finished && [deadline timeIntervalSinceNow] > 0) {
      @autoreleasepool {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                           untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                                              inMode:NSDefaultRunLoopMode
                                             dequeue:YES];
        if (event) [NSApp sendEvent:event];
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
      }
    }

    if (!runner.finished) {
      fprintf(stderr, "WKWebView EPUB smoke test timed out\n");
      return 1;
    }

    return runner.exitCode;
  }
}
