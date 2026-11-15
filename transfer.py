"""Send selected EPUBs and thumbnails over encrypted, direct WebRTC channels.

The cloud client carries only authenticated connection setup, never file bytes.
No HTTP file server, public file link, TURN relay, or incoming file writes exist.
"""

import asyncio
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from companion import CONFIG, CompanionError, SyncClient, read_config, sync
from covers import cover_bundle
from library import BooksLibrary
from position_sync import PositionSync


CHANNEL = "books-epub-v1"
COVERS_CHANNEL = "books-covers-v1"
MAX_EPUB_BYTES = 128 * 1024 * 1024
CHUNK_BYTES = 16 * 1024
HIGH_WATER = 256 * 1024
POLL_SECONDS = 5
IDLE_POLL_SECONDS = 20
POSITION_POLL_SECONDS = 20


@contextmanager
def service_lock(path):
    """Only one sender may consume this Mac's offers, across terminal/login runs."""
    descriptor = os.open(Path(path).with_name("transfer-service.lock"),
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise CompanionError("The transfer lock must be an owned regular file.")
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CompanionError("The Mac companion is already offering transfers. Use Save offline on your phone.") from None
        yield
    finally:
        os.close(descriptor)


class TransferFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def file_digest(source):
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(256 * 1024), b""):
        digest.update(chunk)
    source.seek(0)
    return digest.hexdigest()


async def transmit(channel, source, book_id, size, digest, acknowledged, closed, mark_ended, *, kind="book"):
    """Backpressure bounds memory; a phone ACK means it finished its durable save."""
    channel.send(json.dumps({"type": kind, "bookId": book_id, "size": size, "sha256": digest}))
    while chunk := source.read(CHUNK_BYTES):
        while channel.bufferedAmount > HIGH_WATER:
            if closed.is_set() or channel.readyState != "open":
                raise TransferFailure("TRANSFER_FAILED")
            await asyncio.sleep(0.01)
        if closed.is_set() or channel.readyState != "open":
            raise TransferFailure("TRANSFER_FAILED")
        channel.send(chunk)
        # Let ICE/SCTP and cancellation advance even on a fast local connection.
        await asyncio.sleep(0)
    mark_ended()
    channel.send(json.dumps({"type": "end"}))
    ack = asyncio.create_task(acknowledged.wait())
    gone = asyncio.create_task(closed.wait())
    try:
        await asyncio.wait([ack, gone], return_when=asyncio.FIRST_COMPLETED)
        if not acknowledged.is_set():
            raise TransferFailure("TRANSFER_FAILED")
    finally:
        ack.cancel()
        gone.cancel()
        await asyncio.gather(ack, gone, return_exceptions=True)


