#import "AttachmentException.h"

NSError *IAMCEOCatchException(void (^operation)(void)) {
    @try {
        operation();
        return nil;
    } @catch (NSException *exception) {
        return [NSError errorWithDomain:@"com.iamceo.attachment.exception"
                                  code:1
                              userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: exception.name,
                                         @"exceptionName": exception.name}];
    }
}
