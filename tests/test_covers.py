import base64
import concurrent.futures
import json
import struct
import sys
import unittest
import zlib
from types import SimpleNamespace
from unittest.mock import Mock, patch

from covers import MAX_COVER_BYTES, MAX_SOURCE_BYTES, cover_bundle, jpeg_thumbnail


def png_image(width, height):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\x99\x33\x11" * width) * height))
            + chunk(b"IEND", b""))


class CoverBundleTest(unittest.TestCase):
    def test_missing_invalid_and_present_covers_keep_requested_order_and_ids(self):
        library = SimpleNamespace(cover=Mock(side_effect=[(b"source", "image/png"), KeyError("missing"),
                                                         ValueError("dataless"), (b"bad", "image/png")]))
        jpeg = b"\xff\xd8\xfffixture"
        with patch("covers.jpeg_thumbnail", side_effect=[jpeg, ValueError("Invalid cover")]):
            bundle = json.loads(cover_bundle(library, ["one", "missing", "cloud", "invalid"]))
        self.assertEqual(bundle, {"version": 1, "covers": [
            {"id": "one", "mime": "image/jpeg", "data": base64.b64encode(jpeg).decode()},
            *[{"id": value, "mime": None, "data": None} for value in ("missing", "cloud", "invalid")],
        ]})
        self.assertTrue(all(call.kwargs == {"max_size": MAX_SOURCE_BYTES} for call in library.cover.call_args_list))

    def test_bundle_budget_retains_every_requested_record(self):
        library = SimpleNamespace(cover=Mock(return_value=(b"source", "image/jpeg")))
        ids = [str(index) for index in range(10)]
        with patch("covers.jpeg_thumbnail", return_value=b"\xff\xd8\xff" + b"x" * 100), \
             patch("covers.MAX_BUNDLE_BYTES", 800):
            payload = cover_bundle(library, ids)
        self.assertLessEqual(len(payload), 800)
        records = json.loads(payload)["covers"]
        self.assertEqual([record["id"] for record in records], ids)
        self.assertTrue(any(record["data"] for record in records))
        self.assertTrue(any(record["data"] is None for record in records))

    def test_unsupported_or_oversized_sources_rejected_before_codec(self):
        for data, mime in ((b"<svg/>", "image/svg+xml"), (b"", "image/png"),
                           (b"x" * (MAX_SOURCE_BYTES + 1), "image/jpeg")):
            with self.subTest(mime=mime, size=len(data)), self.assertRaises(ValueError):
                jpeg_thumbnail(data, mime)


@unittest.skipUnless(sys.platform == "darwin", "Native Cocoa codec requires macOS")
class NativeCoverTest(unittest.TestCase):
    def test_threaded_codec_produces_bounded_jpeg_for_portrait_and_landscape(self):
        import AppKit
        import Foundation
        import objc

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as worker:
            for width, height in ((800, 1600), (1600, 800), (1, 1)):
                with self.subTest(width=width, height=height):
                    jpeg = worker.submit(jpeg_thumbnail, png_image(width, height), "image/png").result(timeout=10)
                    self.assertTrue(jpeg.startswith(b"\xff\xd8\xff"))
                    self.assertLessEqual(len(jpeg), MAX_COVER_BYTES)
                    with objc.autorelease_pool():
                        decoded = AppKit.NSBitmapImageRep.imageRepWithData_(
                            Foundation.NSData.dataWithBytes_length_(jpeg, len(jpeg)))
                        self.assertIsNotNone(decoded)
                        self.assertLessEqual(decoded.pixelsWide(), min(width, 320))
                        self.assertLessEqual(decoded.pixelsHigh(), min(height, 480))
                        self.assertAlmostEqual(decoded.pixelsWide() / decoded.pixelsHigh(), width / height, places=2)

    def test_invalid_raster_is_rejected(self):
        with self.assertRaises(ValueError):
            jpeg_thumbnail(b"not an image", "image/jpeg")


if __name__ == "__main__":
    unittest.main()
