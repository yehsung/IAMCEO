#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
/// Keep AppKit exceptions inside a synchronous Objective-C boundary.
FOUNDATION_EXPORT NSError * _Nullable IAMCEOCatchException(NS_NOESCAPE void (^operation)(void));
NS_ASSUME_NONNULL_END
