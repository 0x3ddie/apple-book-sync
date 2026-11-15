import contextlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from progress import apply_position, _open_url


OLD = "epubcfi(/6/12[chapter]!/4/172/1,:0,:1)"
TARGET = "epubcfi(/6/12[chapter]!/4/110/1:313)"
ACTUAL = "epubcfi(/6/12[chapter]!/4/110/1,:0,:1)"
NEW_STAMP = "2026-11-14T23:42:03+00:00"


def position(cfi, revision="old", timestamp="2026-11-14T23:41:03+00:00"):
    return {"cfi": cfi, "revision": revision, "updatedAt": timestamp}


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Library:
    def __init__(self, current=None, *, readable=True):
        self.current = current or position(OLD)
        self.other = position("epubcfi(/6/4!/4/2/1:0)")
        self.available = readable
        self.read_ids = []

    def raw_book(self, identifier):
        if identifier != "book-one":
            raise KeyError("Missing book")
        return {"ZASSETID": identifier}

    def readable(self, raw):
        return self.available, "Unavailable"

    def raw_annotations(self, identifier):
        self.read_ids.append(identifier)
        return self.current

    def apple_position(self, annotations):
        return annotations


class ProgressTest(unittest.TestCase):
    def setUp(self):
        self.library = Library()
        self.clock = Clock()
        self.calls = []

    def run_apply(self, opener, cfi=TARGET, identifier="book-one"):
        def record(url):
            self.calls.append(url)
            return opener(url)
        return apply_position(self.library, identifier, cfi, opener=record,
                              clock=self.clock, sleep=self.clock.sleep)

    def test_fresh_canonicalized_same_text_node_is_verified_and_only_requested_book_read(self):
        expected = position(ACTUAL, "new", NEW_STAMP)
        other_before = self.library.other.copy()
        def open_url(url):
            self.assertIn("%5Bchapter%5D", url)
            self.library.current = expected
            return True
        self.assertEqual(self.run_apply(open_url), expected)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(set(self.library.read_ids), {"book-one"})
        self.assertEqual(self.library.other, other_before)

    def test_exact_already_saved_position_needs_no_app_open(self):
        self.library.current = position(TARGET)
        self.assertEqual(self.run_apply(lambda _: self.fail("Must not open Books")), self.library.current)
        self.assertEqual(self.calls, [])

    def test_normalized_already_saved_endpoint_needs_no_app_open(self):
        self.library.current = position(ACTUAL)
        self.assertEqual(self.run_apply(lambda _: self.fail("Must not open Books"),
                                       cfi="epubcfi(/6/12!/4/110/1:0)"), self.library.current)
        self.assertEqual(self.calls, [])

    def test_stale_same_node_is_not_confirmation(self):
        self.library.current = position(ACTUAL)
        self.assertIsNone(self.run_apply(lambda _: True))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.clock.now, 10)

    def test_fresh_wrong_path_or_spine_does_not_acknowledge(self):
        for actual in ["epubcfi(/6/12!/4/112/1:0)", "epubcfi(/6/14!/4/110/1:0)"]:
            with self.subTest(actual=actual):
                self.library.current = position(OLD)
                def open_url(_):
                    self.library.current = position(actual, "new", NEW_STAMP)
                    return True
                self.assertIsNone(self.run_apply(open_url))

    def test_second_delivery_can_confirm_after_first_closed_reader(self):
        expected = position(ACTUAL, "new", NEW_STAMP)
        def open_url(_):
            if len(self.calls) == 2:
                self.library.current = expected
            return True
        self.assertEqual(self.run_apply(open_url), expected)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.clock.now, 5)

    def test_unavailable_missing_and_failed_open_leave_pending(self):
        self.library.available = False
        self.assertIsNone(self.run_apply(lambda _: self.fail("Unavailable book must not open")))
        self.assertIsNone(self.run_apply(lambda _: self.fail("Unknown book must not open"), identifier="missing"))
        self.library.available = True
        self.assertIsNone(self.run_apply(lambda _: False))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.clock.now, 0)

    def test_invalid_and_out_of_bounds_inputs_never_read_or_open(self):
        malformed = [None, "", "epubcfi()", "epubcfi(/6/12!/4/1:-1)",
                     "epubcfi(/6/13!/4/1:0)", "epubcfi(/6/0!/4/1:0)",
                     "epubcfi(/6/12!/4/1:2147483648)", "epubcfi(/6/12!/4/0:0)",
                     "epubcfi(/6/12[x]!/4/1:0)#other", "epubcfi(/6/12[x!/4/1:0)",
                     "epubcfi(/6/12]!/4/1:0)", "epubcfi(/6/12!/4/1,:4,:0)",
                     "epubcfi(/6/12!/4/1,:0)", "epubcfi(/6/12!/4/1:\n0)"]
        for cfi in malformed:
            with self.subTest(cfi=cfi), self.assertRaises(ValueError):
                self.run_apply(lambda _: self.fail("Must not open"), cfi=cfi)
        for identifier in [None, "", "../../other", "book?command=other"]:
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.run_apply(lambda _: self.fail("Must not open"), identifier=identifier)
        self.assertEqual(self.library.read_ids, [])

    def test_range_start_and_escaped_assertions_compare_correctly(self):
        target = "epubcfi(/6/12[chapter^]one]!/4/110,/1:313,/1:314)"
        expected = position(ACTUAL, "new", NEW_STAMP)
        def open_url(_):
            self.library.current = expected
            return True
        self.assertEqual(self.run_apply(open_url, cfi=target), expected)

    def test_same_node_timestamp_only_change_does_not_confirm_different_offset(self):
        self.library.current = position(ACTUAL, None)
        expected = position(ACTUAL, None, "2026-11-14T23:42:03+00:00")
        def open_url(_):
            self.library.current = expected
            return True
        self.assertIsNone(self.run_apply(open_url))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.clock.now, 10)

    def test_same_node_with_exact_requested_offset_and_fresh_timestamp_is_confirmed(self):
        self.library.current = position(ACTUAL)
        expected = position(TARGET, "new", NEW_STAMP)
        def open_url(_):
            self.library.current = expected
            return True
        self.assertEqual(self.run_apply(open_url), expected)
        self.assertEqual(len(self.calls), 1)

    def test_changed_revision_with_older_or_unchanged_timestamp_is_not_fresh(self):
        for stamp in ["2026-11-14T23:40:03+00:00", "2026-11-14T23:41:03+00:00"]:
            with self.subTest(stamp=stamp):
                self.library.current = position(OLD)
                def open_url(_):
                    self.library.current = position(ACTUAL, "new", stamp)
                    return True
                self.assertIsNone(self.run_apply(open_url))

    def test_cancellation_prevents_first_dispatch_and_queued_retry(self):
        cancelled = False
        opens = []
        def open_url(url):
            opens.append(url)
            return True
        def sleep(seconds):
            nonlocal cancelled
            self.clock.sleep(seconds)
            cancelled = True
        self.assertIsNone(apply_position(self.library, "book-one", TARGET,
                                        opener=open_url, clock=self.clock, sleep=sleep,
                                        cancelled=lambda: cancelled))
        self.assertEqual(len(opens), 1)
        self.assertEqual(self.clock.now, 0.25)
        self.assertIsNone(apply_position(self.library, "book-one", TARGET,
                                        opener=open_url, cancelled=lambda: True))
        self.assertEqual(len(opens), 1)


