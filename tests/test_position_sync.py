import asyncio
import copy
import io
import json
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

from companion import CompanionError
from position_sync import PositionSync
from progress import deliver_position


NOW = datetime(2026, 11, 14, tzinfo=timezone.utc).timestamp()


def stamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def item(book_id="BOOK1", revision=1, age=10, cfi="epubcfi(/6/2!/4/110/1:313)"):
    return {"bookId": book_id, "position": {
        "revision": revision, "cfi": cfi, "savedAt": stamp(NOW - age),
    }, "syncState": "pending"}


def actual():
    return {"cfi": "epubcfi(/6/2!/4/110/1,:0,:1)", "revision": "apple-readback", "updatedAt": stamp(NOW)}


def delivery(confirmed=True):
    return {"delivered": True, "confirmed": confirmed, "applePosition": actual()}


def sent(attempt=1, baseline=None, age=60):
    result = item()
    result["syncState"] = "sent"
    result["position"]["delivered"] = {"deviceId": "this-mac", "at": stamp(NOW - age),
                                       "applePosition": baseline, "attempt": attempt}
    return result


class PositionSyncTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = NOW
        self.pending = [item()]
        self.posts = []
        self.library = Mock()
        self.apply = Mock(return_value=delivery())
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
        self.apply.return_value = delivery()
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
            return delivery()

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
            return delivery()

        self.apply.side_effect = apply
        task = asyncio.create_task(self.sync.poll())
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            self.assertFalse(task.done())
        finally:
            release.set()
            await task

    async def test_unconfirmed_dispatch_uses_delivered_route_instead_of_claiming_verified_sync(self):
        self.apply.return_value = delivery(confirmed=False)
        await self.sync.poll()
        self.assertEqual(self.posts[0][0], "/api/companion/positions/BOOK1/delivered")
        self.assertEqual(self.posts[0][1]["applePosition"], actual())

    async def test_dispatched_position_without_cfi_can_record_a_null_baseline(self):
        self.apply.return_value = {"delivered": True, "confirmed": False, "applePosition": None}
        await self.sync.poll()
        self.assertEqual(self.posts[0][0], "/api/companion/positions/BOOK1/delivered")
        self.assertIsNone(self.posts[0][1]["applePosition"])

    async def test_real_delivery_helper_recovers_from_ignored_url_and_stops_after_confirmed_retry(self):
        current = {"cfi": "epubcfi(/6/2!/4/2:0)", "revision": "before", "updatedAt": stamp(NOW - 30)}
        self.library.raw_book.return_value = {"ZASSETID": "BOOK1"}
        self.library.readable.return_value = (True, None)
        self.library.apple_position.side_effect = lambda _: current.copy()
        native_time, opens = [0], []

        def opener(url):
            opens.append(url)
            if self.now >= NOW + 60:
                current.update(cfi=item()["position"]["cfi"], revision="confirmed", updatedAt=stamp(self.now))
            return True

        def native_apply(library, book_id, cfi, **kwargs):
            return deliver_position(library, book_id, cfi, opener=opener, clock=lambda: native_time[0],
                                    sleep=lambda seconds: native_time.__setitem__(0, native_time[0] + seconds), **kwargs)

        def request(method, endpoint, payload=None):
            if method == "GET":
                return {"positions": copy.deepcopy(self.pending)}
            self.posts.append((endpoint, payload))
            phase = endpoint.rsplit("/", 1)[1]
            self.pending[0]["position"][phase] = {"deviceId": "this-mac", "at": stamp(self.now),
                "applePosition": payload["applePosition"], **({"attempt": payload["attempt"]} if phase == "delivered" else {})}
            self.pending[0]["syncState"] = "synced" if phase == "applied" else "sent"
            return {"ok": True, "revision": payload["revision"]}

        self.sync.apply = native_apply
        self.client.request.side_effect = request
        await self.sync.poll()
        self.assertEqual(len(opens), 2, "The first bounded native dispatch was accepted but ignored")
        self.assertEqual(self.posts[0][0], "/api/companion/positions/BOOK1/delivered")
        self.assertEqual(self.posts[0][1]["attempt"], 1)
        self.now += 59
        await self.sync.poll()
        self.assertEqual(len(opens), 2)
        self.now += 1
        await self.sync.poll()
        self.assertEqual(len(opens), 3)
        self.assertEqual(self.posts[-1][0], "/api/companion/positions/BOOK1/applied")
        self.assertEqual(current["cfi"], item()["position"]["cfi"])
        self.now += 120
        await self.sync.poll()
        self.assertEqual(len(opens), 3, "A confirmed retry must never reopen the position again")

    async def test_retry_checks_live_native_position_before_reopening(self):
        self.pending = [sent(baseline=actual())]
        self.library.apple_position.return_value = {**actual(), "cfi": "epubcfi(/6/8!/4/2:0)", "updatedAt": stamp(NOW + 1)}
        await self.sync.poll()
        self.apply.assert_not_called()
        self.assertEqual(self.posts, [])
        self.library.apple_position.return_value = actual()
        self.now += 60
        await self.sync.poll()
        self.apply.assert_called_once()

    async def test_retry_with_unknown_baseline_never_rewinds_a_newly_available_native_position(self):
        self.pending = [sent()]
        self.library.apple_position.return_value = actual()
        await self.sync.poll()
        self.apply.assert_not_called()
        self.library.apple_position.return_value = None
        self.now += 60
        await self.sync.poll()
        self.apply.assert_called_once()

    async def test_retry_cap_and_legacy_delivery_attempts(self):
        self.pending = [sent(attempt=3, baseline=actual())]
        self.library.apple_position.return_value = actual()
        await self.sync.poll()
        self.apply.assert_not_called()
        self.pending = [sent(baseline=actual())]
        del self.pending[0]["position"]["delivered"]["attempt"]
        self.apply.return_value = delivery(confirmed=False)
        await self.sync.poll()
        self.assertEqual(self.posts[0][1]["attempt"], 2)

    async def test_retry_receipt_survives_restart_without_opening_again_after_ack_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress-receipts.json"
            self.pending = [sent(baseline=actual())]
            self.library.apple_position.return_value = actual()
            self.apply.return_value = delivery(confirmed=False)
            sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                clock=lambda: self.now, cache_path=path)

            def request(method, endpoint, payload=None):
                if method == "POST":
                    self.assertEqual(payload["attempt"], 2)
                    raise CompanionError("Network unavailable")
                return self.request(method, endpoint, payload)

            self.client.request.side_effect = request
            with self.assertRaises(CompanionError):
                await sync.poll()
            self.assertEqual(json.loads(path.read_text())["receipts"][0]["attempt"], 2)
            restarted = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                     clock=lambda: self.now, cache_path=path)
            # Metadata can report the new native location before the retry ACK
            # succeeds, temporarily removing this revision from the retry list.
            self.pending = []
            self.client.request.side_effect = self.request
            self.library.apple_position.side_effect = AssertionError("A durable receipt must bypass native access")
            await restarted.poll()
            self.assertEqual(self.apply.call_count, 1)
            self.assertEqual(self.posts[0][1]["attempt"], 2)
            self.assertEqual(json.loads(path.read_text())["receipts"], [])

    async def test_absent_target_replays_only_receipt_and_discards_removed_or_stale_targets(self):
        for response_status in (404, 409, 401, 403):
            with self.subTest(status=response_status), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "progress-receipts.json"
                path.write_text(json.dumps({"version": 1, "deviceId": "this-mac", "receipts": [{
                    "bookId": "BOOK1", "revision": 1, "cfi": item()["position"]["cfi"],
                    "phase": "delivered", "attempt": 2, "applePosition": actual(),
                }]}))
                path.chmod(0o600)
                sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                    clock=lambda: self.now, cache_path=path)

                def request(method, endpoint, payload=None):
                    if method == "GET":
                        return {"positions": []}
                    self.assertEqual(payload["attempt"], 2)
                    raise CompanionError("Target unavailable", status=response_status)

                self.client.request.side_effect = request
                if response_status in (401, 403):
                    with self.assertRaises(CompanionError) as caught:
                        await sync.poll()
                    self.assertEqual(caught.exception.status, response_status)
                    self.assertEqual(len(json.loads(path.read_text())["receipts"]), 1)
                else:
                    await sync.poll()
                    self.assertEqual(json.loads(path.read_text())["receipts"], [])
                self.apply.assert_not_called()

    async def test_delivered_marker_for_this_mac_prevents_reopening_without_claiming_applied(self):
        self.pending[0]["position"]["delivered"] = {"deviceId": "this-mac", "at": stamp(NOW), "applePosition": None}
        await self.sync.poll()
        self.apply.assert_not_called()
        self.pending[0]["position"]["delivered"]["deviceId"] = "previous-mac"
        await self.sync.poll()
        self.apply.assert_called_once()

    async def test_durable_receipt_survives_restart_and_is_replayed_without_reopening(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress-receipts.json"
            sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                clock=lambda: self.now, cache_path=path)
            self.apply.return_value = delivery(confirmed=False)

            def request(method, endpoint, payload=None):
                if method == "POST":
                    cached = json.loads(path.read_text())
                    self.assertEqual(cached["receipts"][0]["phase"], "delivered")
                    self.assertEqual(cached["receipts"][0]["revision"], payload["revision"])
                    raise CompanionError("Network unavailable")
                return self.request(method, endpoint, payload)

            self.client.request.side_effect = request
            with self.assertRaises(CompanionError):
                await sync.poll()
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            sync.clear()
            self.assertEqual(len(json.loads(path.read_text())["receipts"]), 1)
            restarted = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                     clock=lambda: self.now, cache_path=path)
            self.client.request.side_effect = self.request
            await restarted.poll()
            self.assertEqual(self.apply.call_count, 1)
            self.assertEqual(self.posts[0][0], "/api/companion/positions/BOOK1/delivered")
            self.assertEqual(json.loads(path.read_text())["receipts"], [])

    async def test_repaired_device_purges_old_receipts_and_never_replays_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress-receipts.json"
            cached = {"version": 1, "deviceId": "old-mac", "receipts": [{
                "bookId": "BOOK1", "revision": 1, "cfi": item()["position"]["cfi"],
                "phase": "delivered", "applePosition": actual(),
            }]}
            path.write_text(json.dumps(cached)); path.chmod(0o600)
            sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                clock=lambda: self.now, cache_path=path)
            self.assertEqual(json.loads(path.read_text())["receipts"], [])
            await sync.poll()
            self.apply.assert_called_once()

    async def test_fresh_pending_revision_must_match_before_replaying_a_durable_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress-receipts.json"
            cached = {"version": 1, "deviceId": "this-mac", "receipts": [{
                "bookId": "BOOK1", "revision": 1, "cfi": item()["position"]["cfi"],
                "phase": "delivered", "applePosition": actual(),
            }]}
            path.write_text(json.dumps(cached)); path.chmod(0o600)
            self.pending = [item(revision=2)]
            sync = PositionSync(self.client, self.library, device_id="this-mac", apply=self.apply,
                                clock=lambda: self.now, cache_path=path)
            await sync.poll()
            self.apply.assert_called_once()
            self.assertEqual(self.posts[0][1]["revision"], 2)

    def test_cache_rejects_symlinks_or_readable_by_other_users(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "target"
            target.write_text('{}'); target.chmod(0o600)
            path = Path(temporary) / "progress-receipts.json"
            path.symlink_to(target)
            with self.assertRaises(CompanionError):
                PositionSync(self.client, self.library, device_id="this-mac", cache_path=path)
            path.unlink()
            target.chmod(0o644)
            with self.assertRaises(CompanionError):
                PositionSync(self.client, self.library, device_id="this-mac", cache_path=target)


if __name__ == "__main__":
    unittest.main()
