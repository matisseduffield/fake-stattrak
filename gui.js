const { startServer } = require("./gui/server.js");

startServer().catch((err) => {
	console.error("Failed to start the GUI:", err);
	process.exit(1);
});
