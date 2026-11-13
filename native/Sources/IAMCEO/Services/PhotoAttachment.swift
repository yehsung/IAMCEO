import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Only instances created here own temporary files. Never removes a picker/provider or user-selected URL.
final class PhotoAttachmentFile: Sendable {
    let url: URL
    private let directory: URL

    private init(filename: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-photo-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        url = directory.appendingPathComponent(filename)
    }

    static func copy(from source: URL, filename: String) throws -> PhotoAttachmentFile {
        let file = try PhotoAttachmentFile(filename: filename)
        try FileManager.default.copyItem(at: source, to: file.url)
        return file
    }

    static func write(_ data: Data, filename: String) throws -> PhotoAttachmentFile {
        let file = try PhotoAttachmentFile(filename: filename)
        try data.write(to: file.url, options: .atomic)
        return file
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: url)
        // Do not recursively remove anything another owner might have placed in the directory.
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: directory.path), contents.isEmpty {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    deinit { cleanup() }
}

enum PhotoAttachmentError: LocalizedError {
    case invalidImage, encodingFailed, tooLarge, unavailable

    var errorDescription: String? {
        switch self {
        case .invalidImage: String(localized: "사진을 읽을 수 없습니다")
        case .encodingFailed: String(localized: "사진을 변환하지 못했습니다")
        case .tooLarge: String(localized: "파일은 50MB까지 올릴 수 있습니다")
        case .unavailable: String(localized: "사진 또는 동영상을 불러오지 못했습니다")
        }
    }
}

enum PhotoAttachment {
    static let maximumBytes = 50 * 1024 * 1024
    static let maximumDimension = 4096

    static func validateSize(_ url: URL) throws {
        // URL resource values may cache an earlier size (e.g. while a provider finishes writing).
        guard let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber else {
            throw PhotoAttachmentError.unavailable
        }
        guard size.uint64Value <= UInt64(maximumBytes) else { throw PhotoAttachmentError.tooLarge }
    }

    static func filename(date: Date, index: Int, extension ext: String, video: Bool = false) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "\(video ? String(localized: "동영상") : String(localized: "사진"))-\(formatter.string(from: date))-\(index).\(ext)"
    }

    /// Pixel paste/drop representations follow exactly the same rules as library photos.
    static func prepare(data: Data, date: Date, index: Int) throws -> PhotoAttachmentFile {
        let original = try PhotoAttachmentFile.write(data, filename: "image-data")
        defer { original.cleanup() }
        return try prepare(source: original.url, video: false, date: date, index: index)
    }

    /// Runs off the main actor. Re-encoding starts from pixels, so no EXIF/XMP/GPS metadata is inherited.
    /// Untouched small PNG/JPEG images and all videos retain their original bytes.
    static func prepare(source: URL, video: Bool, date: Date, index: Int,
                        forceJPEG: Bool = false) throws -> PhotoAttachmentFile {
        if video {
            try validateSize(source)
            let file = try PhotoAttachmentFile.copy(from: source,
                filename: filename(date: date, index: index, extension: source.pathExtension.lowercased(), video: true))
            return file
        }
        guard let sourceImage = CGImageSourceCreateWithURL(source as CFURL, nil),
              let sourceType = CGImageSourceGetType(sourceImage),
              let properties = CGImageSourceCopyPropertiesAtIndex(sourceImage, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            throw PhotoAttachmentError.invalidImage
        }
        let type = UTType(sourceType as String)
        let jpeg = forceJPEG || (type != .png && type != .jpeg)
        let outputType: UTType = jpeg ? .jpeg : type == .png ? .png : .jpeg
        let ext = outputType == .png ? "png" : "jpg"
        let name = filename(date: date, index: index, extension: ext)
        let resize = max(width, height) > maximumDimension
        var hasGPS = properties[kCGImagePropertyGPSDictionary] != nil
        if let metadata = CGImageSourceCopyMetadataAtIndex(sourceImage, 0, nil) {
            CGImageMetadataEnumerateTagsUsingBlock(metadata, nil, nil) { path, _ in
                if (path as String).localizedCaseInsensitiveContains("gps") { hasGPS = true }
                return true
            }
        }
        if !jpeg && !resize && !hasGPS {
            try validateSize(source)
            return try PhotoAttachmentFile.copy(from: source, filename: name)
        }
        let image: CGImage?
        var outputProperties: [CFString: Any] = [:]
        if resize {
            image = CGImageSourceCreateThumbnailAtIndex(sourceImage, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
            ] as CFDictionary)
        } else {
            image = CGImageSourceCreateImageAtIndex(sourceImage, 0, nil)
            // Keep orientation without copying any location-bearing metadata.
            outputProperties[kCGImagePropertyOrientation] = properties[kCGImagePropertyOrientation]
        }
        guard let image else { throw PhotoAttachmentError.invalidImage }
        if outputType == .jpeg { outputProperties[kCGImageDestinationLossyCompressionQuality] = 0.85 }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, outputType.identifier as CFString, 1, nil) else {
            throw PhotoAttachmentError.encodingFailed
        }
        CGImageDestinationAddImage(destination, image, outputProperties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw PhotoAttachmentError.encodingFailed }
        // A decoder can expose dimensions but fail to supply pixels (e.g. unavailable HEVC service).
        // ImageIO can then finalize a header-only JPEG successfully. Never upload that invalid result.
        guard let encoded = CGImageSourceCreateWithData(data, nil),
              CGImageSourceCreateImageAtIndex(encoded, 0, nil) != nil else {
            throw PhotoAttachmentError.encodingFailed
        }
        guard data.length <= maximumBytes else { throw PhotoAttachmentError.tooLarge }
        return try PhotoAttachmentFile.write(data as Data, filename: name)
    }
}
