import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import IAMCEO

final class PhotoAttachmentTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_800_000_000)

    private func fixture(type: UTType = .jpeg, width: Int = 32, height: Int = 16,
                         gps: Bool = false, orientation: Int = 1) throws -> PhotoAttachmentFile {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.3, green: 0.6, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        var properties: [CFString: Any] = [kCGImagePropertyOrientation: orientation]
        if gps {
            properties[kCGImagePropertyGPSDictionary] = [
                kCGImagePropertyGPSLatitude: 37.5, kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 127.0, kCGImagePropertyGPSLongitudeRef: "E",
            ]
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return try PhotoAttachmentFile.write(data as Data, filename: "fixture.\(type.preferredFilenameExtension!)")
    }

    private func properties(_ url: URL) throws -> [CFString: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    }

    func testHEICBecomesJPEGWithoutGPS() throws {
        // Synthetic 32x16 solid color, EXIF orientation 6 and dummy GPS. Created with Pillow/libheif.
        // Embedded so the test needs neither a network nor the sandbox-blocked Apple HEIC encoder.
        let data = try XCTUnwrap(Data(base64Encoded: """
        AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAb1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0
        AAAAAAAAAAAAAAAAAAAAADRpbG9jAAAAAERAAAIAAQAAAAAB4QABAAAAAAAAADcAAgAAAAACGAABAAAA
        AAAAAJYAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlm
        AAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAA
        DwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq
        rprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAA
        AABAAAAAQAAAAChjbGFwAAAAIAAAAAEAAAAQAAAAAf///+AAAAAC////0AAAAAIAAAAQcGl4aQAAAAADCAgI
        AAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAGmlyZWYAAAAAAAAADmNkc2MAAgABAAEAAADVbWRhdAAA
        ADMoAa8GMhaHNIkg5b6vH/X/dWf//2z5LNbJ64R+gGPH5LeQkZ70X3sYUuU8dCD0nFO5zYAAAAAG
        RXhpZgAATU0AKgAAAAgAAgESAAMAAAABAAYAAIglAAQAAAABAAAAJgAAAAAABAABAAIAAAACTgAAAAAC
        AAUAAAADAAAAXAADAAIAAAACRQAAAAAEAAUAAAADAAAAdAAAAAAAAAAlAAAAAQAAAB4AAAABAAAAAAAA
        AAEAAAB/AAAAAQAAAAAAAAABAAAAAAAAAAE=
        """, options: .ignoreUnknownCharacters))
        let input = try PhotoAttachmentFile.write(data, filename: "fixture.heic")
        defer { input.cleanup() }
        let originalProperties = try properties(input.url)
        XCTAssertNotNil(originalProperties[kCGImagePropertyGPSDictionary])
        let originalSource = try XCTUnwrap(CGImageSourceCreateWithURL(input.url as CFURL, nil))
        let decoded = CGImageSourceCreateImageAtIndex(originalSource, 0,
            [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        if decoded?.dataProvider?.data == nil {
            XCTAssertThrowsError(try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 1)) { error in
                XCTAssertEqual(error.localizedDescription, "사진을 변환하지 못했습니다")
            }
            throw XCTSkip("HEVC decoder cannot supply pixels in this sandbox; invalid conversion rejection verified")
        }
        let output = try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 1)
        defer { output.cleanup() }
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(output.url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        XCTAssertEqual(output.url.pathExtension, "jpg")
        let props = try properties(output.url)
        XCTAssertNil(props[kCGImagePropertyGPSDictionary])
        // HEIF container transforms are authoritative; ImageIO may already normalize EXIF orientation.
        XCTAssertEqual(props[kCGImagePropertyOrientation] as? Int ?? 1,
                       originalProperties[kCGImagePropertyOrientation] as? Int ?? 1)
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, originalProperties[kCGImagePropertyPixelWidth] as? Int)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, originalProperties[kCGImagePropertyPixelHeight] as? Int)
    }

    func testLargePNGStaysPNGAndCameraForcesJPEG() throws {
        let input = try fixture(type: .png, width: 4097, height: 32, gps: true)
        defer { input.cleanup() }
        for forceJPEG in [false, true] {
            let output = try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 1,
                                                     forceJPEG: forceJPEG)
            defer { output.cleanup() }
            XCTAssertEqual(output.url.pathExtension, forceJPEG ? "jpg" : "png")
            let props = try properties(output.url)
            XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 4096)
            XCTAssertNil(props[kCGImagePropertyGPSDictionary])
        }
    }

    func testLongEdgeIs4096AndOrientationIsApplied() throws {
        let input = try fixture(width: 8192, height: 128, orientation: 6)
        defer { input.cleanup() }
        let output = try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 2)
        defer { output.cleanup() }
        let props = try properties(output.url)
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 64)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 4096)
        XCTAssertEqual(props[kCGImagePropertyOrientation] as? Int ?? 1, 1)
    }

    func testSmallJPEGAndPNGStayByteIdentical() throws {
        for type in [UTType.jpeg, .png] {
            let input = try fixture(type: type)
            defer { input.cleanup() }
            let output = try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 1)
            defer { output.cleanup() }
            XCTAssertEqual(try Data(contentsOf: input.url), try Data(contentsOf: output.url))
        }
    }

    func testGPSIsRemovedFromJPEGAndPNG() throws {
        for type in [UTType.jpeg, .png] {
            let input = try fixture(type: type, gps: true)
            defer { input.cleanup() }
            XCTAssertNotNil(try properties(input.url)[kCGImagePropertyGPSDictionary], "Fixture must contain GPS")
            let output = try PhotoAttachment.prepare(source: input.url, video: false, date: date, index: 1)
            defer { output.cleanup() }
            XCTAssertNil(try properties(output.url)[kCGImagePropertyGPSDictionary])
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(output.url as CFURL, nil))
            XCTAssertEqual(CGImageSourceGetType(source) as String?, type.identifier)
            XCTAssertNotNil(CGImageSourceCreateImageAtIndex(source, 0, nil))
            if let metadata = CGImageSourceCopyMetadataAtIndex(source, 0, nil) {
                CGImageMetadataEnumerateTagsUsingBlock(metadata, nil, nil) { path, _ in
                    XCTAssertFalse((path as String).localizedCaseInsensitiveContains("gps"))
                    return true
                }
            }
        }
    }

    func testReadableFilenameAndUniqueTemporaryOwnership() throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let name = PhotoAttachment.filename(date: date, index: 3, extension: "jpg")
        XCTAssertEqual(name, "사진-\(formatter.string(from: date))-3.jpg")
        XCTAssertNotNil(name.range(of: #"^사진-\d{8}-\d{6}-3\.jpg$"#, options: .regularExpression))
        let first = try PhotoAttachmentFile.write(Data(), filename: name)
        let second = try PhotoAttachmentFile.write(Data(), filename: name)
        defer { first.cleanup(); second.cleanup() }
        XCTAssertNotEqual(first.url, second.url)
        XCTAssertEqual(first.url.lastPathComponent, second.url.lastPathComponent)
    }

    func testVideoBytesAndExtensionArePreserved() throws {
        for ext in ["mov", "mp4"] {
            let data = Data("original movie bytes".utf8)
            let input = try PhotoAttachmentFile.write(data, filename: "fixture.\(ext)")
            defer { input.cleanup() }
            let output = try PhotoAttachment.prepare(source: input.url, video: true, date: date, index: 4)
            defer { output.cleanup() }
            XCTAssertEqual(try Data(contentsOf: output.url), data)
            XCTAssertEqual(output.url.pathExtension, ext)
            XCTAssertTrue(output.url.lastPathComponent.hasPrefix("동영상-"))
        }
    }

    func testFiftyMBAllowedAndLargerVideoRejected() throws {
        let input = try PhotoAttachmentFile.write(Data(), filename: "large.mov")
        defer { input.cleanup() }
        let handle = try FileHandle(forWritingTo: input.url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(PhotoAttachment.maximumBytes))
        XCTAssertNoThrow(try PhotoAttachment.validateSize(input.url))
        try handle.truncate(atOffset: UInt64(PhotoAttachment.maximumBytes + 1))
        XCTAssertThrowsError(try PhotoAttachment.prepare(source: input.url, video: true, date: date, index: 1)) { error in
            XCTAssertEqual(error.localizedDescription, "파일은 50MB까지 올릴 수 있습니다")
        }
    }

    func testTemporaryFilesCleanedAfterSuccessAndFailureWithoutRemovingSource() throws {
        let source = try fixture()
        defer { source.cleanup() }
        var preparedURL: URL?
        func simulateUpload(fails: Bool) throws {
            let prepared = try PhotoAttachment.prepare(source: source.url, video: false, date: date, index: 1)
            preparedURL = prepared.url
            defer { prepared.cleanup() }
            XCTAssertTrue(FileManager.default.fileExists(atPath: prepared.url.path))
            if fails { throw PhotoAttachmentError.unavailable }
        }
        for fails in [false, true] {
            if fails { XCTAssertThrowsError(try simulateUpload(fails: fails)) }
            else { try simulateUpload(fails: fails) }
            let url = try XCTUnwrap(preparedURL)
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: source.url.path))
        }
        // A cancelled/abandoned transfer also releases its owned copy without needing an upload callback.
        var abandoned: PhotoAttachmentFile? = try PhotoAttachmentFile.copy(from: source.url, filename: "abandoned.jpg")
        let url = try XCTUnwrap(abandoned?.url)
        abandoned = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
