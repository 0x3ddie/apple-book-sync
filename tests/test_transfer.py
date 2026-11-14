import asyncio
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

try:
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from transfer import CHANNEL, MAX_EPUB_BYTES, serve_offer
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


if __name__ == "__main__":
    unittest.main()