class NativeOpenTest(unittest.TestCase):
    def test_background_configuration_callback_and_timeout(self):
        class Configuration:
            @classmethod
            def configuration(cls):
                return cls()
            def setActivates_(self, value):
                self.activates = value
            def setAddsToRecentItems_(self, value):
                self.recents = value

        calls = []
        callbacks = ["success", "error", "timeout"]
        class Workspace:
            @classmethod
            def sharedWorkspace(cls):
                return cls()
            def openURL_configuration_completionHandler_(self, url, config, finish):
                calls.append((url, config.activates, config.recents))
                action = callbacks.pop(0)
                if action == "success":
                    finish(object(), None)
                elif action == "error":
                    finish(None, object())

        modules = {
            "AppKit": SimpleNamespace(NSWorkspace=Workspace, NSWorkspaceOpenConfiguration=Configuration),
            "Foundation": SimpleNamespace(NSURL=SimpleNamespace(URLWithString_=lambda value: value)),
            "objc": SimpleNamespace(autorelease_pool=contextlib.nullcontext),
        }
        with patch.dict(sys.modules, modules):
            self.assertTrue(_open_url("ibooks://assetid/book-one", timeout=0))
            self.assertFalse(_open_url("ibooks://assetid/book-one", timeout=0))
            self.assertFalse(_open_url("ibooks://assetid/book-one", timeout=0))
        self.assertTrue(all(not activates and not recents for _, activates, recents in calls))


if __name__ == "__main__":
    unittest.main()
