import asyncio
import contextlib
import errno
import hashlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from companion import CompanionError, write_config

try:
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from transfer import CHANNEL, MAX_EPUB_BYTES, serve_offer, serve_transfers, service_lock
    HAS_WEBRTC = True
except ImportError:
    HAS_WEBRTC = False


@unittest.skipUnless(HAS_WEBRTC, "Run with .local/transfer-venv/bin/python for direct-transfer checks")
class DirectTransferTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.file = Path(self.temporary.name) / "fixture.epub"
        self.payload = b"PK\x03\x04private-book-bytes" + bytes(range(256)) * 4096
        self.file.write_bytes(self.payload)
        self.library = SimpleNamespace(epub=lambda book_id: self.file)

    async def exchange(self, *, acknowledge=True):
        peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.addAsyncCleanup(peer.close)
        channel = peer.createDataChannel(CHANNEL, ordered=True)
        chunks, messages, calls = [], [], []
        loop = asyncio.get_running_loop()
        answer = loop.create_future()

        @channel.on("message")
        def message(value):
            if isinstance(value, bytes):
                chunks.append(value)
            else:
                data = json.loads(value)
                messages.append(data)
                if data == {"type": "end"}:
                    if acknowledge:
                        channel.send(json.dumps({"type": "received"}))
                    else:
                        channel.close()

        class Client:
            def request(self, method, endpoint, body=None):
                calls.append((method, endpoint, body))
                if body and "answer" in body:
                    loop.call_soon_threadsafe(answer.set_result, body["answer"])
                return {"ok": True}

        await peer.setLocalDescription(await peer.createOffer())
        offer = {"id": "transfer-one", "bookId": "BOOK1",
                 "offer": {"type": "offer", "sdp": peer.localDescription.sdp},
                 "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=40)).isoformat()}
        task = asyncio.create_task(serve_offer(offer, self.library, Client(), timeout=20))
        try:
            description = await asyncio.wait_for(answer, 10)
            await peer.setRemoteDescription(RTCSessionDescription(**description))
            result = await asyncio.wait_for(task, 20)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return result, chunks, messages, calls

    async def test_real_data_channel_sends_exact_file_and_waits_for_receiver_ack(self):
        result, chunks, messages, calls = await self.exchange()
        self.assertTrue(result)
        self.assertEqual(b"".join(chunks), self.payload)
        self.assertTrue(all(len(chunk) <= 16384 for chunk in chunks))
        self.assertEqual(messages[0], {"type": "book", "bookId": "BOOK1", "size": len(self.payload),
                                      "sha256": hashlib.sha256(self.payload).hexdigest()})
        self.assertEqual(messages[-1], {"type": "end"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(set(calls[0][2]), {"answer"})
        self.assertNotIn("private-book-bytes", json.dumps(calls))

    async def test_closed_receiver_without_ack_is_not_reported_saved(self):
        result, _, _, calls = await self.exchange(acknowledge=False)
        self.assertFalse(result)
        self.assertEqual(calls[-1][2], {"error": "TRANSFER_FAILED"})

    async def test_large_file_is_rejected_before_negotiation_or_read(self):
        with self.file.open("wb") as output:
            output.truncate(MAX_EPUB_BYTES + 1)
        calls = []
        client = SimpleNamespace(request=lambda *args: calls.append(args))
        result = await serve_offer({"id": "transfer-two", "bookId": "BOOK1",
                                   "offer": {"type": "offer", "sdp": "unused"},
                                   "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=40)).isoformat()},
                                  self.library, client)
        self.assertFalse(result)
        self.assertEqual(calls, [("POST", "/api/companion/transfers/transfer-two", {"error": "BOOK_TOO_LARGE"})])


@unittest.skipUnless(HAS_WEBRTC, "Run with .local/transfer-venv/bin/python for direct-transfer checks")
class TransferServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / ".local/companion.json"
        write_config({"server": "https://reader.example", "deviceId": "device-one",
                      "credential": "device_" + "a" * 43, "sequence": 1000}, self.path)
        self.client = Mock()
        self.client.request.return_value = {"transfers": []}
        self.metadata_sync = Mock(return_value={"changed": False, "books": 1})
        self.clock = 0
        self.waits = []
        real_sleep = asyncio.sleep

        async def sleep(seconds):
            self.waits.append(seconds)
            self.clock += seconds
            if len(self.waits) > 20:
                raise AssertionError("The transfer loop did not stop as expected")
            await real_sleep(0)

        async def in_thread(function, *args, **kwargs):
            return function(*args, **kwargs)

        self.enterContext(patch("transfer.time", SimpleNamespace(monotonic=lambda: self.clock)))
        self.enterContext(patch("transfer.asyncio.sleep", side_effect=sleep))
        self.enterContext(patch("transfer.asyncio.to_thread", side_effect=in_thread))
        self.enterContext(patch("transfer.SyncClient", return_value=self.client))
        self.library = self.enterContext(patch("transfer.BooksLibrary")).return_value
        self.enterContext(patch("transfer.sync", self.metadata_sync))
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))

    def test_service_lock_blocks_a_duplicate_and_releases_after_error(self):
        with self.assertRaisesRegex(RuntimeError, "simulated stop"):
            with service_lock(self.path):
                with self.assertRaisesRegex(CompanionError, "already offering"):
                    with service_lock(self.path):
                        self.fail("A duplicate sender acquired the lock")
                raise RuntimeError("simulated stop")
        with service_lock(self.path):
            self.assertEqual(self.path.with_name("transfer-service.lock").stat().st_mode & 0o777, 0o600)

    async def test_background_retries_network_failure_at_idle_interval_and_outlives_duration(self):
        self.client.request.side_effect = [CompanionError("Network unavailable"),
                                           *[{"transfers": []} for _ in range(4)],
                                           CompanionError("Unlinked", status=401)]
        await serve_transfers(minutes=1, path=self.path, background=True)
        self.assertEqual(self.waits, [20] * 5)
        self.assertGreater(self.clock, 60)
        self.assertEqual(self.client.request.call_count, 6)
        self.assertEqual(self.metadata_sync.call_count, 2)
        self.metadata_sync.assert_called_with(self.path, self.library, self.client,
                                              skip_unchanged=True, quiet=True)

    async def test_background_revocation_stops_cleanly_and_cancels_active_transfers(self):
        for status in (401, 403):
            with self.subTest(status=status):
                started = asyncio.Event()
                stopped = asyncio.Event()

                async def pending_transfer(*args):
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        stopped.set()

                self.client.request.side_effect = [{"transfers": [{"id": "active-transfer"}]},
                                                   CompanionError("Unlinked", status=status)]
                with patch("transfer.serve_offer", side_effect=pending_transfer):
                    await serve_transfers(path=self.path, background=True)
                self.assertTrue(started.is_set())
                self.assertTrue(stopped.is_set())
                self.assertEqual(self.waits[-1], 5)
                # Clean shutdown also releases the sender lock.
                with service_lock(self.path):
                    pass

    async def test_initial_interrupted_read_retries_before_heartbeat_or_ready(self):
        attempts = []

        def metadata(*args, **kwargs):
            attempts.append(self.clock)
            self.client.request.assert_not_called()
            self.assertNotIn("Ready for direct transfers", self.output.getvalue())
            if len(attempts) == 1:
                raise InterruptedError(errno.EINTR, "Interrupted system call")
            return {"changed": False, "books": 1}

        self.metadata_sync.side_effect = metadata
        self.client.request.side_effect = [{"transfers": []}, CompanionError("Unlinked", status=401)]
        await serve_transfers(path=self.path, background=True)
        self.assertEqual(attempts, [0, 20])
        self.assertEqual(self.waits, [20, 20])
        self.assertIn("Background companion connected. Ready for direct transfers", self.output.getvalue())

    async def test_periodic_interrupted_read_keeps_active_transfer_and_retries_in_process(self):
        started = asyncio.Event()
        stopped = asyncio.Event()
        attempts = []
        heartbeats = []

        async def pending_transfer(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        def metadata(*args, **kwargs):
            attempts.append(self.clock)
            if len(attempts) == 2:
                raise InterruptedError(errno.EINTR, "Interrupted system call")
            if len(attempts) == 3:
                self.assertTrue(started.is_set())
                self.assertFalse(stopped.is_set())
            return {"changed": False, "books": 1}

        def heartbeat(*args):
            heartbeats.append(self.clock)
            if self.clock >= 85:
                raise CompanionError("Unlinked", status=401)
            return {"transfers": [{"id": "active-transfer"}]}

        self.metadata_sync.side_effect = metadata
        self.client.request.side_effect = heartbeat
        with patch("transfer.serve_offer", side_effect=pending_transfer) as offer:
            await serve_transfers(path=self.path, background=True)
        self.assertEqual(attempts, [0, 60, 80])
        self.assertEqual(self.waits, [5] * 12 + [20, 5])
        self.assertIn(60, heartbeats)
        self.assertIn(80, heartbeats)
        offer.assert_called_once()
        self.assertTrue(stopped.is_set())

    async def test_permission_denial_does_not_advertise_readiness_or_retry_as_interruption(self):
        self.metadata_sync.side_effect = PermissionError(errno.EPERM, "Operation not permitted")
        with self.assertRaises(PermissionError):
            await serve_transfers(path=self.path, background=True)
        self.client.request.assert_not_called()
        self.assertNotIn("Ready for direct transfers", self.output.getvalue())
        self.assertEqual(self.waits, [])

    async def test_foreground_window_remains_bounded(self):
        await serve_transfers(minutes=1, path=self.path)
        self.assertEqual(self.clock, 60)
        self.assertEqual(self.waits, [5] * 12)
        self.assertEqual(self.client.request.call_count, 12)
        self.metadata_sync.assert_called_once_with(self.path, self.library, self.client,
                                                   skip_unchanged=False, quiet=False)

    async def test_unpaired_background_start_exits_without_polling_or_creating_lock(self):
        self.path.unlink()
        await serve_transfers(path=self.path, background=True)
        self.client.request.assert_not_called()
        self.metadata_sync.assert_not_called()
        self.assertFalse(self.path.with_name("transfer-service.lock").exists())
        self.assertEqual(self.waits, [])
        with self.assertRaisesRegex(CompanionError, "not paired"):
            await serve_transfers(path=self.path)


if __name__ == "__main__":
    unittest.main()
