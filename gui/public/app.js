// ---- helpers ----
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
	let n = Object.assign(document.createElement(tag), props);
	for (let k of kids) n.append(k);
	return n;
};
const api = async (method, url, body) => {
	let res = await fetch(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	let data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
};
const fmt = (n) => Number(n).toLocaleString();

let GAMES = [];
let state = null;
let selectedItem = null; // for the job dialog

// ---- boot ----
(async () => {
	let { games } = await api("GET", "/api/games");
	GAMES = games;
	$("#gameSelect").append(...games.map(g => el("option", { value: g.appID, textContent: g.name })));
	$("#gameSelect").onchange = () => { if (!state || !state.connected) renderAccountFields(); };
	renderAccountFields();
	wireEvents();
	connectStream();
})();

function connectStream() {
	let es = new EventSource("/api/events");
	es.onmessage = (e) => {
		let ev = JSON.parse(e.data);
		if (ev.type === "state") { state = ev.state; render(); }
		else if (ev.type === "log") appendLog(ev);
		else if (ev.type === "progress") updateProgress(ev);
	};
}

// ---- render ----
function render() {
	if (!state) return;

	// status pill
	let pill = $("#statusPill"), dot = $("#statusDot"), txt = $("#statusText");
	pill.className = "status";
	if (state.running) { pill.classList.add("running"); txt.textContent = "Boosting..."; }
	else if (state.connected) { pill.classList.add("connected"); txt.textContent = "Connected"; }
	else if (state.connecting) { pill.classList.add("connecting"); txt.textContent = "Connecting..."; }
	else txt.textContent = "Disconnected";

	// error banner
	let banner = $("#errorBanner");
	if (state.lastError && !state.connected) { banner.textContent = state.lastError; banner.classList.remove("hidden"); }
	else banner.classList.add("hidden");

	// which card
	$("#connectCard").classList.toggle("hidden", state.connected || state.connecting);
	$("#connectedCard").classList.toggle("hidden", !state.connected);
	$("#queueCard").classList.toggle("hidden", !state.connected);

	$("#connectBtn").disabled = state.connecting;
	$("#connectBtn").textContent = state.connecting ? "Connecting..." : "Connect";

	if (state.connected) {
		$("#connectedGame").textContent = state.game;
		$("#connectedAccounts").textContent =
			`Boosting: ${state.boosting?.username} · Bot: ${state.bot?.username}`;
		renderInventory();
		renderQueue();
	}

	// steam guard
	if (state.pendingGuard) {
		let g = state.pendingGuard;
		$("#guardText").textContent =
			(g.lastCodeWrong ? "That code was wrong. " : "") +
			`Enter the Steam Guard code for ${g.username} ` +
			(g.domain ? `(emailed to ${g.domain}).` : "(from your mobile authenticator).");
		$("#guardDialog").classList.remove("hidden");
		$("#guardCode").focus();
	} else {
		$("#guardDialog").classList.add("hidden");
		$("#guardCode").value = "";
	}

	refreshAccountBadges();
}

function currentGame() {
	let appID = Number($("#gameSelect").value);
	return GAMES.find(g => g.appID === appID) || GAMES[0];
}

function renderAccountFields() {
	for (let role of ["boosting", "bot"]) {
		let wrap = document.querySelector(`.account-fields[data-role="${role}"]`);
		wrap.innerHTML = "";
		let accounts = (state && state.accounts) || [];

		let select = el("select", { className: "acc-select" });
		select.append(el("option", { value: "", textContent: "+ New account..." }));
		for (let a of accounts) select.append(el("option", { value: a.username, textContent: a.username }));

		let username = el("input", { type: "text", className: "acc-username", placeholder: "Steam account name" });
		let password = el("input", { type: "password", className: "acc-password", placeholder: "Password" });
		let remember = el("label", { className: "checkbox" });
		let rememberBox = el("input", { type: "checkbox", className: "acc-remember" });
		remember.append(rememberBox, document.createTextNode(" Remember password"));
		let badges = el("div", { className: "account-badges" });

		select.onchange = () => {
			username.value = select.value;
			let acc = accounts.find(a => a.username === select.value);
			password.placeholder = acc && acc.hasSession ? "Saved session - leave blank" : "Password";
			renderBadges(badges, acc);
		};

		wrap.append(select, el("label", { textContent: "Username" }, username),
			el("label", { textContent: "Password" }, password), remember, badges);
	}
}

function renderBadges(container, acc) {
	container.innerHTML = "";
	if (!acc) return;
	if (acc.hasSession) container.append(el("span", { className: "pill session", textContent: "saved session" }));
	if (acc.throttleRemainingMs > 0) container.append(el("span", { className: "pill cooldown", textContent: `cooldown ${Math.ceil(acc.throttleRemainingMs / 60000)}m` }));
}

function refreshAccountBadges() {
	// keep dropdown options in sync after connect/disconnect without nuking typed input
	if (state && !state.connected) {
		for (let role of ["boosting", "bot"]) {
			let wrap = document.querySelector(`.account-fields[data-role="${role}"]`);
			let select = wrap.querySelector(".acc-select");
			let current = select.value;
			let accounts = (state.accounts) || [];
			select.innerHTML = "";
			select.append(el("option", { value: "", textContent: "+ New account..." }));
			for (let a of accounts) select.append(el("option", { value: a.username, textContent: a.username }));
			select.value = current;
		}
	}
}

function readAccount(role) {
	let wrap = document.querySelector(`.account-fields[data-role="${role}"]`);
	return {
		username: wrap.querySelector(".acc-username").value.trim(),
		password: wrap.querySelector(".acc-password").value,
		remember: wrap.querySelector(".acc-remember").checked
	};
}

// ---- inventory ----
function renderInventory() {
	$("#invMessage").textContent = state.inventoryError
		? `${state.inventoryError}`
		: (state.inventory.length ? `${state.inventory.length} item(s)` : "No StatTrak/Strange items found - add one by ID below.");

	let filter = $("#invSearch").value.toLowerCase();
	let grid = $("#inventoryGrid");
	grid.innerHTML = "";
	for (let item of state.inventory) {
		if (filter && !item.name.toLowerCase().includes(filter)) continue;
		let card = el("div", { className: "item", title: item.name });
		if (item.iconUrl) card.append(el("img", { src: item.iconUrl, loading: "lazy", alt: "" }));
		card.append(el("div", { className: "name", textContent: item.name, style: item.color ? `color:${item.color}` : "" }));
		card.append(el("div", { className: "meta" },
			el("span", { className: "badge", textContent: "StatTrak" }),
			document.createTextNode(item.count != null ? ` ${fmt(item.count)}` : "")));
		card.onclick = () => openJobDialog(item);
		grid.append(card);
	}
}

// ---- job dialog ----
function openJobDialog(item) {
	selectedItem = item;
	$("#jobDialogTitle").textContent = `Add: ${item.name}`;
	let img = $("#jobDialogImg");
	if (item.iconUrl) { img.src = item.iconUrl; img.classList.remove("hidden"); } else img.classList.add("hidden");

	let stat = $("#jobStat");
	stat.innerHTML = "";
	for (let s of currentGame().stats) stat.append(el("option", { value: s.eventType, textContent: s.name }));
	$("#jobAmount").value = "1000";
	$("#jobDialog").classList.remove("hidden");
	$("#jobAmount").focus();
}

function parseAmount(v) {
	let c = String(v).replace(/[,_\s]/g, "");
	return /^\d+$/.test(c) && Number(c) > 0 ? Number(c) : null;
}

// ---- queue ----
function renderQueue() {
	let list = $("#queueList");
	list.innerHTML = "";
	if (!state.jobs.length) { list.append(el("div", { className: "empty", textContent: "No jobs yet. Pick an item above." })); }
	for (let job of state.jobs) {
		let row = el("div", { className: "job" });
		let top = el("div", { className: "job-top" });
		top.append(
			el("div", {},
				el("div", { className: "job-name", textContent: job.itemName }),
				el("div", { className: "job-sub", textContent: `${job.statName} · +${fmt(job.amount)}` })),
			el("div", { style: "text-align:right" },
				el("div", { className: `state ${job.status}`, textContent: job.status }),
				job.status === "queued" || job.status === "error"
					? el("button", { className: "job-x", textContent: "×", onclick: () => api("DELETE", `/api/jobs/${job.id}`).catch(showError) })
					: document.createTextNode(""))
		);
		row.append(top);
		let bar = el("div", { className: "bar" });
		let fill = el("div", { id: `bar-${job.id}`, style: `width:${job.amount ? (job.sent / job.amount * 100) : 0}%` });
		bar.append(fill);
		row.append(bar);
		if (job.error) row.append(el("div", { className: "job-sub", style: "color:var(--red);margin-top:6px", textContent: job.error }));
		list.append(row);
	}

	let running = state.running;
	$("#runBtn").classList.toggle("hidden", running);
	$("#stopBtn").classList.toggle("hidden", !running);
	$("#runBtn").disabled = !state.jobs.some(j => j.status === "queued");
}

function updateProgress(ev) {
	let fill = document.getElementById(`bar-${ev.jobId}`);
	if (fill) fill.style.width = `${ev.total ? (ev.sent / ev.total * 100) : 0}%`;
}

// ---- log ----
function appendLog(ev) {
	let log = $("#log");
	let atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
	let t = new Date(ev.time).toLocaleTimeString();
	log.append(el("div", { className: "line" },
		el("span", { className: "time", textContent: `[${t}] ` }),
		el("span", { className: ev.level, textContent: ev.message })));
	if (atBottom) log.scrollTop = log.scrollHeight;
}

function showError(err) {
	let banner = $("#errorBanner");
	banner.textContent = err.message || String(err);
	banner.classList.remove("hidden");
	setTimeout(() => banner.classList.add("hidden"), 6000);
}

// ---- wiring ----
function wireEvents() {
	$("#connectBtn").onclick = () => {
		$("#errorBanner").classList.add("hidden");
		api("POST", "/api/connect", {
			appID: Number($("#gameSelect").value),
			boosting: readAccount("boosting"),
			bot: readAccount("bot"),
			force: $("#forceConnect").checked
		}).catch(showError);
	};
	$("#disconnectBtn").onclick = () => api("POST", "/api/disconnect").catch(showError);
	$("#refreshInvBtn").onclick = () => api("POST", "/api/inventory/refresh").catch(showError);
	$("#invSearch").oninput = () => state && renderInventory();

	$("#manualSelectBtn").onclick = () => {
		let id = $("#manualItemId").value.trim();
		if (!/^\d+$/.test(id)) return showError(new Error("Item ID must be numbers only."));
		openJobDialog({ itemID: id, name: `Item ${id}`, iconUrl: null });
	};

	$("#jobCancel").onclick = () => $("#jobDialog").classList.add("hidden");
	$("#jobAdd").onclick = () => {
		let amount = parseAmount($("#jobAmount").value);
		if (!amount) return showError(new Error("Enter a whole number greater than 0."));
		api("POST", "/api/jobs", {
			itemID: selectedItem.itemID,
			itemName: selectedItem.name,
			eventType: Number($("#jobStat").value),
			amount
		}).then(() => $("#jobDialog").classList.add("hidden")).catch(showError);
	};

	$("#runBtn").onclick = () => api("POST", "/api/jobs/run").catch(showError);
	$("#stopBtn").onclick = () => api("POST", "/api/jobs/stop").catch(showError);
	$("#clearFinishedBtn").onclick = () => api("POST", "/api/jobs/clear-finished").catch(showError);

	$("#guardSubmit").onclick = () => {
		let code = $("#guardCode").value.trim();
		if (code) api("POST", "/api/steamguard", { code }).catch(showError);
	};
	$("#guardCode").onkeydown = (e) => { if (e.key === "Enter") $("#guardSubmit").click(); };
	$("#jobAmount").onkeydown = (e) => { if (e.key === "Enter") $("#jobAdd").click(); };
}
