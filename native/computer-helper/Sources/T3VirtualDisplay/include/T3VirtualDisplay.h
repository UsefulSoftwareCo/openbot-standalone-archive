#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// Hosts the private `CGVirtualDisplay` classes, which have no public headers.
///
/// Two traps are baked in here rather than left to callers. Each display gets
/// its own serial dispatch queue: sharing one queue across displays makes every
/// display but the last silently fail to come online. And the single mode's
/// dimensions must equal `maxPixelsWide`/`maxPixelsHigh`, or the display is
/// created and never connects.
@interface T3VirtualDisplayHost : NSObject

+ (instancetype)shared;

/// Called on an arbitrary queue when the window server terminates a display we
/// created, so the owner can forget it and tell clients the display list moved.
@property(nonatomic, copy, nullable) void (^onTerminated)(uint32_t displayID);

/// Creates a virtual display. Returns its `CGDirectDisplayID`, or 0 on failure.
- (uint32_t)createDisplayNamed:(NSString *)name
                         width:(uint32_t)width
                        height:(uint32_t)height
                         hiDPI:(BOOL)hiDPI
    NS_SWIFT_NAME(createDisplay(named:width:height:hiDPI:));

/// Releases our reference, which is what disconnects the display.
- (BOOL)destroyDisplay:(uint32_t)displayID NS_SWIFT_NAME(destroyDisplay(_:));

- (void)destroyAllDisplays;

- (NSArray<NSNumber *> *)activeDisplayIDs;

@end

NS_ASSUME_NONNULL_END
