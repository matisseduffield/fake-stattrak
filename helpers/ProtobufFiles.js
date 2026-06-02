const path = require("path");

const root = path.join(__dirname, "..", "protobufs");
const p = (file) => path.join(root, file);

// We only load the handful of entry-point .proto files we actually use and let
// protobufjs follow their `import` statements to pull in dependencies. Loading
// the entire protobufs directory works too, but parses 40+ unrelated files and
// takes ~60 seconds per Steam connection - this curated set loads in well under
// a second while still resolving every message/enum the tool references.
const steam = [
	"steam/enums_clientserver.proto",                  // EMsg enum
	"steam/steammessages_clientserver.proto",          // CMsgClientAuthList(Ack), CMsgClientConnectionStats
	"steam/steammessages_clientserver_gameservers.proto" // CMsgGSServerType, CMsgGameServerData, ...
].map(p);

module.exports = {
	steam,
	app: {
		440: {
			name: "tf2",
			protos: [
				"tf2/gcsystemmsgs.proto",   // EGCBaseClientMsg, ESOMsg
				"tf2/gcsdk_gcmessages.proto", // CMsgClientHello/ServerHello/Welcome, SO messages
				"tf2/base_gcmessages.proto",  // CMsgIncrementKillCountAttribute(_Multiple)
				"tf2/econ_gcmessages.proto",  // EGCItemMsg
				"tf2/tf_gcmessages.proto"     // ETFGCMsg, CMsgTFClientInit, ...
			].map(p)
		},
		730: {
			name: "csgo",
			protos: [
				"csgo/gcsystemmsgs.proto",
				"csgo/gcsdk_gcmessages.proto",
				"csgo/base_gcmessages.proto",
				"csgo/econ_gcmessages.proto",
				"csgo/cstrike15_gcmessages.proto" // ECsgoGCMsg + matchmaking v2 messages
			].map(p)
		}
	}
};
