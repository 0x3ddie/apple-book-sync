import asyncio
import copy
import io
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from unittest.mock import Mock

from companion import CompanionError
from position_sync import PositionSync


NOW = datetime(2026, 11, 14, tzinfo=timezone.utc).timestamp()


def stamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def item(book_id="BOOK1", revision=1, age=10, cfi="epubcfi(/6/2!/4/110/1:313)"):
    return {"bookId": book_id, "position": {
        "revision": revision, "cfi": cfi, "savedAt": stamp(NOW - age),
    }, "syncState": "pending"}


def actual():
    return {"cfi": "epubcfi(/6/2!/4/110/1,:0,:1)", "revision": "apple-readback", "updatedAt": stamp(NOW)}


class PositionSyncTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = NOW
        self.pending = [item()]
        self.posts = []
        self.library = Mock()
        self.apply = Mock(return_value=actual())
        self.client = Mock()
        self.client.request.side_effect = self.request
        self.sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply, clock=lambda: self.now)
        self.enterContext(redirect_stdout(io.StringIO()))

    def request(self, method, endpoint, payload=None):
        if method == "GET":
            self.assertEqual(endpoint, "/api/companion/positions")
            return {"positions": copy.deepcopy(self.pending)}
        self.posts.append((endpoint, payload))
        return {"ok": True, "revision": payload["revision"]}

    async def test_verified_readback_is_acknowledged_against_exact_web_revision_and_target(self):
        await self.sync.poll()
        self.apply.assert_called_once()
        self.assertEqual(self.apply.call_args.args, (self.library, "BOOK1", item()["position"]["cfi"]))
        self.assertFalse(self.apply.call_args.kwargs["cancelled"]())
        self.assertEqual(self.posts, [("/api/companion/positions/BOOK1/applied", {
            "revision": 1, "cfi": item()["position"]["cfi"], "applePosition": actual(),
        })])
        self.assertEqual(self.sync.receipts, {})

    async def test_active_reading_is_debounced_and_only_three_newest_eligible_books_are_applied(self):
        self.pending = [item("old", age=50), item("new", age=10), item("middle", age=20), item("fourth", age=30), item("active", age=2)]
        await self.sync.poll()
        self.assertEqual([call.args[1] for call in self.apply.call_args_list], ["new", "middle", "fourth"])
        self.assertEqual(len(self.posts), 3)

    async def test_unverified_apply_backs_off_but_a_new_revision_is_immediately_eligible(self):
        self.apply.return_value = None
        await self.sync.poll()
        self.now += 59
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 1)
        self.pending = [item(revision=2)]
        self.apply.return_value = actual()
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 2)
        self.assertEqual(self.posts[0][1]["revision"], 2)

    async def test_failed_apply_retries_after_sixty_seconds_without_acknowledging_failure(self):
        self.apply.side_effect = ValueError("No usable CFI")
        await self.sync.poll()
        self.now += 60
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 2)
        self.assertEqual(self.posts, [])

    async def test_failed_ack_keeps_verified_receipt_and_retries_without_reopening_books(self):
        attempts = 0

        def request(method, endpoint, payload=None):
            nonlocal attempts
            if method == "POST":
                attempts += 1
                if attempts == 1:
                    raise CompanionError("Network unavailable")
            return self.request(method, endpoint, payload)

        self.client.request.side_effect = request
        with self.assertRaises(CompanionError):
            await self.sync.poll()
        self.assertEqual(len(self.sync.receipts), 1)
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 1)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.sync.receipts, {})

    async def test_newer_pending_revision_discards_an_old_receipt(self):
        def request(method, endpoint, payload=None):
            if method == "POST":
                raise CompanionError("Network unavailable")
            return self.request(method, endpoint, payload)

        self.client.request.side_effect = request
        with self.assertRaises(CompanionError):
            await self.sync.poll()
        self.pending = [item(revision=2)]
        self.client.request.side_effect = self.request
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 2)
        self.assertEqual(self.posts[0][1]["revision"], 2)

    async def test_stale_ack_is_discarded_and_does_not_block_a_newer_revision(self):
        def request(method, endpoint, payload=None):
            if method == "POST":
                raise CompanionError("Newer position", status=409)
            return self.request(method, endpoint, payload)

        self.client.request.side_effect = request
        await self.sync.poll()
        self.assertEqual(self.sync.receipts, {})
        self.pending = [item(revision=2)]
        self.client.request.side_effect = self.request
        await self.sync.poll()
        self.assertEqual(self.posts[0][1]["revision"], 2)

    async def test_revocation_propagates_before_any_native_apply(self):
        for status in (401, 403):
            self.client.request.side_effect = CompanionError("Revoked", status=status)
            with self.assertRaises(CompanionError) as caught:
                await self.sync.poll()
            self.assertEqual(caught.exception.status, status)
        self.apply.assert_not_called()

    async def test_revocation_between_books_prevents_the_next_native_apply(self):
        self.pending = [item("first", age=10), item("second", age=20)]
        reads = 0

        def request(method, endpoint, payload=None):
            nonlocal reads
            if method == "GET":
                reads += 1
                if reads > 1:
                    raise CompanionError("Revoked", status=401)
            return self.request(method, endpoint, payload)

        self.client.request.side_effect = request
        with self.assertRaises(CompanionError):
            await self.sync.poll()
        self.assertEqual(self.apply.call_count, 1)

    async def test_clear_prevents_queued_apply_and_ack_even_when_the_worker_finishes_later(self):
        self.pending = [item("first", age=10), item("second", age=20)]

        def apply(*args, cancelled):
            self.sync.clear()
            self.assertTrue(cancelled())
            return actual()

        self.apply.side_effect = apply
        await self.sync.poll()
        self.assertEqual(self.apply.call_count, 1)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.sync.receipts, {})
        calls = self.client.request.call_count
        await self.sync.poll()
        self.assertEqual(self.client.request.call_count, calls)

    async def test_malformed_pending_data_is_rejected_before_any_native_apply(self):
        bad = [
            {"bookId": "../private"}, {"position": {**item()["position"], "revision": True}},
            {"position": {**item()["position"], "revision": 0}},
            {"position": {**item()["position"], "cfi": "https://example.test"}},
            {"position": {**item()["position"], "savedAt": "2026-11-14"}},
            {"position": {**item()["position"], "applied": {"deviceId": "this-mac"}}},
        ]
        for patch in bad:
            self.pending = [item() | patch]
            with self.assertRaises(CompanionError):
                await self.sync.poll()
        self.apply.assert_not_called()

    async def test_an_applied_marker_only_suppresses_this_mac_not_a_replacement(self):
        self.pending[0]["position"]["applied"] = {"deviceId": "this-mac", "at": stamp(NOW), "applePosition": actual()}
        await self.sync.poll()
        self.apply.assert_not_called()
        self.pending[0]["position"]["applied"]["deviceId"] = "previous-mac"
        await self.sync.poll()
        self.apply.assert_called_once()

    async def test_native_readback_runs_off_the_event_loop(self):
        entered, release = threading.Event(), threading.Event()
        main_thread = threading.get_ident()

        def apply(*args, **kwargs):
            self.assertNotEqual(threading.get_ident(), main_thread)
            entered.set()
            release.wait(3)
            return actual()

        self.apply.side_effect = apply
        task = asyncio.create_task(self.sync.poll())
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            self.assertFalse(task.done())
        finally:
            release.set()
            await task


if __name__ == "__main__":
    unittest.main()
