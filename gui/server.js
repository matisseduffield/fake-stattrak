const path = require("path");
const http = require("http");
const express = require("express");
const Helper = require("../helpers/Helper.js");
const EventTypes = require("../helpers/EventTypes.js");
const Accounts = require("../helpers/Accounts.js");
const GuiSession = require("./GuiSession.js");

const GAMES = {
	730: "Counter-Strike 2",
	440: "Team Fortress 2"
};

// Build the Express app around a single GuiSession (one browser drives the tool).
function createApp(session = new GuiSession()) {
	let app = express();
	app.use(express.json());

	// This server can log into Steam accounts, so lock it down. Two defenses:
	//  1. Host check: every request's Host must be loopback. This blocks DNS
	//     rebinding, where a malicious page's domain is repointed at 127.0.0.1 but
	//     the browser still sends the attacker's hostname in the Host header.
	//  2. Origin check on state-changing requests (CSRF): same-origin requests from
	//     the GUI send an Origin of http(s)://localhost - cross-origin ones are blocked.
	let loopbackHost = (header) => {
		if (!header) {
			return false;
		}
		let hostname = (() => { try { return new URL(`http://${header}`).hostname; } catch { return null; } })();
		return ["localhost", "127.0.0.1", "::1"].includes(hostname);
	};
	app.use((req, res, next) => {
		if (!loopbackHost(req.headers.host)) {
			return res.status(403).json({ error: "Host not allowed (this server only accepts loopback requests)." });
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			let origin = req.headers.origin;
			let originHost = origin ? (() => { try { return new URL(origin).hostname; } catch { return null; } })() : null;
			if (origin && !["localhost", "127.0.0.1", "::1"].includes(originHost)) {
				return res.status(403).json({ error: "Cross-origin request blocked." });
			}
		}
		next();
	});

	app.use(express.static(path.join(__dirname, "public")));

	// Small wrapper so async handlers report errors as JSON instead of crashing
	let handle = (fn) => (req, res) => {
		Promise.resolve(fn(req, res)).catch((err) => {
			if (!res.headersSent) {
				res.status(400).json({ error: err.message || String(err) });
			}
		});
	};

	// Reference data: games + their usable stats (official-only stats excluded)
	app.get("/api/games", (req, res) => {
		let games = Object.entries(GAMES).map(([id, name]) => ({
			appID: Number(id),
			name,
			stats: Object.entries(EventTypes[id] || {})
				.filter(([, info]) => !info.officialOnly)
				.map(([eventType, info]) => ({ eventType: Number(eventType), name: info.name }))
		}));
		res.json({ games });
	});

	app.get("/api/state", (req, res) => res.json(session.snapshot()));

	app.get("/api/accounts", (req, res) => res.json({ accounts: Accounts.list() }));

	app.delete("/api/accounts/:username", (req, res) => {
		Accounts.remove(req.params.username);
		session.pushState();
		res.json({ ok: true });
	});

	// Kick off the connect/login flow; progress + errors stream over /api/events
	app.post("/api/connect", handle(async (req, res) => {
		res.json({ ok: true });
		session.connect(req.body || {}).catch(() => { /* already surfaced via events */ });
	}));

	app.post("/api/disconnect", handle(async (req, res) => {
		await session.disconnect();
		res.json({ ok: true });
	}));

	app.post("/api/steamguard", handle(async (req, res) => {
		let accepted = session.submitGuard(String((req.body || {}).code || "").trim());
		res.json({ ok: accepted });
	}));

	app.post("/api/inventory/refresh", handle(async (req, res) => {
		res.json({ ok: true });
		session.loadInventory();
	}));

	app.post("/api/jobs", handle(async (req, res) => {
		let job = session.addJob(req.body || {});
		res.json({ job });
	}));

	app.delete("/api/jobs/:id", handle(async (req, res) => {
		session.removeJob(req.params.id);
		res.json({ ok: true });
	}));

	app.post("/api/jobs/clear-finished", handle(async (req, res) => {
		session.clearFinishedJobs();
		res.json({ ok: true });
	}));

	app.post("/api/jobs/run", handle(async (req, res) => {
		res.json({ ok: true });
		session.runJobs().catch(() => { /* surfaced via events */ });
	}));

	app.post("/api/jobs/stop", handle(async (req, res) => {
		session.stop();
		res.json({ ok: true });
	}));

	// Server-sent events: live log, state and per-job progress
	app.get("/api/events", (req, res) => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive"
		});
		res.write("retry: 2000\n\n");

		let send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
		send({ type: "state", state: session.snapshot() });

		let onEvent = (event) => send(event);
		session.on("event", onEvent);

		let heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

		req.on("close", () => {
			clearInterval(heartbeat);
			session.removeListener("event", onEvent);
		});
	});

	return app;
}

async function startServer(port = Number(process.env.PORT) || 3000) {
	console.log("Validating protobufs...");
	if (!Helper.verifyProtobufs()) {
		console.log("Protobufs missing, downloading...");
		await Helper.downloadProtobufs(path.join(__dirname, "..")).catch((err) => console.error(err));
		if (!Helper.verifyProtobufs()) {
			console.log("Failed to download protobufs. Check your internet connection and try again.");
			return;
		}
	}
	console.log("Found protobufs!");

	let app = createApp();

	// Bind to loopback only (never expose Steam logins to the network). We bind
	// both IPv4 and IPv6 loopback so "localhost" works regardless of how it
	// resolves on the user's machine; the IPv6 bind is best-effort.
	let printed = false;
	let announce = () => {
		if (printed) {
			return;
		}
		printed = true;
		console.log("");
		console.log("  Fake StatTrak GUI is running!");
		console.log(`  Open this in your browser:  http://localhost:${port}`);
		console.log("");
		console.log("  (Remember to exit/log out of Steam first - see the README.)");
	};

	let bind = (host) => new Promise((resolve) => {
		let s = http.createServer(app);
		s.on("error", (err) => resolve({ host, error: err }));
		s.listen(port, host, () => { announce(); resolve({ host, server: s }); });
	});

	let [v4, v6] = await Promise.all([bind("127.0.0.1"), bind("::1")]);
	let bound = [v4, v6].filter((r) => r.server);

	if (!bound.length) {
		let err = v4.error || v6.error;
		if (err && err.code === "EADDRINUSE") {
			console.log(`Port ${port} is already in use. Try PORT=<other> npm run gui.`);
		} else {
			console.log(`Failed to start the GUI on port ${port}${err ? `: ${err.message}` : ""}.`);
		}
		return null;
	}
	if (!v4.server) {
		// IPv6 came up but IPv4 didn't - "localhost" commonly resolves to IPv4, so warn
		console.log(`Note: couldn't bind 127.0.0.1 (${(v4.error && v4.error.code) || "unknown"}); only IPv6 [::1] is listening.`);
		console.log(`If http://localhost:${port} doesn't load, try http://[::1]:${port} instead.`);
	}
	return bound.map((r) => r.server);
}

module.exports = { createApp, startServer };
