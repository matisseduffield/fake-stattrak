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
	 * @returns {Promise<Array<{ itemID: string, name: string, iconUrl: string|null, count: number|null, color: string|null }>>}
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
				name: desc.market_hash_name || desc.market_name || desc.name || `Item ${asset.assetid}`,
				iconUrl: this.iconUrl(desc),
				count: this.currentCount(desc),
				color: this.nameColor(desc)
			});
		}

		// Alphabetical so the grid is easy to scan
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	/**
	 * Build a usable image URL from a Steam inventory description's icon token.
	 * @param {Object} desc Steam inventory description object
	 * @returns {String|null}
	 */
	static iconUrl(desc) {
		let token = desc.icon_url_large || desc.icon_url;
		if (!token) {
			return null;
		}
		return `https://community.fastly.steamstatic.com/economy/image/${token}/256fx256f`;
	}

	/**
	 * Best-effort current counter value, parsed from the item's description text
	 * (e.g. "StatTrak™ Kills: 1337"). Only lines that actually mention StatTrak or
	 * Strange are considered, so unrelated "Kills" flavour text isn't misread. Not
	 * always present in public inventory data, in which case this returns null.
	 * @param {Object} desc Steam inventory description object
	 * @returns {Number|null}
	 */
	static currentCount(desc) {
		let lines = []
			.concat(Array.isArray(desc.descriptions) ? desc.descriptions : [])
			.concat(Array.isArray(desc.owner_descriptions) ? desc.owner_descriptions : []);

		for (let line of lines) {
			let text = (line && line.value) || "";
			if (!/StatTrak|Strange/i.test(text)) {
				continue;
			}
			let match = text.match(/([\d,]+)/);
			if (match) {
				let n = Number(match[1].replace(/,/g, ""));
				if (Number.isFinite(n)) {
					return n;
				}
			}
		}
		return null;
	}

	/**
	 * The item's name colour as a CSS hex string, but only if Steam gave us a
	 * valid 3/6-digit hex value. Validating here stops untrusted inventory data
	 * from being injected into a CSS context in the GUI.
	 * @param {Object} desc Steam inventory description object
	 * @returns {String|null}
	 */
	static nameColor(desc) {
		let raw = String(desc.name_color || "").trim();
		return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw) ? `#${raw}` : null;
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
