const ClientShared = require("./Client_Shared.js");

module.exports = class TF2Client extends ClientShared {
	constructor() {
		super(440);
	}

	login(username, password, options = {}) {
		return new Promise(async (resolve, reject) => {
			try {
				// Forward options (saved session token, Steam Guard + refresh-token
				// callbacks) to the shared login - without this they'd be dropped.
				let data = await super.login(username, password, options);

				// Finalizing
				await this.coordinator.sendMessage(
					440,
					this.protobufs.data.tf2.ETFGCMsg.k_EMsgGC_TFClientInit,
					{
						steamid: this.client.steamID.getSteamID64(),
						client_sessionid: this.client._sessionID
					},
					this.protobufs.encodeProto("CMsgTFClientInit", {
						client_version: this.clientVersion,
						language: 0
					})
				);

				await this.coordinator.sendMessage(
					440,
					this.protobufs.data.tf2.ESOMsg.k_ESOMsg_CacheSubscriptionRefresh,
					{
						steamid: this.client.steamID.getSteamID64(),
						client_sessionid: this.client._sessionID
					},
					this.protobufs.encodeProto("CMsgSOCacheSubscriptionRefresh", {
						owner: this.steamID.getSteamID64()
					})
				);

				// Done
				resolve(data);
			} catch (err) {
				reject(err);
			}
		});
	}
}
