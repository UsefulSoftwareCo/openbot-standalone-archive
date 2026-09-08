#import "T3VirtualDisplay.h"
#import <AppKit/AppKit.h>

#pragma mark - Private CoreGraphics interfaces

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(uint32_t)width height:(uint32_t)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic, strong) NSArray *modes;
@property(nonatomic, assign) uint32_t hiDPI;
@property(nonatomic, assign) uint32_t rotation;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, copy) NSString *name;
@property(nonatomic, assign) CGSize sizeInMillimeters;
@property(nonatomic, assign) uint32_t maxPixelsWide;
@property(nonatomic, assign) uint32_t maxPixelsHigh;
@property(nonatomic, assign) uint32_t serialNum;
@property(nonatomic, assign) uint32_t productID;
@property(nonatomic, assign) uint32_t vendorID;
@property(nonatomic, assign) CGPoint redPrimary;
@property(nonatomic, assign) CGPoint greenPrimary;
@property(nonatomic, assign) CGPoint bluePrimary;
@property(nonatomic, assign) CGPoint whitePoint;
@property(nonatomic, copy) void (^terminationHandler)(id a, id b);
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) CGDirectDisplayID displayID;
@end

#pragma mark - Host

@implementation T3VirtualDisplayHost {
    NSMutableDictionary<NSNumber *, CGVirtualDisplay *> *_displays;
    uint32_t _nextSerial;
}

+ (instancetype)shared {
    static T3VirtualDisplayHost *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [[T3VirtualDisplayHost alloc] init]; });
    return shared;
}

- (instancetype)init {
    if ((self = [super init])) {
        _displays = [NSMutableDictionary dictionary];
        _nextSerial = 0x100;
    }
    return self;
}

- (uint32_t)createDisplayNamed:(NSString *)name
                         width:(uint32_t)width
                        height:(uint32_t)height
                         hiDPI:(BOOL)hiDPI {
    uint32_t serial = _nextSerial++;

    CGVirtualDisplayDescriptor *desc = [[CGVirtualDisplayDescriptor alloc] init];
    // Each display needs its own queue; a shared queue starves all but the last.
    desc.queue = dispatch_queue_create(
        [[NSString stringWithFormat:@"codes.t3.openbot.vd.%u", serial] UTF8String],
        DISPATCH_QUEUE_SERIAL);
    desc.name = name;
    desc.maxPixelsWide = width;
    desc.maxPixelsHigh = height;
    desc.sizeInMillimeters = CGSizeMake(width * 0.25, height * 0.25);
    desc.serialNum = serial;
    desc.productID = 0x1200 + serial;
    desc.vendorID = 0xB07D;
    desc.redPrimary   = CGPointMake(0.6400, 0.3300);
    desc.greenPrimary = CGPointMake(0.3000, 0.6000);
    desc.bluePrimary  = CGPointMake(0.1500, 0.0600);
    desc.whitePoint   = CGPointMake(0.3127, 0.3290);

    // Filled in below, after the display exists. The block captures the
    // __block variable by reference, which is the only way the handler can
    // name a display id that does not exist yet when the block is written.
    __block uint32_t createdID = 0;
    __weak T3VirtualDisplayHost *weakSelf = self;
    desc.terminationHandler = ^(id a, id b) {
        T3VirtualDisplayHost *host = weakSelf;
        if (host == nil || createdID == 0) return;
        void (^notify)(uint32_t) = host.onTerminated;
        [host destroyDisplay:createdID];
        if (notify != nil) notify(createdID);
    };

    CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:desc];
    if (!display) return 0;

    CGVirtualDisplaySettings *settings = [[CGVirtualDisplaySettings alloc] init];
    // Mode dimensions must match maxPixels* or the display never comes online.
    settings.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:width
                                                           height:height
                                                      refreshRate:60.0]];
    settings.hiDPI = hiDPI ? 1 : 0;
    settings.rotation = 0;

    if (![display applySettings:settings]) return 0;

    uint32_t displayID = display.displayID;
    if (displayID == 0) return 0;

    createdID = displayID;
    _displays[@(displayID)] = display;
    return displayID;
}

- (BOOL)destroyDisplay:(uint32_t)displayID {
    if (_displays[@(displayID)] == nil) return NO;
    [_displays removeObjectForKey:@(displayID)];
    return YES;
}

- (void)destroyAllDisplays {
    [_displays removeAllObjects];
}

- (NSArray<NSNumber *> *)activeDisplayIDs {
    return _displays.allKeys;
}

@end
