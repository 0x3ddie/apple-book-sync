# Apple Book Sync

Read EPUBs from your Apple Books library on your Android phone, in your browser. Browse your library with book covers, see your Apple Books highlights and bookmarks, and save books for offline reading.

A companion on your Mac connects your library to your private account. EPUBs and cover images travel directly from your Mac to your phone; Vercel only handles login and sync data.

**[Open the web app →](https://apple-book-sync.vercel.app)**

This is an early version. Mac setup uses Terminal, and reading progress from the web app does **not yet update Apple Books automatically**.

## Set up

You’ll need a Mac with Apple Books and iCloud Books enabled, Git, Python **3.11+**, and DRM-free EPUBs downloaded in Books.

### 1. Get the Mac companion

Open Terminal on your Mac and run:

```sh
git clone https://github.com/0x3ddie/apple-book-sync.git
cd apple-book-sync
python3 companion.py pair --server https://apple-book-sync.vercel.app --name "My Mac"
```

Keep Terminal open. It shows a six-digit code, valid for five minutes.

### 2. Link your phone

Open [the web app](https://apple-book-sync.vercel.app) in Chrome on your phone and sign in using the email link. Open **Linked Macs**, enter the six-digit code, and tap **Link Mac**.

Back on your Mac, check that the displayed email is yours and type **yes**. Pairing is saved; you won’t need a new code each time. Linking another Mac replaces the previous one.

### 3. Enable background sync

In the same Terminal window, run:

```sh
./scripts/start-transfers.sh
```

Let the dependencies install and allow access to Books if macOS asks. When it says **Ready for direct transfers**, press **Control-C**, then run:

```sh
python3 background.py authorize
```

Click **Allow this folder** in both dialogs. If a dialog opens the wrong location, press **Command-Shift-G** and paste the matching path:

- First: `~/Library/Containers/com.apple.iBooksX/Data/Documents`
- Second: `~/Library/Mobile Documents/iCloud~com~apple~iBooks/Documents`

After both folders are approved, check that the companion is running:

```sh
python3 background.py status
```

You can close Terminal. The companion now runs in the background and starts when you log into your Mac.

### 4. Save books before heading out

Keep your Mac awake and online, with both devices on the same Wi-Fi. On your phone, tap **Refresh library**, then **Save offline** on the books you want. Keep the page open until each download finishes.

Saved books stay on that phone after you close the tab and can be read without your Mac or an internet connection. Signing out or clearing browser data removes the downloads.