async def serve_offer(offer, library, client, *, timeout=170):
    """Authorized book IDs only; the remote peer never supplies file paths."""
    if not isinstance(offer, dict):
        raise TransferFailure("TRANSFER_FAILED")
    transfer_id = offer.get("id", "")
    book_id = offer.get("bookId", "")
    if (not isinstance(transfer_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", transfer_id)
            or not isinstance(book_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", book_id)):
        raise TransferFailure("TRANSFER_FAILED")
    kind = offer.get("kind", "epub")
    if kind not in ("epub", "covers"):
        raise TransferFailure("TRANSFER_FAILED")
    book_ids = offer.get("bookIds")
    if kind == "covers":
        if (not isinstance(book_ids, list) or not 1 <= len(book_ids) <= 200
                or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", value)
                       for value in book_ids)
                or len(set(book_ids)) != len(book_ids) or book_ids[0] != book_id):
            raise TransferFailure("TRANSFER_FAILED")
    description = offer.get("offer", {})
    if (not isinstance(description, dict) or description.get("type") != "offer"
            or not isinstance(description.get("sdp"), str) or len(description["sdp"]) > 32768):
        raise TransferFailure("TRANSFER_FAILED")
    try:
        remaining = (datetime.fromisoformat(offer["expiresAt"].replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds()
    except (KeyError, AttributeError, ValueError, TypeError):
        raise TransferFailure("TRANSFER_FAILED") from None
    if remaining <= 0:
        return False
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    channel_ready = asyncio.Event()
    acknowledged = asyncio.Event()
    closed = asyncio.Event()
    channel = None
    ended = False

    @peer.on("connectionstatechange")
    async def on_connection_state():
        if peer.connectionState in ("failed", "closed"):
            closed.set()

    @peer.on("datachannel")
    def on_data_channel(candidate):
        nonlocal channel
        expected_channel = COVERS_CHANNEL if kind == "covers" else CHANNEL
        if candidate.label != expected_channel or not candidate.ordered or channel is not None:
            candidate.close()
            return
        channel = candidate

        @channel.on("message")
        def on_message(message):
            if not isinstance(message, str) or len(message) > 100:
                closed.set()
                return
            try:
                payload = json.loads(message)
            except ValueError:
                closed.set()
                return
            if payload == {"type": "received"} and ended:
                acknowledged.set()
            else:
                closed.set()

        @channel.on("close")
        def on_close():
            closed.set()

        @channel.on("open")
        def on_open():
            channel_ready.set()

        if channel.readyState == "open":
            channel_ready.set()

    try:
        async with asyncio.timeout(min(timeout, remaining)):
            if kind == "covers":
                payload = await asyncio.to_thread(cover_bundle, library, book_ids)
                source_context = io.BytesIO(payload)
                size = len(payload)
            else:
                try:
                    path = await asyncio.to_thread(library.epub, book_id)
                except (KeyError, ValueError, OSError, RuntimeError):
                    raise TransferFailure("BOOK_UNAVAILABLE") from None
                source_context = path.open("rb")
            with source_context as source:
                if kind == "epub":
                    size = os.fstat(source.fileno()).st_size
                    if size <= 0 or size > MAX_EPUB_BYTES:
                        raise TransferFailure("BOOK_TOO_LARGE")
                digest = await asyncio.to_thread(file_digest, source)
                await peer.setRemoteDescription(RTCSessionDescription(**description))
                await peer.setLocalDescription(await peer.createAnswer())
                await asyncio.to_thread(client.request, "POST", f"/api/companion/transfers/{transfer_id}", {
                    "answer": {"type": "answer", "sdp": peer.localDescription.sdp},
                })
                opened = asyncio.create_task(channel_ready.wait())
                gone = asyncio.create_task(closed.wait())
                try:
                    await asyncio.wait([opened, gone], return_when=asyncio.FIRST_COMPLETED)
                    if closed.is_set():
                        raise TransferFailure("TRANSFER_FAILED")
                finally:
                    opened.cancel()
                    gone.cancel()
                    await asyncio.gather(opened, gone, return_exceptions=True)

                def mark_ended():
                    nonlocal ended
                    ended = True

                await transmit(channel, source, book_id, size, digest, acknowledged, closed, mark_ended,
                               kind="covers" if kind == "covers" else "book")
                message = "Library covers were saved" if kind == "covers" else "A selected book was saved"
                print(f"{message} on the receiving device.", flush=True)
                return True
    except asyncio.CancelledError:
        raise
    except Exception as error:
        code = error.code if isinstance(error, TransferFailure) else "TRANSFER_FAILED"
        try:
            await asyncio.to_thread(client.request, "POST", f"/api/companion/transfers/{transfer_id}", {"error": code})
        except CompanionError:
            pass  # A cancelled/expired transfer may already have been removed.
        message = (f"Library covers did not finish ({code}). Retry on your phone." if kind == "covers"
                   else f"A book transfer did not finish ({code}). Retry Save offline on your phone.")
        print(message, flush=True)
        return False
    finally:
        await peer.close()


async def serve_transfers(*, minutes=30, path=CONFIG, background=False):
    if background and not Path(path).exists():
        print("This Mac is not paired. Background transfers stopped.", flush=True)
        return
    # Validate pairing before creating the sibling lock file.
    read_config(path)
    with service_lock(path):
        await _serve_transfers(minutes=minutes, path=path, background=background)


async def _serve_transfers(*, minutes, path, background):
    config = read_config(path)
    client = SyncClient(config["server"], config["credential"], config.get("allowLocalHttp") is True)
    library = BooksLibrary()
    deadline = float("inf") if background else time.monotonic() + minutes * 60
    tasks = {}
    seen = {}
    next_sync = 0
    connected = False
    connection_warning = False
    positions = PositionSync(client, library, device_id=config["deviceId"],
                             cache_path=Path(path).with_name("progress-receipts.json"))
    position_task = None
    next_position_poll = 0

    async def refresh_metadata():
        result = await asyncio.to_thread(sync, path, library, client,
                                         skip_unchanged=background, quiet=background)
        if background and result["changed"]:
            print(f"Updated library metadata for {result['books']} books.", flush=True)
        return time.monotonic() + 60

    try:
        while time.monotonic() < deadline:
            if not Path(path).exists():
                print("Local Mac pairing was removed. Background transfers stopped.", flush=True)
                return
            read_interrupted = False
            try:
                # Confirm local library access before advertising transfer availability.
                if next_sync == 0:
                    next_sync = await refresh_metadata()
                batch = await asyncio.to_thread(client.request, "GET", "/api/companion/transfers")
                if not isinstance(batch.get("transfers"), list):
                    raise CompanionError("Invalid transfer response. Update the Mac companion.")
                if not connected:
                    if background:
                        print("Background companion connected. Ready for direct transfers on the same Wi-Fi.", flush=True)
                    else:
                        print(f"Ready for direct transfers for {minutes} minutes. Keep your phone on the same Wi-Fi and choose Save offline.", flush=True)
                        print("Press Control-C to stop. EPUB files go directly to your device, never through Vercel.", flush=True)
                connected = True
                connection_warning = False
                now = time.monotonic()
                if position_task is not None and position_task.done():
                    finished, position_task = position_task, None
                    finished.result()  # Authentication failure follows the normal stop policy below.
                if position_task is None and now >= next_position_poll:
                    position_task = asyncio.create_task(positions.poll())
                    next_position_poll = now + POSITION_POLL_SECONDS
                seen = {key: expiry for key, expiry in seen.items() if expiry > now}
                for item in batch["transfers"][:3]:
                    if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                        continue
                    if item["id"] in seen or len(tasks) >= 3:
                        continue
                    seen[item["id"]] = now + 180
                    task = asyncio.create_task(serve_offer(item, library, client))
                    tasks[item["id"]] = task
                for key, task in list(tasks.items()):
                    if task.done():
                        try:
                            task.result()
                        except (TransferFailure, ValueError, KeyError):
                            print("Skipped an invalid or expired transfer request.", flush=True)
                        del tasks[key]
                if now >= next_sync:
                    next_sync = await refresh_metadata()
            except InterruptedError:
                # Keep this process's permission and active transfers after transient local EINTR.
                read_interrupted = True
                print("Apple Books read was interrupted; retrying in 20 seconds.", flush=True)
            except CompanionError as error:
                if error.status in (401, 403):
                    if background:
                        print("This Mac was unlinked. Background transfers stopped; pair and install again to reconnect.", flush=True)
                        return  # A clean exit prevents launchd restarting a revoked credential.
                    raise  # Stop all transfers as soon as the Mac is unlinked.
                if not connection_warning:
                    print("Sync connection interrupted; the companion will retry automatically.", flush=True)
                connection_warning = True
                connected = False
            interval = IDLE_POLL_SECONDS if read_interrupted or (background and not tasks) else POLL_SECONDS
            await asyncio.sleep(min(interval, max(0, deadline - time.monotonic())))
    finally:
        positions.clear()
        if position_task is not None:
            position_task.cancel()
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(), *([position_task] if position_task is not None else []), return_exceptions=True)
    print("Transfer window ended. Run ./scripts/start-transfers.sh when you want to save more books.", flush=True)
