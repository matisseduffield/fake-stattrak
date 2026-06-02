const fs = require("fs");
const path = require("path");
const prompts = require("prompts");
const SteamUser = require("steam-user");
const Helper = require("./helpers/Helper.js");
const EventTypes = require("./helpers/EventTypes.js");
const Inventory = require("./helpers/Inventory.js");
const Sessions = require("./helpers/Sessions.js");

// Login errors where retrying immediately won't help - don't burn another attempt
const NO_RETRY_ERESULTS = new Set([
	SteamUser.EResult.RateLimitExceeded,
	SteamUser.EResult.AccountLoginDeniedThrottle
]);

const CONFIG_PATH = path.join(__dirname, "config.json");
const GAMES = {
	730: "Counter-Strike 2",
	440: "Team Fortress 2"
};

const HELP_TEXT = `Fake StatTrak - apply fake kills to StatTrak / Strange weapons in CS2 and TF2

Usage:
  node index.js            Interactive setup (recommended) - asks you everything
  node index.js --config   Run non-interactively using config.json
  node index.js --help      Show this help

Interactive mode walks you through the game, accounts (including Steam Guard
codes), the item to boost, the stat to change and the amount. See the README
for how to find an item ID and the full list of stats (event types).

Tip: exit Steam before running this to avoid VAC session errors (see README).`;

// prompts() resolves to {} when the user hits Ctrl+C; this makes that exit cleanly
const onCancel = () => {
	console.log("\nCancelled.");
	process.exit(0);
};

(async () => {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	let headless = process.argv.includes("--config") || process.argv.includes("-c");

	console.log("Validating protobufs...");
	if (!await ensureProtobufs()) {
		console.log("Failed to find or download protobufs. Check your internet connection and try again.");
		return;
	}

	let config;
	if (headless) {
		try {
			config = require(CONFIG_PATH);
		} catch (err) {
			console.log("Could not read config.json - run without --config to set things up interactively.");
			return;
		}

		let errors = validateConfig(config);
		if (errors.length) {
			console.log("Your config.json has the following problems:");
			errors.forEach(e => console.log("  - " + e));
			return;
		}
	} else {
		config = await gatherConfig();
	}

	await run(config, headless);
})().catch(handleFatalError);

// Turn the raw errors thrown by steam-user / the network into something readable
function handleFatalError(err) {
	process.exitCode = 1;

	let eresultName = err && typeof err.eresult === "number" ? SteamUser.EResult[err.eresult] : null;
	console.error("\nSomething went wrong: " + (err && err.message ? err.message : err));

	let throttleHint = [
		"Steam is temporarily blocking logins for this account/IP after too many attempts.",
		"This is a Steam limit, not a problem with this tool.",
		"- Stop running it for a while - each new attempt can RESET the wait (often 30+ minutes, sometimes hours).",
		"- Logging in from a different network (e.g. a phone hotspot) avoids the block, and the saved session means you only log in once.",
		"- If you've been using your email as the username, try your Steam account name instead."
	].join("\n");

	let hint = {
		InvalidPassword: "Steam rejected the login. Double-check the password, and if you're using your email as the username try your Steam account name instead.",
		RateLimitExceeded: throttleHint,
		AccountLoginDeniedThrottle: throttleHint,
		TwoFactorCodeMismatch: "The Steam Guard code didn't match. Make sure your phone's clock is correct and try again.",
		AccountDisabled: "This Steam account is disabled and can't be used."
	}[eresultName];

	if (hint) {
		console.error(hint);
	} else if (eresultName) {
		console.error("Steam returned: " + eresultName);
	}

	// Logged-in Steam clients keep the event loop alive, so force an exit once
	// the message has been written instead of hanging on a half-open session.
	setTimeout(() => process.exit(1), 500);
}

// ---------------------------------------------------------------------------
// Interactive setup
// ---------------------------------------------------------------------------

