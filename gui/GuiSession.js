const EventEmitter = require("events");
const SteamUser = require("steam-user");
const EventTypes = require("../helpers/EventTypes.js");
const Inventory = require("../helpers/Inventory.js");
const Sessions = require("../helpers/Sessions.js");
const Accounts = require("../helpers/Accounts.js");

const GAMES = {
	730: "Counter-Strike 2",
	440: "Team Fortress 2"
};
const NO_RETRY_ERESULTS = new Set([
	SteamUser.EResult.RateLimitExceeded,
	SteamUser.EResult.AccountLoginDeniedThrottle
]);

// Holds all the state for one browser session driving the tool: the Steam
// connection, the inventory, the job queue and the live log. The web server
// turns HTTP requests into method calls here and streams `event` emissions back
// to the browser over SSE.
module.exports = class GuiSession extends EventEmitter {
	constructor() {
		super();
		this.setMaxListeners(0);
		this._reset();
	}

	_reset() {
		this.appID = null;
		this.server = null;
		this.clients = null; // [bot, boosting]
		this.boosting = null; // { username, steamID }
		this.bot = null;      // { username, steamID }
		this.connected = false;
		this.connecting = false;
		this.inventory = [];
		this.inventoryError = null;
		this.jobs = [];
		this._jobSeq = 0;
		this.running = false;
		this.stopRequested = false;
		this.pendingGuard = null; // { username, domain }
		this._guardResolve = null;
		this.lastError = null;
	}

	// ----- outbound events -------------------------------------------------

	log(message, level = "info") {
		this.emit("event", { type: "log", level, message, time: Date.now() });
	}

	pushState() {
		this.emit("event", { type: "state", state: this.snapshot() });
	}

	snapshot() {
		return {
			connected: this.connected,
			connecting: this.connecting,
			running: this.running,
			appID: this.appID,
			game: this.appID ? GAMES[this.appID] : null,
			boosting: this.boosting,
			bot: this.bot,
			inventory: this.inventory,
			inventoryError: this.inventoryError,
			jobs: this.jobs,
			pendingGuard: this.pendingGuard,
			accounts: Accounts.list(),
			lastError: this.lastError
		};
	}

	// ----- Steam Guard -----------------------------------------------------

	submitGuard(code) {
		if (!this._guardResolve) {
			return false;
		}
		let resolve = this._guardResolve;
		this._guardResolve = null;
		this.pendingGuard = null;
		this.pushState();
		resolve(code);
		return true;
	}

	_promptGuard(domain, lastCodeWrong, username) {
		return new Promise((resolve) => {
			this._guardResolve = resolve;
			this.pendingGuard = { username, domain: domain || null, lastCodeWrong: !!lastCodeWrong };
			this.log(`Steam Guard code needed for ${username}${domain ? ` (emailed to ${domain})` : " (mobile authenticator)"}.`, "warn");
			this.pushState();
		});
	}

	// ----- connect / login -------------------------------------------------

	async connect({ appID, boosting, bot, force }) {
		if (this.connecting || this.connected) {
			throw new Error("Already connected or connecting. Disconnect first.");
		}
		appID = Number(appID);
		if (!GAMES[appID]) {
			throw new Error("Pick a supported game first.");
		}
		if (!boosting || !boosting.username || !bot || !bot.username) {
			throw new Error("Both accounts need a username.");
		}

		// Respect the throttle cooldown unless the user forces it
		for (let acc of [boosting, bot]) {
			let remaining = Sessions.throttleRemainingMs(acc.username);
			if (remaining > 0 && !force) {
				throw new Error(`${acc.username} is in a login cooldown after a Steam throttle. Try again in about ${Math.ceil(remaining / 60000)} minute(s), or use "Force".`);
			}
		}

		this.connecting = true;
		this.lastError = null;
		this.appID = appID;
		this.pushState();

		try {
			let Server = require("../components/Server_" + appID + ".js");
			let Client = require("../components/Client_" + appID + ".js");

			this.server = new Server();
			this.clients = [new Client(), new Client()]; // [bot, boosting]

			this.log(`Logging into the boosting account ${boosting.username}...`);
			await this._loginAccount(this.clients[1], boosting, force);
			this.boosting = { username: boosting.username, steamID: this.clients[1].steamID.getSteamID64() };
			Accounts.save(boosting);
			this.log(`Boosting account logged in as ${this.boosting.steamID}.`, "success");
			this.pushState();

			this.log(`Logging into the bot account ${bot.username} and the fake server...`);
			await this._loginAccount(this.clients[0], bot, force);
			this.bot = { username: bot.username, steamID: this.clients[0].steamID.getSteamID64() };
			Accounts.save(bot);
			let serverID = await this.server.login();
			this.log(`Bot logged in as ${this.bot.steamID}; fake server as ${this.server.steamID.getSteamID64()}.`, "success");

			for (let i = 0; i < this.clients.length; i++) {
				let ticket = await this.clients[i].generateTicket();
				await this.server.addPlayer(this.clients[i].steamID, ticket);
				await this.clients[i].joinServer(serverID, ticket);
			}
			this.log("Both accounts are connected to the fake server.", "success");

			this.connected = true;
			this.connecting = false;
			this.pushState();

			await this.loadInventory();
		} catch (err) {
			this.connecting = false;
			this.lastError = this._friendlyError(err);
			this.log(this.lastError, "error");
			await this._teardownClients();
			this.pushState();
			throw err;
		}
	}

	async _loginAccount(client, account, force) {
		let options = {
			onSteamGuard: (domain, lastCodeWrong, username) => this._promptGuard(domain, lastCodeWrong, username),
			onRefreshToken: (token) => Sessions.setToken(account.username, token)
		};

		let attempt = async (extra) => {
			try {
				await client.login(account.username, account.password, { ...options, ...extra });
				Sessions.clearThrottle(account.username);
			} catch (err) {
				if (NO_RETRY_ERESULTS.has(err && err.eresult)) {
					Sessions.markThrottled(account.username);
				}
				throw err;
			}
		};

		let saved = Sessions.getToken(account.username);
		if (saved) {
			try {
				this.log(`Using saved session for ${account.username} (no password/Steam Guard needed).`);
				await attempt({ refreshToken: saved });
				return;
			} catch (err) {
				if (NO_RETRY_ERESULTS.has(err && err.eresult)) {
					throw err;
				}
				Sessions.removeToken(account.username);
				this.log(`Saved session for ${account.username} expired - using the password instead.`, "warn");
			}
		}

		if (!account.password) {
			throw new Error(`No saved session for ${account.username} and no password was provided.`);
		}
		await attempt({});
	}

	// ----- inventory -------------------------------------------------------

	async loadInventory() {
		if (!this.connected || !this.boosting) {
			return;
		}
		this.inventoryError = null;
		this.log("Fetching inventory...");
		try {
			this.inventory = await Inventory.getBoostableItems(this.boosting.steamID, this.appID);
			this.log(`Found ${this.inventory.length} StatTrak/Strange item(s).`, this.inventory.length ? "success" : "warn");
		} catch (err) {
			this.inventory = [];
			this.inventoryError = err.message;
			this.log(`Could not load inventory: ${err.message}. You can still add items by ID.`, "warn");
		}
		this.pushState();
	}

	// ----- job queue -------------------------------------------------------

	addJob({ itemID, itemName, eventType, amount }) {
		itemID = String(itemID || "").trim();
		amount = Number(amount);
		eventType = Number(eventType);
		if (!/^\d+$/.test(itemID)) {
			throw new Error("Item ID must be a number.");
		}
		if (!Number.isInteger(amount) || amount <= 0) {
			throw new Error("Amount must be a whole number greater than 0.");
		}
		if (amount > 2147483647) {
			throw new Error("Amount is too large (max 2,147,483,647 - a StatTrak counter is a 32-bit integer).");
		}
		if (!this.appID || !EventTypes[this.appID]?.[eventType]) {
			throw new Error("Pick a valid stat.");
		}
		if (EventTypes[this.appID][eventType].officialOnly) {
			throw new Error("That stat only counts on official Valve servers.");
		}

		let job = {
			id: ++this._jobSeq,
			itemID,
			itemName: itemName || `Item ${itemID}`,
			eventType,
			statName: EventTypes[this.appID][eventType].name,
			amount,
			sent: 0,
			status: "queued",
			error: null
		};
		this.jobs.push(job);
		this.pushState();
		return job;
	}

	removeJob(id) {
		id = Number(id);
		let job = this.jobs.find(j => j.id === id);
		if (job && job.status === "running") {
			throw new Error("Can't remove a job that's currently running. Stop it first.");
		}
		this.jobs = this.jobs.filter(j => j.id !== id);
		this.pushState();
	}

	clearFinishedJobs() {
		this.jobs = this.jobs.filter(j => j.status === "queued" || j.status === "running");
		this.pushState();
	}

	stop() {
		if (this.running) {
			this.stopRequested = true;
			this.log("Stop requested - finishing the current batch and halting...", "warn");
		}
	}

	async runJobs() {
		if (this.running) {
			throw new Error("Jobs are already running.");
		}
		if (!this.connected) {
			throw new Error("Not connected to Steam.");
		}
		if (!this.jobs.some(j => j.status === "queued")) {
			throw new Error("No queued jobs to run.");
		}

		this.running = true;
		this.stopRequested = false;
		this.pushState();
		this.log("Starting job queue...");

		// Small settle delay so the GC has finished receiving our session data
		// before the first batch (mirrors the CLI flow).
		await new Promise(p => setTimeout(p, 1000));

		try {
			for (let job of this.jobs) {
				if (this.stopRequested || !this.connected) {
					break;
				}
				if (job.status !== "queued") {
					continue;
				}

				job.status = "running";
				job.sent = 0;
				this.pushState();
				this.log(`Boosting "${job.itemName}" - ${job.statName} +${job.amount.toLocaleString()}`);

				// Stop if the user asked to, or if we got disconnected mid-job
				let shouldStop = () => this.stopRequested || !this.connected;

				try {
					let stopped = await this.server.incrementKillCountAttribute(
						this.clients[1].steamID,
						this.clients[0].steamID,
						job.itemID,
						job.eventType,
						job.amount,
						(sent) => { job.sent = sent; this.emit("event", { type: "progress", jobId: job.id, sent, total: job.amount }); },
						shouldStop
					);

					if (stopped) {
						job.status = "stopped";
						this.log(`Stopped "${job.itemName}" at ${job.sent.toLocaleString()} / ${job.amount.toLocaleString()}.`, "warn");
					} else {
						job.sent = job.amount;
						job.status = "done";
						this.log(`Done "${job.itemName}".`, "success");
					}
				} catch (err) {
					job.status = "error";
					job.error = err.message;
					this.log(`Failed "${job.itemName}": ${err.message}`, "error");
				}
				this.pushState();
			}
		} finally {
			this.running = false;
			this.stopRequested = false;
			this.pushState();
			// Don't claim success if we bailed out because the user disconnected
			if (this.connected) {
				this.log("Job queue finished. Valve may take a few minutes to process the changes.", "success");
			}
		}
	}

	// ----- disconnect ------------------------------------------------------

	async disconnect() {
		this.log("Disconnecting...");
		this.stopRequested = true;
		await this._teardownClients();
		let accounts = Accounts.list();
		this._reset();
		this.pushState();
		this.log("Disconnected.");
		return accounts;
	}

	async _teardownClients() {
		try { this.server && this.server.logOff(); } catch { /* ignore */ }
		try { this.clients && this.clients.forEach(c => c.logOff()); } catch { /* ignore */ }
		this.server = null;
		this.clients = null;
		this.connected = false;
		this.boosting = null;
		this.bot = null;
		this.inventory = [];
	}

	_friendlyError(err) {
		let name = err && typeof err.eresult === "number" ? SteamUser.EResult[err.eresult] : null;
		let map = {
			InvalidPassword: "Steam rejected the login. Check the password, and use your Steam account name (not your email) as the username.",
			RateLimitExceeded: "Steam is throttling logins for this account after too many attempts. Wait a while before trying again.",
			AccountLoginDeniedThrottle: "Steam is throttling logins for this account after too many attempts. Wait a while before trying again (changing IP won't help - it's account-based).",
			TwoFactorCodeMismatch: "That Steam Guard code didn't match. Check your phone's clock and try again.",
			AccountDisabled: "This Steam account is disabled."
		};
		return map[name] || (err && err.message) || String(err);
	}
};
