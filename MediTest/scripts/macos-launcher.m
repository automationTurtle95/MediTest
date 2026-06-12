#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <mach-o/dyld.h>
#include <limits.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

@interface MediTestAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate>
@property(nonatomic, copy) NSString *appDirectory;
@property(nonatomic, copy) NSString *appExecutable;
@property(nonatomic) pid_t serverPid;
@property(nonatomic) BOOL terminating;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@end

@implementation MediTestAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
    (void)notification;
    [self startServer];

    NSRect frame = NSMakeRect(0, 0, 1240, 820);
    self.window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:(NSWindowStyleMaskTitled |
                             NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable |
                             NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    self.window.title = @"Meduvalo";
    self.window.minSize = NSMakeSize(920, 640);
    self.window.tabbingMode = NSWindowTabbingModeDisallowed;

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
    self.webView.navigationDelegate = self;
    self.window.contentView = self.webView;
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self loadApplicationPage];
    [self watchServerProcess];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
    (void)sender;
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification
{
    (void)notification;
    self.terminating = YES;
    if (self.serverPid <= 0 || kill(self.serverPid, 0) != 0) return;

    kill(self.serverPid, SIGTERM);
    for (int attempt = 0; attempt < 30; attempt++) {
        if (kill(self.serverPid, 0) != 0) return;
        usleep(100000);
    }
    kill(self.serverPid, SIGKILL);
}

- (void)startServer
{
    self.serverPid = fork();
    if (self.serverPid < 0) {
        [self showFatalError:@"Der Meduvalo-Server konnte nicht gestartet werden."];
        return;
    }
    if (self.serverPid != 0) return;

    if (chdir(self.appDirectory.fileSystemRepresentation) != 0) _exit(126);
    setenv("ASPNETCORE_URLS", "http://127.0.0.1:55000", 1);
    setenv("DOTNET_URLS", "http://127.0.0.1:55000", 1);
    setenv("MEDITEST_NO_BROWSER", "1", 1);
    execl(self.appExecutable.fileSystemRepresentation,
          self.appExecutable.fileSystemRepresentation,
          (char *)NULL);
    _exit(127);
}

- (void)watchServerProcess
{
    pid_t pid = self.serverPid;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        int status = 0;
        waitpid(pid, &status, 0);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.terminating) [NSApp terminate:nil];
        });
    });
}

- (void)loadApplicationPage
{
    if (self.terminating) return;
    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:55000/pages/documents.html"];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url
                                               cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                           timeoutInterval:5.0]];
}

- (void)webView:(WKWebView *)webView
        didFailProvisionalNavigation:(WKNavigation *)navigation
                           withError:(NSError *)error
{
    (void)webView;
    (void)navigation;
    if (self.terminating || error.code == NSURLErrorCancelled) return;
    [self performSelector:@selector(loadApplicationPage) withObject:nil afterDelay:0.5];
}

- (void)showFatalError:(NSString *)message
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Meduvalo konnte nicht gestartet werden";
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleCritical;
    [alert runModal];
    [NSApp terminate:nil];
}

@end

static NSString *ResolveAppDirectory(void)
{
    char executablePath[PATH_MAX];
    uint32_t pathSize = sizeof(executablePath);
    if (_NSGetExecutablePath(executablePath, &pathSize) != 0) return nil;

    char resolvedPath[PATH_MAX];
    if (realpath(executablePath, resolvedPath) == NULL) return nil;

    NSString *launcher = [NSString stringWithUTF8String:resolvedPath];
    NSString *macOSDirectory = [launcher stringByDeletingLastPathComponent];
    return [[[macOSDirectory stringByAppendingPathComponent:@"../Resources/app"]
        stringByStandardizingPath] copy];
}

int main(int argc, const char *argv[])
{
    (void)argc;
    (void)argv;
    @autoreleasepool {
        NSString *appDirectory = ResolveAppDirectory();
        if (appDirectory == nil) {
            fputs("Meduvalo konnte seinen Installationspfad nicht bestimmen.\n", stderr);
            return 1;
        }

        MediTestAppDelegate *delegate = [[MediTestAppDelegate alloc] init];
        delegate.appDirectory = appDirectory;
        delegate.appExecutable = [appDirectory stringByAppendingPathComponent:@"MediTest"];

        NSApplication *application = [NSApplication sharedApplication];
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