async function gatherConfig() {
	let saved = readSavedConfig();
	if (saved) {
		let { reuse } = await prompts({
			type: "confirm",
			name: "reuse",
			message: "A config.json was found. Use those saved settings?",
			initial: true
		}, { onCancel });
		if (reuse) {
			let errors = validateConfig(saved);
			if (!errors.length) {
				return saved;
			}
			console.log("Saved config is invalid, falling back to interactive setup:");
			errors.forEach(e => console.log("  - " + e));
		}
	}

	let { appID } = await prompts({
		type: "select",
		name: "appID",
		message: "Which game?",
		choices: Object.entries(GAMES).map(([id, name]) => ({ title: name, value: Number(id) }))
	}, { onCancel });

	let boostingAccount = await promptAccount("the account that OWNS the item (boosting account)", saved?.boostingAccount);
	let botAccount = await promptAccount("any second account to fill the server (bot account)", saved?.botAccount);

	let eventType = await promptEventType(appID);

	// A plain text field is much smoother to type into than the number prompt, and
	// it lets people paste values like "1,000,000".
	let { incrementRaw } = await prompts({
		type: "text",
		name: "incrementRaw",
		message: "How much do you want to add to the counter?",
		initial: "1",
		validate: (v) => parseAmount(v) ? true : "Enter a whole number greater than 0 (e.g. 1000 or 1,000,000)"
	}, { onCancel });
	let incrementValue = parseAmount(incrementRaw);

	let config = {
		boostingAccount,
		botAccount,
		appID,
		eventType,
		incrementValue,
		// itemID is resolved later via the inventory picker (needs the account logged in)
		itemID: null
	};

	return config;
}

async function promptAccount(label, previous) {
	let { username } = await prompts({
		type: "text",
		name: "username",
		message: `Login username for ${label} (the name you log into Steam with):`,
		initial: previous?.username || "",
		validate: (v) => v && v.trim().length ? true : "Username is required"
	}, { onCancel });

	if (username.includes("@")) {
		// Steam normally signs in with the account name rather than the email, but
		// don't block it - just flag it in case a failed login is down to this.
		console.log("Note: Steam usually signs in with your account name, not your email. If this login fails, try your Steam account name instead.");
	}

	let { password } = await prompts({
		type: "password",
		name: "password",
		message: `Password for ${username}:`,
		validate: (v) => v && v.length ? true : "Password is required"
	}, { onCancel });

	return { username: username.trim(), password };
}

async function promptEventType(appID) {
	let types = EventTypes[appID] || {};
	// Official-servers-only stats can't be increased from a fake server, so we
	// leave them out of the menu entirely (the same stats the old script refused).
	let choices = Object.entries(types)
		.filter(([, info]) => !info.officialOnly)
		.map(([id, info]) => ({
			title: `${id} - ${info.name}`,
			value: Number(id)
		}));

	let { eventType } = await prompts({
		type: "select",
		name: "eventType",
		message: "Which stat do you want to change?",
		choices,
		initial: 0
	}, { onCancel });

	return eventType;
}

