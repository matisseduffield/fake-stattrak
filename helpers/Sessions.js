const fs = require("fs");
const path = require("path");

const SESSIONS_PATH = path.join(__dirname, "..", "sessions.json");

// How long to avoid re-attempting a login after Steam throttled it. Steam's own
// throttle can last longer, but this stops the tool from piling on more attempts
// (which can reset Steam's timer) when it's re-run too soon.
const THROTTLE_COOLDOWN_MS = 30 * 60 * 1000;

// Stores per-account Steam refresh tokens (so repeated runs can skip the password
// and Steam Guard prompts) and the last time a login was throttled (so we can back
// off instead of hammering Steam).
//
// Refresh tokens are sensitive - anyone with the file can log into the account -
// so sessions.json is git-ignored. Delete it any time to reset.
module.exports = class Sessions {
	static getToken(username) {
		let entry = Sessions._entry(username);
		if (!entry.refreshToken || Sessions._isExpired(entry.refreshToken)) {
			return null;
		}
		return entry.refreshToken;
	}

	static setToken(username, token) {
		if (!token) {
			return;
		}
		Sessions._update(username, (entry) => { entry.refreshToken = token; });
	}

	static removeToken(username) {
		Sessions._update(username, (entry) => { delete entry.refreshToken; });
	}

	// Record that Steam just throttled a login for this account.
	static markThrottled(username) {
		Sessions._update(username, (entry) => { entry.throttledAt = Date.now(); });
	}

	// Clear the throttle marker (e.g. after a successful login).
	static clearThrottle(username) {
		Sessions._update(username, (entry) => { delete entry.throttledAt; });
	}

	// Milliseconds still left on the cooldown for this account, or 0 if none.
	static throttleRemainingMs(username) {
		let throttledAt = Sessions._entry(username).throttledAt;
		if (!throttledAt) {
			return 0;
		}
		return Math.max(0, throttledAt + THROTTLE_COOLDOWN_MS - Date.now());
	}

	static _key(username) {
		return String(username || "").trim().toLowerCase();
	}

	static _entry(username) {
		let value = Sessions._readAll()[Sessions._key(username)];
		if (typeof value === "string") {
			return { refreshToken: value }; // migrate the old "username -> token string" format
		}
		return value && typeof value === "object" ? value : {};
	}

	static _update(username, mutate) {
		let all = Sessions._readAll();
		let key = Sessions._key(username);
		let entry = all[key];
		if (typeof entry === "string") {
			entry = { refreshToken: entry };
		} else if (!entry || typeof entry !== "object") {
			entry = {};
		}
		mutate(entry);
		all[key] = entry;
		Sessions._writeAll(all);
	}

	static _readAll() {
		try {
			return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
		} catch {
			return {};
		}
	}

	static _writeAll(all) {
		try {
			fs.writeFileSync(SESSIONS_PATH, JSON.stringify(all, null, "\t"));
		} catch {
			// Best-effort cache - if we can't write, we just log in normally next time
		}
	}

	// Refresh tokens are JWTs; decode the payload to check the expiry instead of
	// wasting a (throttle-counted) login attempt on an already-expired token.
	static _isExpired(token) {
		try {
			let payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
			if (!payload.exp) {
				return true;
			}
			// Treat as expired a little early so we never log in with a token about to die
			return (payload.exp - 3600) * 1000 < Date.now();
		} catch {
			return true;
		}
	}
};
