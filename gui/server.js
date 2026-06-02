const path = require("path");
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
	return new Promise((resolve) => {
		let serverInstance = app.listen(port, () => {
			console.log("");
			console.log("  Fake StatTrak GUI is running!");
			console.log(`  Open this in your browser:  http://localhost:${port}`);
			console.log("");
			console.log("  (Remember to exit/log out of Steam first - see the README.)");
			resolve(serverInstance);
		});
	});
}

module.exports = { createApp, startServer };