// Resolve the item to boost. Tries the inventory picker first, falls back to a
// manual item-ID entry if the inventory is private / unavailable.
async function resolveItemID(steamID64, appID) {
	let items = null;
	try {
		console.log("Fetching your inventory...");
		items = await Inventory.getBoostableItems(steamID64, appID);
	} catch (err) {
		console.log(`Could not load inventory automatically (${err.message})`);
	}

	if (items && items.length) {
		let { itemID } = await prompts({
			type: "autocomplete",
			name: "itemID",
			message: `Pick the item to boost (${items.length} StatTrak/Strange items found, type to filter):`,
			choices: items.map(i => ({ title: i.name, value: i.itemID })),
			suggest: (input, choices) => Promise.resolve(
				choices.filter(c => c.title.toLowerCase().includes(input.toLowerCase()))
			)
		}, { onCancel });

		if (itemID) {
			return itemID;
		}
	} else if (items) {
		console.log("No StatTrak/Strange items were found in that inventory.");
	}

	let { itemID } = await prompts({
		type: "text",
		name: "itemID",
		message: "Enter the item ID to boost (see the README for how to find it):",
		validate: (v) => /^\d+$/.test((v || "").trim()) ? true : "Item ID must be a number"
	}, { onCancel });

	return itemID.trim();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Parse a user-entered amount, allowing thousands separators ("1,000,000").
// Returns a positive safe integer, or null if it isn't a valid amount.
function parseAmount(value) {
	let cleaned = String(value == null ? "" : value).replace(/[,_\s]/g, "");
	if (!/^\d+$/.test(cleaned)) {
		return null;
	}
	let number = Number(cleaned);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validateConfig(config) {
	let errors = [];

	if (!config || typeof config !== "object") {
		return ["Config is missing or not an object"];
	}

	if (!GAMES[config.appID]) {
		errors.push(`Unsupported appID "${config.appID}". Supported: ${Object.keys(GAMES).join(", ")}`);
	}

	for (let key of ["boostingAccount", "botAccount"]) {
		let acc = config[key];
		if (!acc || !acc.username || !acc.password) {
			errors.push(`${key} is missing a username and/or password`);
		}
	}

	if (typeof config.repeat === "number") {
		errors.push("'repeat' is no longer supported - remove it from your config");
	}
	if (typeof config.incrementValue !== "number" || !Number.isInteger(config.incrementValue) || config.incrementValue <= 0) {
		errors.push("'incrementValue' must be a whole number greater than 0");
	}
	if (config.itemID === null || config.itemID === undefined || !/^\d+$/.test(String(config.itemID))) {
		errors.push("'itemID' must be the numeric ID of the item to boost");
	}

	// Only check the event type if the appID is valid
	if (GAMES[config.appID]) {
		let info = EventTypes[config.appID]?.[config.eventType];
		if (!info) {
			errors.push(`Unknown eventType "${config.eventType}" for ${GAMES[config.appID]}`);
		} else if (info.officialOnly) {
			errors.push(`eventType "${info.name}" can only be increased on official Valve servers, so it won't work here`);
		}
	}

	return errors;
}

function readSavedConfig() {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return null;
	}
}

function offerToSaveConfig(config) {
	return prompts({
		type: "confirm",
		name: "save",
		message: "Save these settings to config.json for next time? (WARNING: stores passwords in plain text)",
		initial: false
	}, { onCancel }).then(({ save }) => {
		if (!save) {
			return;
		}
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "\t"));
		console.log("Saved to config.json. Re-run with 'node index.js --config' to skip the questions next time.");
	});
}

// ---------------------------------------------------------------------------
// Protobufs / progress
// ---------------------------------------------------------------------------

async function ensureProtobufs() {
	if (Helper.verifyProtobufs()) {
		console.log("Found protobufs!");
		return true;
	}

	console.log("Protobufs missing, downloading...");
	await Helper.downloadProtobufs(__dirname).catch((err) => console.error(err));
	return Helper.verifyProtobufs();
}

// Returns a function suitable for incrementKillCountAttribute's onProgress callback
function makeProgressBar(label) {
	let lastLength = 0;
	return (sent, total) => {
		let ratio = total > 0 ? Math.min(sent / total, 1) : 1;
		let width = 30;
		let filled = Math.round(ratio * width);
		let bar = "#".repeat(filled) + "-".repeat(width - filled);
		let line = `${label} [${bar}] ${(ratio * 100).toFixed(1)}%  ${sent.toLocaleString()} / ${total.toLocaleString()}`;
		let padding = line.length < lastLength ? " ".repeat(lastLength - line.length) : "";
		process.stdout.write("\r" + line + padding);
		lastLength = line.length;
		if (sent >= total) {
			process.stdout.write("\n");
		}
	};
}

// ---------------------------------------------------------------------------
// Steam Guard
// ---------------------------------------------------------------------------

async function steamGuardPrompt(domain, lastCodeWrong, username) {
	let where = domain ? `email sent to ${domain}` : "Steam Mobile authenticator app";
	let { code } = await prompts({
		type: "text",
		name: "code",
		message: `${lastCodeWrong ? "That code was wrong. " : ""}Steam Guard code for ${username} (from your ${where}):`,
		validate: (v) => v && v.trim().length ? true : "A Steam Guard code is required"
	}, { onCancel });
	return code;
}

