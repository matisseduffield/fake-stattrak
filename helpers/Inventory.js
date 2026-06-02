module.exports = class Inventory {
	/**
	 * Fetch a public Steam Community inventory and return the items that can hold
	 * a StatTrak / Strange counter, so the user can pick one instead of hunting
	 * for the item ID by hand.
	 *
	 * Uses the public community endpoint, which only works when the account's
	 * inventory is set to public. Callers should fall back to manual item-ID
	 * entry if this throws or returns an empty list.
	 *
	 * @param {String} steamID64 The owner's 64-bit Steam ID
	 * @param {Number} appID 730 (CS2) or 440 (TF2)
	 * @returns {Promise<Array<{ itemID: string, name: string }>>}
	 */
	static async getBoostableItems(steamID64, appID) {
		// Context 2 is the standard "Backpack" context for both CS2 and TF2
		let url = `https://steamcommunity.com/inventory/${steamID64}/${appID}/2?l=english&count=5000`;
		let res = await fetch(url, {
			headers: {
				// Without a browser-like UA Steam sometimes returns an empty body
				"User-Agent": "Mozilla/5.0 (compatible; fake-stattrak)"
			}
		});

		if (res.status === 403) {
			throw new Error("Inventory is private. Set it to public on Steam or enter the item ID manually.");
		}
		if (!res.ok) {
			throw new Error(`Steam returned HTTP ${res.status} while fetching the inventory.`);
		}

		let data = await res.json().catch(() => null);
		if (!data || !data.success || !Array.isArray(data.assets) || !Array.isArray(data.descriptions)) {
			throw new Error("Could not read the inventory (it may be private or empty).");
		}

		// Map "classid_instanceid" -> description so we can look up each asset's name
		let descriptions = {};
		for (let desc of data.descriptions) {
			descriptions[`${desc.classid}_${desc.instanceid}`] = desc;
		}

		let items = [];
		for (let asset of data.assets) {
			let desc = descriptions[`${asset.classid}_${asset.instanceid}`];
			if (!desc) {
				continue;
			}

			if (!this.isBoostable(desc)) {
				continue;
			}

			items.push({
				itemID: String(asset.assetid),
				name: desc.market_hash_name || desc.market_name || desc.name || `Item ${asset.assetid}`
			});
		}

		return items;
	}

	/**
	 * Heuristic for whether an item carries a StatTrak / Strange style counter.
	 * @param {Object} desc Steam inventory description object
	 * @returns {Boolean}
	 */
	static isBoostable(desc) {
		let name = (desc.market_hash_name || desc.market_name || desc.name || "").toLowerCase();
		if (name.includes("stattrak") || name.includes("strange")) {
			return true;
		}

		// Fall back to the Quality tag (CS2 "strange"/"unusual_strange", TF2 "strange")
		let tags = Array.isArray(desc.tags) ? desc.tags : [];
		return tags.some((tag) => {
			let category = (tag.category || tag.localized_category_name || "").toLowerCase();
			let internal = (tag.internal_name || "").toLowerCase();
			return category === "quality" && internal.includes("strange");
		});
	}
};
