const fs = require("fs");
const path = require("path");

const SESSIONS_PATH = path.join(__dirname, "..", "sessions.json");

// Stores Steam refresh tokens locally so repeated runs can skip the password and
// Steam Guard prompts (and trigger Steam's login throttling far less often).
//
// Refresh tokens are sensitive - anyone with the file can log into the account -
// so sessions.json is git-ignored. Delete it any time to force a fresh login.
module.exports = class Sessions {
	static get(username) {
		let token = Sessions._readAll()[Sessions._key(username)];
		if (!token || Sessions._isExpired(token)) {
			return null;
		}
		return token;
	}

	static set(username, token) {
		if (!token) {
			return;
		}
		let all = Sessions._readAll();
		all[Sessions._key(username)] = token;
		Sessions._writeAll(all);
	}

	static remove(username) {
		let all = Sessions._readAll();
		delete all[Sessions._key(username)];
		Sessions._writeAll(all);
	}

	static _key(username) {
		return String(username || "").trim().toLowerCase();
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
