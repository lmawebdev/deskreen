//
// DeskreenVirtualDisplay
//
// Creates a macOS virtual display using the private CoreGraphics
// CGVirtualDisplay API, places it to the right of the current desktop and
// keeps it alive until the process receives SIGTERM/SIGINT.
//
// This helper is spawned by the Electron main process, one instance per
// viewer. Killing the process removes the display.
//
// The API is private and undocumented; the class/selector shape below follows
// the public reverse-engineering work in go-macos/virtualdisplay.
//

#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dispatch/dispatch.h>
#import <errno.h>
#import <signal.h>
#import <unistd.h>

// Private classes. They are resolved at runtime with NSClassFromString; the
// declarations exist only so the compiler emits correctly typed calls.
@interface CGVirtualDisplayDescriptor : NSObject
- (instancetype)init;
- (void)setName:(NSString *)name;
- (void)setMaxPixelsWide:(uint32_t)width;
- (void)setMaxPixelsHigh:(uint32_t)height;
- (void)setSizeInMillimeters:(CGSize)size;
- (void)setSerialNum:(uint32_t)serial;
- (void)setProductID:(uint32_t)productID;
- (void)setVendorID:(uint32_t)vendorID;
- (void)setQueue:(dispatch_queue_t)queue;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(id)settings;
- (uint32_t)displayID;
@end

@interface CGVirtualDisplaySettings : NSObject
- (instancetype)init;
- (void)setModes:(NSArray *)modes;
- (void)setHiDPI:(uint32_t)value;
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(uint32_t)width
                       height:(uint32_t)height
                  refreshRate:(double)refreshRate;
@end

static CGVirtualDisplay *gDisplay = nil;
static dispatch_queue_t gQueue = nil;
static uint32_t gDisplayID = 0;
static NSMutableString *gStdinBuffer = nil;
static NSString *gDisplayName = @"Deskreen Display";
static uint32_t gVendorID = 0x4453;
static uint32_t gProductID = 0x4B52;
static uint32_t gSerial = 1;

static void printJSON(NSDictionary *payload) {
	NSData *data = [NSJSONSerialization dataWithJSONObject:payload
	                                               options:0
	                                                 error:nil];
	if (data == nil) return;
	NSString *line = [[NSString alloc] initWithData:data
	                                       encoding:NSUTF8StringEncoding];
	if (line != nil) {
		printf("%s\n", [line UTF8String]);
		fflush(stdout);
	}
}

static void fail(NSString *message) {
	fprintf(stderr, "%s\n", [message UTF8String]);
	fflush(stderr);
}

static void handleSignal(int signalNumber) {
	(void)signalNumber;
	// The process exit is what removes the virtual display. Do not call
	// Objective-C from a signal handler.
	_exit(0);
}

static BOOL classResponds(Class cls, SEL selector) {
	return cls != Nil && [cls instancesRespondToSelector:selector];
}

static BOOL apiAvailable(NSString **reason) {
	Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
	Class displayClass = NSClassFromString(@"CGVirtualDisplay");
	Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
	Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");

	if (descriptorClass == Nil || displayClass == Nil ||
	    settingsClass == Nil || modeClass == Nil) {
		*reason = @"CGVirtualDisplay private classes are not available on this macOS";
		return NO;
	}

	if (!classResponds(displayClass, @selector(initWithDescriptor:)) ||
	    !classResponds(displayClass, @selector(applySettings:)) ||
	    !classResponds(displayClass, @selector(displayID))) {
		*reason = @"CGVirtualDisplay is missing an expected selector";
		return NO;
	}

	if (!classResponds(settingsClass, @selector(setModes:)) ||
	    !classResponds(settingsClass, @selector(setHiDPI:))) {
		*reason = @"CGVirtualDisplaySettings is missing an expected selector";
		return NO;
	}

	if (!classResponds(modeClass,
	                   @selector(initWithWidth:height:refreshRate:))) {
		*reason = @"CGVirtualDisplayMode is missing an expected selector";
		return NO;
	}

	return YES;
}

static uint32_t *activeDisplayIDs(uint32_t *count) {
	uint32_t ids[64];
	uint32_t n = 0;
	CGError error = CGGetActiveDisplayList(64, ids, &n);
	if (error != kCGErrorSuccess || n == 0) {
		*count = 0;
		return NULL;
	}
	uint32_t *copy = (uint32_t *)malloc(sizeof(uint32_t) * n);
	if (copy == NULL) {
		*count = 0;
		return NULL;
	}
	memcpy(copy, ids, sizeof(uint32_t) * n);
	*count = n;
	return copy;
}

static BOOL waitUntilActive(uint32_t displayID) {
	for (int attempt = 0; attempt < 200; attempt += 1) {
		uint32_t count = 0;
		uint32_t *ids = activeDisplayIDs(&count);
		BOOL found = NO;
		for (uint32_t i = 0; i < count; i += 1) {
			if (ids[i] == displayID) {
				found = YES;
				break;
			}
		}
		free(ids);
		if (found) return YES;

		// A process that has run an AppKit loop needs the run loop serviced
		// while the WindowServer brings the display up.
		CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
		usleep(25 * 1000);
	}
	return NO;
}