// Log a client in, reusing a saved refresh token when possible so we don't have
// to re-enter the password / Steam Guard code (and don't trip Steam's throttling)
// on every run. Falls back to a normal credential login if there's no usable token.
async function loginWithSession(client, account) {
	let options = {
		onSteamGuard: steamGuardPrompt,
		onRefreshToken: (token) => Sessions.set(account.username, token)
	};

	let saved = Sessions.get(account.username);
	if (saved) {
		try {
			console.log(`Using saved session for ${account.username} (no password/Steam Guard needed)...`);
			await client.login(account.username, account.password, { ...options, refreshToken: saved });
			return;
		} catch (err) {
			if (NO_RETRY_ERESULTS.has(err && err.eresult)) {
				throw err; // Throttled/rate-limited - keep the token, retrying won't help right now
			}
			Sessions.remove(account.username);
			console.log(`Saved session for ${account.username} no longer works - logging in with the password instead.`);
		}
	}

	await client.login(account.username, account.password, options);
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function run(config, headless) {
	let Server = require("./components/Server_" + config.appID + ".js");
	let Client = require("./components/Client_" + config.appID + ".js");

	console.log(`\nStarting up for ${GAMES[config.appID]}...`);
	let server = new Server();
	let clients = [
		new Client(), // bot
		new Client()  // boosting (owns the item)
	];

	console.log("Logging into the boosting account...");
	await loginWithSession(clients[1], config.boostingAccount);
	console.log("Logged in as " + clients[1].steamID.getSteamID64());

	// Resolve the item to boost now that the owning account is logged in
	if (!config.itemID) {
		config.itemID = await resolveItemID(clients[1].steamID.getSteamID64(), config.appID);
	}

	console.log("Logging into the bot account and the fake server...");
	await loginWithSession(clients[0], config.botAccount);
	let serverID = await server.login();
	console.log("Bot logged in as " + clients[0].steamID.getSteamID64());
	console.log("Fake server logged in as " + server.steamID.getSteamID64());

	for (let i = 0; i < clients.length; i++) {
		let ticket = await clients[i].generateTicket();
		console.log("Joining the fake server with " + clients[i].steamID.getSteamID64() + "...");
		await server.addPlayer(clients[i].steamID, ticket);
		await clients[i].joinServer(serverID, ticket);
	}
	console.log("Both accounts are connected to the fake server!");

	if (!headless) {
		let info = EventTypes[config.appID][config.eventType];
		console.log("");
		console.log("About to apply:");
		console.log(`  Game:    ${GAMES[config.appID]}`);
		console.log(`  Item ID: ${config.itemID}`);
		console.log(`  Stat:    ${info.name} (+${config.incrementValue.toLocaleString()})`);
		let { go } = await prompts({
			type: "confirm",
			name: "go",
			message: "Proceed?",
			initial: true
		}, { onCancel });
		if (!go) {
			server.logOff();
			clients.forEach(c => c.logOff());
			console.log("Aborted, nothing was changed.");
			setTimeout(process.exit, 1000, 0).unref();
			return;
		}
	}

	// A little delay just to make sure its all set and data has been received
	await new Promise(p => setTimeout(p, 1000));

	await server.incrementKillCountAttribute(
		clients[1].steamID,
		clients[0].steamID,
		config.itemID,
		config.eventType,
		config.incrementValue,
		makeProgressBar("Sending")
	);

	console.log("Item increments are now being processed by Valve. Depending on how much you incremented your item by this can take a while.");
	console.log("It is not guaranteed that all increments will get processed by the end of this delay.");
	console.log("Your inventory may be inaccessible for a few minutes.");

	if (!headless) {
		await offerToSaveConfig(config);
	}

	// Random number: 2s per 200K (1M = 10s)
	let secondDelay = 2 * Math.ceil(config.incrementValue / 200_000);

	console.log(`\nLogging off in ${secondDelay} seconds... (You can exit early by closing the command prompt)`);
	console.log(`You can view your item here: https://steamcommunity.com/profiles/${clients[1].steamID.getSteamID64()}/inventory/#${config.appID}_2_${config.itemID}`);
	console.log("If the item does not show in your inventory using the link above you might have entered the wrong ItemID.");
	setTimeout(() => {
		server.logOff();
		clients.forEach(c => c.logOff());

		console.log("Successfully logged off");

		// Something somewhere keeps the event loop alive and we never exit. So we just kill the process after a bit
		setTimeout(process.exit, 5000, 0).unref();
	}, secondDelay * 1000);
}
