"""Small library thumbnails prepared locally for direct device transfer."""

import base64
import json
import zipfile
from xml.etree.ElementTree import ParseError


MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_COVER_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_PIXELS = 40_000_000
RASTER_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def jpeg_thumbnail(data, mime):
    """Decode a bounded raster image and draw its first frame onto white."""
    if mime not in RASTER_MIMES or not isinstance(data, bytes) or not 0 < len(data) <= MAX_SOURCE_BYTES:
        raise ValueError("Unsupported or oversized cover image")
    import AppKit
    import Foundation
    import objc

    # Transfer preparation runs in a worker thread, which needs its own pool.
    with objc.autorelease_pool():
        source = AppKit.NSBitmapImageRep.imageRepWithData_(
            Foundation.NSData.dataWithBytes_length_(data, len(data)))
        if source is None:
            raise ValueError("Invalid cover image")
        source_width, source_height = source.pixelsWide(), source.pixelsHigh()
        if source_width <= 0 or source_height <= 0 or source_width * source_height > MAX_SOURCE_PIXELS:
            raise ValueError("Cover image dimensions are too large")
        scale = min(1, 320 / source_width, 480 / source_height)
        width, height = max(1, int(source_width * scale)), max(1, int(source_height * scale))
        target = AppKit.NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
            None, width, height, 8, 4, True, False, AppKit.NSDeviceRGBColorSpace, 0, 0)
        if target is None:
            raise ValueError("Could not create cover thumbnail")
        context = AppKit.NSGraphicsContext.graphicsContextWithBitmapImageRep_(target)
        if context is None:
            raise ValueError("Could not draw cover thumbnail")
        image = AppKit.NSImage.alloc().initWithSize_(AppKit.NSMakeSize(source_width, source_height))
        image.addRepresentation_(source)
        AppKit.NSGraphicsContext.saveGraphicsState()
        try:
            AppKit.NSGraphicsContext.setCurrentContext_(context)
            context.setImageInterpolation_(AppKit.NSImageInterpolationHigh)
            AppKit.NSColor.whiteColor().setFill()
            AppKit.NSRectFill(AppKit.NSMakeRect(0, 0, width, height))
            image.drawInRect_fromRect_operation_fraction_(
                AppKit.NSMakeRect(0, 0, width, height), AppKit.NSZeroRect,
                AppKit.NSCompositingOperationSourceOver, 1.0)
        finally:
            AppKit.NSGraphicsContext.restoreGraphicsState()
        for quality in (0.75, 0.5, 0.3):
            encoded = target.representationUsingType_properties_(
                AppKit.NSBitmapImageFileTypeJPEG, {AppKit.NSImageCompressionFactor: quality})
            if encoded is not None:
                result = bytes(encoded)
                if 0 < len(result) <= MAX_COVER_BYTES and result.startswith(b"\xff\xd8\xff"):
                    return result
        raise ValueError("Cover thumbnail exceeds the transfer limit")


def cover_bundle(library, book_ids):
    """Include exactly the requested IDs without sending paths or EPUB bytes."""
    records = [{"id": book_id, "mime": None, "data": None} for book_id in book_ids]
    # Reserve space for every missing record before adding any image data.
    size = len(json.dumps({"version": 1, "covers": records}, separators=(",", ":")).encode())
    for index, book_id in enumerate(book_ids):
        try:
            source, mime = library.cover(book_id, max_size=MAX_SOURCE_BYTES)
            thumbnail = jpeg_thumbnail(source, mime)
        except (KeyError, ValueError, OSError, RuntimeError, zipfile.BadZipFile, ParseError):
            continue  # Missing, protected, dataless, or invalid covers remain absent.
        record = {"id": book_id, "mime": "image/jpeg", "data": base64.b64encode(thumbnail).decode("ascii")}
        increase = len(json.dumps(record, separators=(",", ":"))) - len(json.dumps(records[index], separators=(",", ":")))
        if size + increase <= MAX_BUNDLE_BYTES:
            records[index] = record
            size += increase
    return json.dumps({"version": 1, "covers": records}, separators=(",", ":")).encode()