static void placeToTheRight(uint32_t displayID) {
	CGRect mainBounds = CGDisplayBounds(CGMainDisplayID());
	CGFloat rightmost = mainBounds.origin.x + mainBounds.size.width;

	uint32_t count = 0;
	uint32_t *ids = activeDisplayIDs(&count);
	for (uint32_t i = 0; i < count; i += 1) {
		if (ids[i] == displayID) continue;
		CGRect bounds = CGDisplayBounds(ids[i]);
		CGFloat edge = bounds.origin.x + bounds.size.width;
		if (edge > rightmost) rightmost = edge;
	}
	free(ids);

	CGDisplayConfigRef config = NULL;
	CGError begin = CGBeginDisplayConfiguration(&config);
	if (begin != kCGErrorSuccess || config == NULL) {
		fail(@"CGBeginDisplayConfiguration failed");
		return;
	}

	CGError originError = CGConfigureDisplayOrigin(
		config, displayID, (int32_t)llround(rightmost),
		(int32_t)llround(mainBounds.origin.y));
	if (originError != kCGErrorSuccess) {
		fail(@"CGConfigureDisplayOrigin failed");
	}

	CGError complete =
		CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
	if (complete != kCGErrorSuccess) {
		fail(@"CGCompleteDisplayConfiguration failed");
	}
}

static BOOL createVirtualDisplay(uint32_t width, uint32_t height,
                                 uint32_t serial) {
	Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
	Class displayClass = NSClassFromString(@"CGVirtualDisplay");
	Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
	Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
	if (descriptorClass == Nil || displayClass == Nil ||
	    settingsClass == Nil || modeClass == Nil) {
		fail(@"CGVirtualDisplay classes are unavailable");
		return NO;
	}

	CGVirtualDisplayDescriptor *descriptor =
		(CGVirtualDisplayDescriptor *)[[descriptorClass alloc] init];
	[descriptor setName:gDisplayName];
	uint32_t maxPixels = width > height ? width : height;
	[descriptor setMaxPixelsWide:maxPixels];
	[descriptor setMaxPixelsHigh:maxPixels];
	[descriptor setSizeInMillimeters:CGSizeMake(
		(CGFloat)width * 25.4 / 96.0,
		(CGFloat)height * 25.4 / 96.0)];
	[descriptor setVendorID:gVendorID];
	[descriptor setProductID:gProductID];
	[descriptor setSerialNum:serial];
	[descriptor setQueue:gQueue];

	CGVirtualDisplay *display =
		(CGVirtualDisplay *)[[displayClass alloc] initWithDescriptor:descriptor];
	if (display == nil) {
		fail(@"CGVirtualDisplay could not be created");
		return NO;
	}

	CGVirtualDisplaySettings *settings =
		(CGVirtualDisplaySettings *)[[settingsClass alloc] init];
	CGVirtualDisplayMode *mode =
		(CGVirtualDisplayMode *)[[modeClass alloc] initWithWidth:width
		                                              height:height
		                                         refreshRate:60.0];
	[settings setModes:@[ mode ]];
	[settings setHiDPI:0];

	if (![display applySettings:settings]) {
		fail(@"the WindowServer rejected the virtual display settings");
		return NO;
	}

	uint32_t displayID = [display displayID];
	if (!waitUntilActive(displayID)) {
		fail(@"the virtual display never became active");
		return NO;
	}

	gDisplay = display;
	gDisplayID = displayID;
	return YES;
}

static BOOL resizeDisplay(uint32_t width, uint32_t height) {
	if (gDisplayID == 0) return NO;

	uint32_t oldDisplayID = gDisplayID;
	// Releasing the CGVirtualDisplay removes the display. The API does not
	// allow advertising a rotated mode on the same virtual display, so the
	// rotation is implemented by recreating it with the new orientation.
	gDisplay = nil;
	gDisplayID = 0;

	// Removal is asynchronous; wait until the old display is gone so the new
	// one does not end up placed to the right of a stale display.
	for (int attempt = 0; attempt < 160; attempt += 1) {
		BOOL stillPresent = NO;
		uint32_t count = 0;
		uint32_t *ids = activeDisplayIDs(&count);
		for (uint32_t i = 0; i < count; i += 1) {
			if (ids[i] == oldDisplayID) {
				stillPresent = YES;
				break;
			}
		}
		free(ids);
		if (!stillPresent) break;
		CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
		usleep(25 * 1000);
	}

	gSerial += 1;
	if (!createVirtualDisplay(width, height, gSerial)) {
		printJSON(@{
			@"event" : @"resize-error",
			@"message" : @"could not recreate the virtual display"
		});
		return NO;
	}

	placeToTheRight(gDisplayID);

	CGRect bounds = CGDisplayBounds(gDisplayID);
	printJSON(@{
		@"event" : @"resized",
		@"displayID" : @(gDisplayID),
		@"width" : @(width),
		@"height" : @(height),
		@"x" : @(bounds.origin.x),
		@"y" : @(bounds.origin.y),
		@"boundsWidth" : @(bounds.size.width),
		@"boundsHeight" : @(bounds.size.height),
	});
	return YES;
}

