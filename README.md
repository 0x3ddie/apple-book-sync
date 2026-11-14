# Apple Books companion reader

A browser bookshelf with a local Apple Books bridge and an optional private cloud metadata service. Keep using Books on Apple devices, choose EPUBs to save in the browser, and keep a separate web reading position for each book.

Hosted preview: [apple-book-sync.vercel.app](https://apple-book-sync.vercel.app/). The production deployment and Neon database are configured. Live email delivery, user-confirmed phone sign-in, Mac pairing, and metadata upload and readback have been verified.

Direct EPUB transfer is implemented with automated sender and signaling tests passing. Full browser and phone transfer/offline-reading checks are still pending.

## What works locally

- A searchable library with real covers where available, Continue reading, and reading/availability filters.
- **Save offline**, **Remove download**, and **Saved on this device** let you select individual EPUBs. Selected files, covers, and imported annotations live in this browser's IndexedDB. The service worker saves only the public reader shell and its dependencies.
- Saved books open after a full page reload with the Mac service stopped. Offline page turns survive returning to the shelf and reloading; queued positions retry when connected. Removing a download leaves the Apple Books original untouched.
- EPUB reading, page turns, touch swipes, and keyboard navigation.
- Apple Books highlights drawn inline, plus a list of highlights, notes, and bookmarks that links to their passages.
- Opening a book reads its saved Apple Books position. A pending web position takes precedence so returning to the app does not lose web progress.
- Page turns save automatically. Done reading waits for a save before returning to the library. Unsent positions have a browser-local backup; hiding/leaving the page also attempts a keepalive save.
- Changes in both Books and the web reader prompt a position choice. Per-book revisions and session sequences protect against stale requests and competing tabs.

**Saving in the web reader does not update Apple Books automatically.** The manual Open this position in Apple Books link works on the Mac. Automatic position application and iPad propagation are not implemented or verified. The Python preview binds only to `127.0.0.1`; the local preview itself is not phone-accessible. Use the hosted app and the direct-transfer command below to prepare books on another device.

Only downloaded, readable, DRM-free EPUBs can open. iCloud placeholders appear in the library with instructions to download them in Books first; listing the library does not intentionally hydrate cloud files. Annotations are imported read-only. Changes made here are not written into Apple’s databases.

## Run the local web preview

Requires macOS with Apple Books, Python 3.9+, Node.js 22+, and npm. The terminal or host app needs permission to read Books app data.

```sh
npm ci --ignore-scripts
python3 serve.py
```

Open <http://127.0.0.1:8765/> on the same Mac. No one-book preparation is required for the library.

The Mac bridge saves positions in `.local/reader.sqlite3` and packages requested EPUBs in `.local/books/`. These private files, original test backups, and screenshots remain git-ignored. Selected offline EPUBs also live in this browser, not on Vercel. Browser-local unsent positions live in localStorage under `books-pending:` keys. Clearing site data removes downloads and unsent backups. The browser may evict storage; the app requests persistence without promising it will be granted.

## Email login and private cloud service

The first login provider is an email sign-in link. Better Auth handles sessions and single-use, ten-minute links; Resend delivers email. A Postgres database stores accounts, device registrations, library metadata, imported annotations, web reading positions, and short-lived WebRTC connection descriptions. There are no cloud EPUB/cover upload or download endpoints.

Every private request verifies the server session and scopes database queries to its owner. An expected-account header also prevents an old tab from using a newly switched account's cookie. Browser databases and pending positions are scoped by account. Signing out removes downloads; any drafts created concurrently in another tab remain associated with their original owner. Definitive authentication failure locks the reader; network failure permits the previously signed-in account to read its local copies.

To configure a deployment:

1. Provide a Postgres database and Resend sender with a verified sending domain. Set the variables listed in [cloud/.env.example](cloud/.env.example) in Vercel. `BETTER_AUTH_URL` must be the exact public HTTPS origin; `BETTER_AUTH_SECRET` must be a strong random secret of at least 32 characters.
2. Run `npm run migrate:cloud` with those environment variables available. For a local ignored `.env` file, use `node --env-file=.env cloud/migrate.mjs`. Migrations create the Better Auth and Books tables; they do not send emails.
3. Deploy using the included `vercel.json`. `npm run build` copies an explicit allowlist of public reader files and vendor scripts into `dist/`. The Vercel function in `api/index.mjs` serves cloud metadata through an explicit `/api/:path*` rewrite; the Python bridge is excluded. Missing configuration leaves all cloud endpoints closed with HTTP 503.

The Vercel deployment is live at [apple-book-sync.vercel.app](https://apple-book-sync.vercel.app/), with the Neon schema migration complete and production configuration in place. Resend is configured to send from `reading@books.eddiechen.xyz`. All required sender DNS records are verified. Live checks confirm that anonymous library requests are rejected and nested auth, pairing, and companion routes reach the application. Resend confirmed delivery of a real sign-in email, and the user confirmed signing in on their phone. Mac pairing and metadata upload were verified by reading the library back under the correct signed-in account. Automated tests capture emails in memory.

## Download and pair the Mac companion

The web app and Mac companion are both in this repository. The companion is currently a Python command-line program, not a packaged macOS app or an Apple Books extension. Pairing and metadata sync require macOS, Git, and Python 3.9+ and use only Python's standard library. Direct EPUB transfers require Python 3.11+ and the separate dependencies installed by the script below. Neither companion mode needs Node.js or npm.

Download the project in Terminal:

```sh
git clone https://github.com/0x3ddie/apple-book-sync.git
cd apple-book-sync
python3 companion.py --help
```

If you already cloned the repository, open its folder instead of cloning it again. Open Apple Books on the Mac with your library, and allow the terminal or host app to read Books data if macOS prompts.

After signing in to [the website](https://apple-book-sync.vercel.app/), open **Linked Macs** and create a pairing code. Then run:

```sh
python3 companion.py pair --server https://apple-book-sync.vercel.app --name "My Mac"
python3 companion.py sync
```

Paste the pairing code at the hidden terminal prompt. It expires after ten minutes and can be used once. One Mac companion is active per account in this version; linking a replacement revokes the previous credential. The website shows registered Macs and their last contact time—it does not silently detect installations.

`sync` performs one outbound metadata sync. It uploads titles, identifiers, saved Apple positions, and annotations, then checks pending web positions. It does not upload EPUBs/covers, modify Books, or open external URLs. Credentials are stored in `.local/companion.json` with permissions `0600`; this prototype does not yet use Keychain. Use `python3 companion.py status` to see the pairing, and **Unlink** on the website to revoke access. `python3 companion.py unpair` removes the local credential only.

## Save selected books on your phone

After pairing the Mac, connect the Mac and phone to the same Wi-Fi. On the Mac, run:

```sh
./scripts/start-transfers.sh
```

The script creates an isolated, git-ignored environment at `.local/transfer-venv` and installs `aiortc==1.16.0` and its dependencies from PyPI. It needs Python 3.11 or newer. Transfers stay available for 30 minutes by default; use `./scripts/start-transfers.sh --minutes 60` to choose a window from 1 to 480 minutes. Keep the Mac awake and the command running; Control-C stops it. The command syncs library metadata when it starts and once a minute while running.

On the phone, sign in to the hosted app, tap **Refresh library**, then choose **Save offline** for each book you want. The EPUB must already be downloaded and readable in Apple Books on the Mac. Wait until the app confirms that the book is saved, then open it or find it under **Saved on this device**. You can remove each browser copy with **Remove download**. Cloud transfers copy the EPUB only; separate cover-image files are not transferred, so the shelf may use text covers.

The browser and Mac exchange authenticated, account-bound connection offers and answers through Vercel. Each offer expires after three minutes. The EPUB then travels over an encrypted WebRTC data channel directly between the devices. Neither STUN nor TURN servers are configured, and Vercel never receives or stores the EPUB bytes. Networks that isolate Wi-Fi clients can prevent the direct connection; there is no relay fallback.

The receiver checks the file size and SHA-256 digest before saving the EPUB in that account's browser IndexedDB. It acknowledges success only after the save completes. Transfers are limited to 128 MiB per EPUB. Keep the phone page open until saving finishes; an interrupted transfer can be retried. Once saved, the book and cached reader shell are available without the Mac or an internet connection, subject to browser storage availability.

## Sync limits

The intended full flow is:

```text
Android web reader ↔ private server ↔ Mac companion ↔ Apple Books ↔ iCloud/iPad
```

The local bridge reads Books data and stores web progress, plus manual return links. The new companion and cloud APIs carry metadata and pending web positions; they do not apply those positions to Books. Automatic application still needs implementation and verification that Books actually saved the passage. A sent request or a clicked link alone must never be labeled as confirmed sync.

EPUB transfer uses the separate direct path described above. Pairing and metadata sync alone do not copy book files: the Mac must be offering transfers, and the reader must select **Save offline** for each book. There is no cloud file storage or automatic bulk download.

The Mac must be awake and online to send fresh Apple Books changes. The cloud service retains pending web changes while the Mac is unavailable. The companion currently runs on demand, with no background scheduler. Books may not flush its current reading position to disk immediately.

Exit-only syncing is unreliable on mobile because the operating system can terminate a browser without an exit event. Regular saves and local backups carry the main responsibility; the hidden-page save is best effort. [Browser lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

## Original round-trip evidence

The one-book test used Hardball:

1. Its saved Books position opened in the browser.
2. Advancing in the browser and manually clicking the return link on the Mac opened the new passage in Books.
3. Closing and reopening Books preserved the page containing that passage.

Books saved a page-aligned position rather than the browser’s exact character offset. The original chapter-opening spread was restored afterward. This is evidence for a manual handoff on the tested Mac/Books version, not unattended cross-device sync. Books’ private SQLite layout and CFI return links are unsupported integration points that can change.

`prepare.py` remains available for capturing one-book comparison snapshots. It refuses to replace `.local/original-position.json`; `python3 prepare.py "Exact book title" --snapshot-only comparison.json` captures another read-only snapshot. Original evidence includes `.local/return-target.json`, `.local/after-return-close.json`, and `.local/books-after-reopen.txt`.

## Checks

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile library.py serve.py prepare.py
node --check public/reader.js
node --test tests/transfer.test.mjs
npm run test:cloud
npm run build
```

After installing transfer dependencies, run `.local/transfer-venv/bin/python -m unittest discover -s tests -v` to include the real WebRTC peer tests. Without those dependencies, the direct-transfer Python tests are skipped.

Python tests use temporary Books-like databases and EPUB fixtures. They cover per-book persistence, out-of-order saves, competing readers, Apple-position conflicts, invalid input, EPUB/annotation import, iCloud placeholders, HTTP Host/Origin checks, metadata-only companion payloads, credentials, and batching. Three direct-transfer tests pass using real WebRTC peers. The 14 cloud tests exercise real Better Auth and PostgreSQL via PGlite, including account isolation, pairing, position conflicts, and transfer signaling expiry/replay/revocation and payload restrictions. Tests do not modify the real Apple Books library or send real emails. Automated peer and signaling checks do not replace the pending full browser/phone offline-reading check.
