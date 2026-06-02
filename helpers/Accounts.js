const fs = require("fs");
const path = require("path");
const Sessions = require("./Sessions.js");

const ACCOUNTS_PATH = path.join(__dirname, "..", "accounts.json");

// Remembers the accounts you've used so the GUI can offer them in a dropdown.
// Passwords are optional - if you let the tool save one it's stored in plain
// text here (accounts.json is git-ignored), otherwise you just type it each time
// or rely on the saved Steam session.
module.exports = class Accounts {
	static list() {
		let all = Accounts._readAll();
		return Object.values(all).map((acc) => ({
			username: acc.username,
			hasPassword: !!acc.password,
			hasSession: !!Sessions.getToken(acc.username),
			throttleRemainingMs: Sessions.throttleRemainingMs(acc.username)
		}));
	}

	static save({ username, password, remember }) {
		username = String(username || "").trim();
		if (!username) {
			return;
		}
		let all = Accounts._readAll();
		let entry = all[Accounts._key(username)] || { username };
		entry.username = username;
		if (remember && password) {
			entry.password = password;
		}
		if (!remember) {
			delete entry.password;
		}
		all[Accounts._key(username)] = entry;
		Accounts._writeAll(all);
	}

	static getPassword(username) {
		let entry = Accounts._readAll()[Accounts._key(username)];
		return entry && entry.password ? entry.password : null;
	}

	static remove(username) {
		let all = Accounts._readAll();
		delete all[Accounts._key(username)];
		Accounts._writeAll(all);
		Sessions.removeToken(username);
		Sessions.clearThrottle(username);
	}

	static _key(username) {
		return String(username || "").trim().toLowerCase();
	}

	static _readAll() {
		try {
			return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
		} catch {
			return {};
		}
	}

	static _writeAll(all) {
		try {
			fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(all, null, "\t"));
		} catch {
			// Best-effort - not being able to remember accounts isn't fatal
		}
	}
};
