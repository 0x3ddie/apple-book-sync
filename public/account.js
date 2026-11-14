"use strict";

// The cloud API authenticates every private request. This gate also prevents
// a shared browser from loading another account's offline library.
window.ReaderAccount = (() => {
  const hintKey = "books-last-account";
  const revokedKey = "books-account-revoked";
  const get = (id) => document.getElementById(id);
  let current, unlock;
  const ready = new Promise((resolve) => { unlock = resolve; });

  function errorAt(id, message) {
    get(id).textContent = message || "";
    get(id).hidden = !message;
  }
  async function request(path, options = {}) {
    let response;
    const headers = new Headers(options.headers);
    if (current?.mode === "cloud") headers.set("X-Books-Account", current.user.id);
    try { response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(12000), ...options, headers }); }
    catch (error) { error.networkFailure = true; throw error; }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.error === "string" ? data.error : data.message || "This request could not be completed.");
      error.status = response.status;
      if (current && (error.status === 401 || error.status === 403)) window.dispatchEvent(new Event("books-session-expired"));
      throw error;
    }
    return data;
  }
  function cachedAccount() {
    try {
      const account = JSON.parse(localStorage.getItem(hintKey));
      if (account?.mode === "local" && account.scope === "local" && location.hostname === "127.0.0.1") return account;
      if (account?.mode === "cloud" && typeof account.user?.id === "string" && account.scope === `account:${account.user.id}`) return account;
    } catch { /* Offline access needs a previously verified identity. */ }
    return null;
  }
  function openLibrary(account, offline = false) {
    current = { ...account, offline };
    try { localStorage.setItem(hintKey, JSON.stringify(account)); } catch { /* Online access still works. */ }
    get("sign-in-view").hidden = true;
    get("library-view").hidden = false;
    get("account-bar").hidden = account.mode !== "cloud";
    get("account-email").textContent = account.user?.email || "";
    if (account.mode === "cloud") {
      document.querySelector(".local-label").textContent = offline ? "Offline library" : "Private library";
      get("refresh").textContent = "Refresh library";
      document.querySelector(".library-footer").textContent = "Choose Save offline to copy a book directly from your Mac over the same Wi-Fi. Keep transfers running on your Mac until saving finishes. Saved EPUBs stay on this device, not on Vercel.";
    }
    unlock(current);
  }
  async function checkSession() {
    errorAt("account-error", "");
    get("retry-account").hidden = true;
    try {
      const session = await request("/api/session");
      if (session.mode === "local" && location.hostname === "127.0.0.1") {
        openLibrary({ mode: "local", user: null, scope: "local" });
      } else if (typeof session.user?.id === "string") {
        openLibrary({ mode: "cloud", user: session.user, scope: `account:${session.user.id}` });
      } else throw new Error("The server did not return a valid account.");
    } catch (error) {
      if (error.status === 401) {
        try { localStorage.removeItem(hintKey); } catch { /* The live gate still stays closed. */ }
        get("sign-in-form").hidden = false;
        get("account-status").textContent = "No password needed. Open the email link on this device.";
        if (new URL(location.href).searchParams.has("error")) errorAt("account-error", "That sign-in link could not be used. Request a new one below.");
        return;
      }
      if (error.status === 403) try { localStorage.removeItem(hintKey); } catch { /* Stay closed. */ }
      if (error.networkFailure) {
        const account = cachedAccount();
        if (account) { openLibrary(account, true); return; }
      }
      get("account-status").textContent = "Sign-in is unavailable right now.";
      errorAt("account-error", error.status === 503 ? "The private sync service needs its database and email sender configured before you can sign in." : error.message);
      get("retry-account").hidden = false;
    }
  }

  get("sign-in-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    get("send-sign-in").disabled = true;
    errorAt("account-error", "");
    try {
      await request("/api/auth/sign-in/magic-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: get("sign-in-email").value.trim(), callbackURL: "/" }),
      });
      get("account-status").textContent = "Check your email. Open the sign-in link on this device to continue.";
    } catch (error) {
      errorAt("account-error", error.message);
    } finally { get("send-sign-in").disabled = false; }
  });
  get("retry-account").addEventListener("click", checkSession);

  async function devices() {
    errorAt("device-error", "");
    const data = await request("/api/devices");
    const rows = data.devices.map((device) => {
      const row = document.createElement("div");
      row.className = "device-row";
      const description = document.createElement("p");
      description.textContent = `${device.name} · ${device.revokedAt ? "Unlinked" : device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : "Waiting for first sync"}`;
      const revoke = document.createElement("button");
      revoke.className = "quiet-button"; revoke.type = "button"; revoke.textContent = "Unlink";
      revoke.setAttribute("aria-label", `Unlink ${device.name}`);
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try { await request(`/api/devices/${encodeURIComponent(device.id)}/revoke`, { method: "POST" }); await devices(); }
        catch (error) { errorAt("device-error", error.message); revoke.disabled = false; }
      });
      row.append(description);
      if (!device.revokedAt) row.append(revoke);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "No Mac linked yet. Create a pairing code to connect yours.";
      rows.push(empty);
    }
    get("device-list").replaceChildren(...rows);
  }
  get("manage-devices").addEventListener("click", () => {
    get("devices-panel").hidden = false;
    devices().catch((error) => errorAt("device-error", error.message));
  });
  get("close-devices").addEventListener("click", () => { get("devices-panel").hidden = true; });
  get("create-pairing").addEventListener("click", async () => {
    get("create-pairing").disabled = true;
    errorAt("device-error", "");
    try {
      const result = await request("/api/devices/pairing", { method: "POST" });
      get("pairing-token").value = result.token;
      get("pairing-expiry").textContent = `Use once before ${new Date(result.expiresAt).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}.`;
      get("pairing-result").hidden = false;
    } catch (error) { errorAt("device-error", error.message); }
    finally { get("create-pairing").disabled = false; }
  });

  window.addEventListener("storage", async (event) => {
    if (!current || ![hintKey, revokedKey].includes(event.key)) return;
    try {
      const changed = JSON.parse(event.newValue);
      if (event.key === hintKey && changed?.scope === current.scope) return;
      if (event.key === revokedKey && changed?.scope !== current.scope) return;
      window.dispatchEvent(new Event("books-account-changing"));
      document.body.hidden = true;
      await window.OfflineBooks?.closeScope();
      location.reload();
    } catch { location.reload(); }
  });
  window.addEventListener("books-session-expired", async () => {
    window.dispatchEvent(new Event("books-account-changing"));
    document.body.hidden = true;
    try { localStorage.removeItem(hintKey); await window.OfflineBooks?.closeScope(); }
    finally { location.reload(); }
  }, { once: true });
  get("sign-out").addEventListener("click", async () => {
    get("sign-out").disabled = true;
    try {
      const prefix = `books-pending:${current.scope}:`;
      if (Object.keys(localStorage).some((key) => key.startsWith(prefix))) {
        throw new Error("Some reading positions are still waiting to sync. Reconnect and refresh your library before signing out.");
      }
      await request("/api/auth/sign-out", { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
      window.dispatchEvent(new Event("books-account-changing"));
      localStorage.removeItem(hintKey);
      localStorage.setItem(revokedKey, JSON.stringify({ scope: current.scope, at: Date.now() }));
      // Another tab may have saved a draft while sign-out was in flight.
      // Keep pending positions scoped to their owner for the next sign-in.
      await window.OfflineBooks.clearScope();
      location.reload();
    } catch (error) {
      get("devices-panel").hidden = false;
      errorAt("device-error", `Couldn’t finish signing out and clearing this device. ${error.message}`);
      get("sign-out").disabled = false;
    }
  });
  checkSession();
  return { ready, get current() { return current; } };
})();