static void handleStdinLine(NSString *line) {
	NSString *trimmed = [line
		stringByTrimmingCharactersInSet:[NSCharacterSet
		                                  whitespaceAndNewlineCharacterSet]];
	if (trimmed.length == 0) return;

	NSData *data = [trimmed dataUsingEncoding:NSUTF8StringEncoding];
	if (data == nil) return;
	NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:data
	                                                       options:0
	                                                         error:nil];
	if (![payload isKindOfClass:[NSDictionary class]]) return;

	NSString *command = payload[@"command"];
	if (![command isEqualToString:@"resize"]) return;

	uint32_t width = (uint32_t)[payload[@"width"] integerValue];
	uint32_t height = (uint32_t)[payload[@"height"] integerValue];
	if (width < 64 || height < 64) return;

	resizeDisplay(width, height);
}

int main(int argc, const char *argv[]) {
	@autoreleasepool {
		uint32_t width = 1280;
		uint32_t height = 800;
		uint32_t serial = 1;
		uint32_t vendor = 0x4453;  // "DS"
		uint32_t product = 0x4B52; // "KR"
		NSString *name = @"Deskreen Display 1";
		int parentPid = 0;

		for (int i = 1; i < argc; i += 1) {
			NSString *arg = [NSString stringWithUTF8String:argv[i]];
			NSString *next = (i + 1 < argc)
				? [NSString stringWithUTF8String:argv[i + 1]]
				: nil;

			if ([arg isEqualToString:@"--width"] && next != nil) {
				width = (uint32_t)next.integerValue;
				i += 1;
			} else if ([arg isEqualToString:@"--height"] && next != nil) {
				height = (uint32_t)next.integerValue;
				i += 1;
			} else if ([arg isEqualToString:@"--name"] && next != nil) {
				name = next;
				i += 1;
			} else if ([arg isEqualToString:@"--serial"] && next != nil) {
				serial = (uint32_t)next.integerValue;
				i += 1;
			} else if ([arg isEqualToString:@"--vendor"] && next != nil) {
				vendor = (uint32_t)next.integerValue;
				i += 1;
			} else if ([arg isEqualToString:@"--product"] && next != nil) {
				product = (uint32_t)next.integerValue;
				i += 1;
			} else if ([arg isEqualToString:@"--parent-pid"] && next != nil) {
				parentPid = (int)next.integerValue;
				i += 1;
			}
		}

		if (width < 64 || height < 64) {
			fail(@"width and height must be at least 64");
			return 2;
		}

		NSString *reason = nil;
		if (!apiAvailable(&reason)) {
			fail(reason);
			return 3;
		}

		gDisplayName = name;
		gVendorID = vendor;
		gProductID = product;
		gSerial = serial;

		gQueue = dispatch_queue_create("com.deskreen.virtualdisplay",
		                               DISPATCH_QUEUE_SERIAL);

		if (!createVirtualDisplay(width, height, serial)) {
			return 4;
		}

		uint32_t displayID = gDisplayID;
		placeToTheRight(displayID);

		CGRect bounds = CGDisplayBounds(displayID);
		printJSON(@{
			@"event" : @"ready",
			@"displayID" : @(displayID),
			@"name" : name,
			@"width" : @(width),
			@"height" : @(height),
			@"x" : @(bounds.origin.x),
			@"y" : @(bounds.origin.y),
			@"boundsWidth" : @(bounds.size.width),
			@"boundsHeight" : @(bounds.size.height),
		});

		signal(SIGTERM, handleSignal);
		signal(SIGINT, handleSignal);

		gStdinBuffer = [NSMutableString string];
		NSFileHandle *stdinHandle = [NSFileHandle fileHandleWithStandardInput];
		stdinHandle.readabilityHandler = ^(NSFileHandle *handle) {
			NSData *data = handle.availableData;
			if (data.length == 0) return;
			NSString *chunk = [[NSString alloc] initWithData:data
			                                        encoding:NSUTF8StringEncoding];
			if (chunk == nil) return;
			dispatch_async(dispatch_get_main_queue(), ^{
				[gStdinBuffer appendString:chunk];
				NSRange newline;
				while ((newline = [gStdinBuffer rangeOfString:@"\n"]).location !=
				       NSNotFound) {
					NSString *line = [gStdinBuffer
						substringToIndex:newline.location];
					[gStdinBuffer
						deleteCharactersInRange:NSMakeRange(0,
						                                    newline.location + 1)];
					handleStdinLine(line);
				}
			});
		};

		if (parentPid > 0) {
			[NSTimer scheduledTimerWithTimeInterval:2.0
			                               repeats:YES
			                                 block:^(NSTimer *timer) {
				                               (void)timer;
				                               if (kill((pid_t)parentPid, 0) != 0 &&
				                                   errno == ESRCH) {
					                               _exit(0);
				                               }
			                                 }];
		}

		// Keep the process (and therefore the display) alive.
		[[NSRunLoop currentRunLoop] run];
	}
	return 0;
}
