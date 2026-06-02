# Fake Stattrak

Apply fake kills to your stattrak and strange weapons in Counter-Strike 2 and TF2.

*I will be using "StatTrak", "CS2" and "Kill" throughout this README but it also applies to TF2 and any Strange filter*

*Counter-Strike 2 replaced CS:GO and uses the same App ID (`730`), so the same `appID` value continues to work.*

**While Valve has not banned anyone for modifying their items like this they can ban you if they want to. Use at your own risk. I am not responsible for any damages.**

---

## How does it work?

StatTrak kills count on community servers too, so there logically are only two ways Valve would possibly know that you killed someone: Either the client sends something to let the game know you got a kill or the server does it. So I researched and turns out the server sends something telling the game you got a kill.

CS2 still uses the same `CMsgIncrementKillCountAttribute` Game Coordinator message as CS:GO did, which is why this approach continues to work.

This script creates a fake server and fake joins it with a bot account and the account you want to boost a StatTrak weapon on. Valve will think its a real match going on and will allow our fake server to send StatTrak increments.

These StatTrak increments basically just tell Valve to update the item and change the kill-count on it.

## Requirements

- [NodeJS](https://nodejs.org/en/) - `v18.10.0` or later
- **Two Steam accounts:**
  - The **boosting account** - the one that owns the StatTrak / Strange item you want to boost.
  - A **bot account** - any other account, used to fill the fake server so Valve sees a "real" match. It does not need to own the game; a free secondary account works.

## Quick start

```sh
git clone https://github.com/matisseduffield/fake-stattrak.git
cd fake-stattrak
npm install
npm run gui
```

Then open **http://localhost:3000** in your browser. **Log out of / exit Steam before running** - see [Valve Anti-Cheat](#valve-anti-cheat).

There are two ways to use the tool - pick whichever you prefer:

- **Web GUI** (`npm run gui`) - a local browser app with a visual inventory grid, saved accounts, a job queue and a live log. Recommended.
- **Command line** (`npm start`) - an interactive terminal wizard. Run `node index.js --help` for options.

## Web GUI

Run `npm run gui` and open the printed URL (default http://localhost:3000). Everything runs locally on your machine - nothing is sent anywhere except to Steam, exactly like the CLI.

Features:

- **Visual inventory grid** - your StatTrak/Strange items shown with their images (and current count where Steam exposes it); click one to queue it.
- **Account manager** - the accounts you use are remembered in a dropdown (optionally with the password); a saved login session means you usually won't need to re-enter Steam Guard.
- **Job queue + live log** - line up several items/amounts and run them one after another, with a per-job progress bar, a **Stop** button, and a live activity log.
- **Status & cooldown** - a connection indicator, clear error banners, and the post-throttle cooldown is shown so you know when you can retry.
- **Steam Guard in the browser** - if an account needs a 2FA code you'll be prompted for it in a dialog.

Set a different port with `PORT=8080 npm run gui`.

> The GUI binds to `localhost` only. Don't expose it to the internet - it can log into your Steam accounts.

## CLI walkthrough

When you run `node index.js` it walks you through each step:

```
? Which game? › Counter-Strike 2
? Login username for the account that OWNS the item (boosting account): › my_main
? Password for my_main: › ********
? Login username for any second account to fill the server (bot account): › my_bot
? Password for my_bot: › ********
? Steam Guard code for my_main (from your Steam Mobile authenticator app): › ABCDE
Fetching your inventory...
? Pick the item to boost (3 StatTrak/Strange items found, type to filter): › StatTrak™ AK-47 | Redline (Field-Tested)
? Which stat do you want to change? › 0 - StatTrak™ Confirmed Kills
? How much do you want to add to the counter? › 1337
? Proceed? › yes
Sending [##############################] 100.0%  1,337 / 1,337
```

A few notes:

- The **login username is the name you sign into Steam with** - usually your Steam account name rather than your email. If a login fails, double-check this.
- You'll only be asked for a **Steam Guard code** if the account has 2FA enabled (mobile or email). The prompt tells you where to get the code.
- The **item picker** only appears if your inventory is set to **public**. If it's private or empty you'll be asked to type the item ID instead - see [Find Item ID](#find-item-id).
- Stats that only count on official Valve servers (such as Competitive MVPs) are hidden, because they can't be boosted this way.
- At the end you can optionally **save your answers to `config.json`** so you can re-run without the questions.

### Quality of life features

- **Interactive prompts** - pick the game, stat and amount from menus instead of editing JSON. The amount accepts thousands separators, so `1,000,000` works.
- **Inventory item picker** - if your inventory is public it lists your StatTrak/Strange items so you can pick one instead of looking up the item ID.
- **Steam Guard / 2FA support** - you'll be asked for your mobile or email code at login when needed.
- **Remembered logins** - after a successful login the session is saved to `sessions.json`, so the next run skips the password and Steam Guard prompts (and is far less likely to hit Steam's login throttling). Delete `sessions.json` to forget the saved logins.
- **Throttle-safe logins** - automatic re-login retries are disabled and, if Steam ever throttles a login, the tool waits 30 minutes before trying that account again (override with `--force`) so it can't keep hammering Steam.
- **Live progress bar** - see exactly how far along the increments are.
- **Fast startup** - only the required protobufs are loaded, so connecting takes about a second instead of a minute.
- **Saved config** - optionally save your answers to `config.json` and re-run non-interactively with `node index.js --config`.

### Running non-interactively

If you prefer the old behaviour, create a `config.json` (see `config.json.example`) and run either of:

```sh
node index.js --config
npm run start:config
```

Your config is validated before anything happens, so typos and unsupported values are reported up front.

## Config

Used by `node index.js --config`. The interactive mode can create this file for you.

- `boostingAccount`: Object - Account details of the account with the item you want to boost
  - `username`: String - Login username
  - `password`: String - Login password
- `botAccount`: Object - Account details of any account
  - `username`: String - Login username
  - `password`: String - Login password
- `itemID`: String - Item ID of the item you want to boost - [How to find the item ID](#find-item-id)
- `appID`: Number - ID of the game your item is from - *Currently only Counter-Strike 2 (`730`) and TF2 (`440`) are supported*
- `eventType`: Number - The event type which defines what stat on an item gets changed - [More Info](#event-type)
- `incrementValue`: Number - How much you want to add to the current item
  - **Note:** Many changes have been made behind the scenes, this might not properly work! If you have problems please open a new [Issue on Github](https://github.com/matisseduffield/fake-stattrak/issues)

## Troubleshooting

- **`Failed to connect to Steam`** - the Game Coordinator didn't answer. Make sure you're fully logged out of the Steam client, wait a moment and try again; Steam occasionally needs a couple of attempts.
- **`InvalidPassword`** - the username or password was wrong. Some accounts can no longer log in with a password alone - make sure the account has a normal password set.
- **`RateLimitExceeded` / `AccountLoginDeniedThrottle`** - Steam is throttling logins for this account after too many attempts (this is account-based, so changing your IP doesn't reset it). The tool now backs off automatically: after a throttle it won't re-attempt that account for 30 minutes, so re-running won't make it worse - just wait it out (the real Steam block can be longer). You can override the cooldown with `node index.js --force`, and logging in from a different network or via the saved session avoids the block entirely. If logins keep failing (not throttling), make sure the username is the name you sign into Steam with (usually the account name, not the email).
- **Wrong Steam Guard code** - check that your phone's clock is accurate, then re-run and enter a fresh code.
- **No items in the picker** - your inventory is probably private. Set it to public ([privacy settings](https://steamcommunity.com/my/edit/settings)) or enter the item ID manually.
- **The new count doesn't show up** - it can take a few minutes for Valve to process, and your inventory may be briefly inaccessible. Double-check you used the correct item ID if it never appears.

If you hit something not covered here, open an [Issue on GitHub](https://github.com/matisseduffield/fake-stattrak/issues).

## Valve Anti-Cheat

VAC is a client-side Anti-Cheat, VAC never gets enabled with this. The only thing you can recieve is a `VAC was unable to verify your game session.` or `You cannot play on secure servers for one of the following reasons`. This happens when you are logged into Steam while using this. Simply exit Steam or log out of your account before running this. Once the script is done you can start Steam again. VAC errors have nothing to do with using this, to fix the errors above just follow [Steam's Support Article](https://support.steampowered.com/kb_article.php?ref=2117-ilzv-2837).

## Find Item ID

To find your item ID go to [your inventory](http://steamcommunity.com/my/inventory) and search the item you want to boost, right click it and click `Copy link address`. You will get something like this: `/inventory/#440_2_143113807`, this is the schema it follows: `AppID_Context_ItemID`. Context is irrelevant for you, only AppID and ItemID matter. In this case AppID is `440` and ItemID is `143113807`.

## Event Type

An event type tells Steam what statistic on a weapon you want to modify, this is important because some items have multiple different counters. Here is a list of all event types I am aware of and their meaning **(Last Updated: 9th March 2020)**

**Note:** Some my not work due to them being only counted on official servers, one example is the MVP counter on music kits. I have attempted to automate everything, including splitting StatTrak increases, and detecting "Official Server Only" event types. This is not perfect so some may not work.

<details>
<summary>Counter-Strike 2 (formerly Counter-Strike: Global Offensive)</summary>

| Type ID | Name                                | Internal Name |
|---------|-------------------------------------|---------------|
| 0       | StatTrak™ Confirmed Kills           | Kills         |
| 1       | StatTrak™ Official Competitive MVPs | OCMVPs        |
</details>

<details>
<summary>Team Fortress 2</summary>

| Type ID | Name                                    | Internal Name                       |
|---------|-----------------------------------------|-------------------------------------|
| 0       | Kills                                   | Kills                               |
| 1       | Ubers                                   | Ubers                               |
| 2       | Kill Assists                            | KillAssists                         |
| 3       | Sentry Kills                            | SentryKills                         |
| 4       | Sodden Victims                          | PeeVictims                          |
| 5       | Spies Shocked                           | BackstabsAbsorbed                   |
| 6       | Heads Taken                             | HeadsTaken                          |
| 7       | Humiliations                            | Humiliations                        |
| 8       | Gifts Given                             | GiftsGiven                          |
| 9       | Deaths Feigned                          | FeignDeaths                         |
| 10      | Scouts Killed                           | ScoutsKilled                        |
| 11      | Snipers Killed                          | SnipersKilled                       |
| 12      | Soldiers Killed                         | SoldiersKilled                      |
| 13      | Demomen Killed                          | DemomenKilled                       |
| 14      | Heavies Killed                          | HeaviesKilled                       |
| 15      | Pyros Killed                            | PyrosKilled                         |
| 16      | Spies Killed                            | SpiesKilled                         |
| 17      | Engineers Killed                        | EngineersKilled                     |
| 18      | Medics Killed                           | MedicsKilled                        |
| 19      | Buildings Destroyed                     | BuildingsDestroyed                  |
| 20      | Projectiles Reflected                   | ProjectilesReflected                |
| 21      | Headshot Kills                          | HeadshotKills                       |
| 22      | Airborne Enemy Kills                    | AirborneEnemyKills                  |
| 23      | Gib Kills                               | GibKills                            |
| 24      | Buildings Sapped                        | BuildingsSapped                     |
| 25      | Tickle Fights Won                       | PlayersTickled                      |
| 26      | Opponents Flattened                     | MenTreaded                          |
| 27      | Kills Under A Full Moon                 | KillsDuringFullMoon                 |
| 28      | Dominations                             | StartDominationKills                |
| 30      | Revenges                                | RevengeKills                        |
| 31      | Posthumous Kills                        | PosthumousKills                     |
| 32      | Teammates Extinguished                  | AlliesExtinguished                  |
| 33      | Critical Kills                          | CriticalKills                       |
| 34      | Kills While Explosive-Jumping           | KillsWhileExplosiveJumping          |
| 36      | Sappers Removed                         | SapperDestroyed                     |
| 37      | Cloaked Spies Killed                    | InvisibleSpiesKilled                |
| 38      | Medics Killed That Have Full ÜberCharge | MedicsWithFullUberKilled            |
| 39      | Robots Destroyed                        | RobotsKilled                        |
| 40      | Giant Robots Destroyed                  | MinibossRobotsKilled                |
| 44      | Kills While Low Health                  | LowHealthKill                       |
| 45      | Kills During Halloween                  | HalloweenKills                      |
| 46      | Robots Killed During Halloween          | HalloweenRobotKills                 |
| 47      | Defenders Killed                        | DefenderKills                       |
| 48      | Submerged Enemy Kills                   | UnderwaterKills                     |
| 49      | Kills While Invuln ÜberCharged          | KillsWhileUbercharged               |
| 50      | Food Items Eaten                        | FoodEaten                           |
| 51      | Banners Deployed                        | BannersDeployed                     |
| 58      | Seconds Cloaked                         | TimeCloaked                         |
| 59      | Health Dispensed to Teammates           | HealthGiven                         |
| 60      | Teammates Teleported                    | TeleportsGiven                      |
| 61      | Tanks Destroyed                         | TanksDestroyed                      |
| 62      | Long-Distance Kills                     | LongDistanceKills                   |
| 64      | Points Scored                           | PointsScored                        |
| 65      | Double Donks                            | DoubleDonks                         |
| 66      | Teammates Whipped                       | TeammatesWhipped                    |
| 67      | Kills during Victory Time               | VictoryTimeKill                     |
| 68      | Robot Scouts Destroyed                  | RobotScoutKill                      |
| 74      | Robot Spies Destroyed                   | RobotSpyKill                        |
| 77      | Taunt Kills                             | TauntKill                           |
| 78      | Unusual-Wearing Player Kills            | PlayerWearingUnusualKill            |
| 79      | Burning Player Kills                    | BurningPlayerKill                   |
| 80      | Killstreaks Ended                       | KillstreaksEnded                    |
| 81      | Freezecam Taunt Appearances             | KillcamTaunts                       |
| 82      | Damage Dealt                            | DamageDealt                         |
| 83      | Fires Survived                          | FiresSurvived                       |
| 84      | Allied Healing Done                     | AllyHealingDone                     |
| 85      | Point Blank Kills                       | PointBlankKill                      |
| 86      | Wrangled Sentry Kills                   | PlayerKillsBySentry                 |
| 87      | Kills                                   | CosmeticKills                       |
| 88      | Full Health Kills                       | FullHealthKills                     |
| 89      | Taunting Player Kills                   | TauntingPlayerKills                 |
| 90      | Carnival Kills                          | HalloweenOverworldKills             |
| 91      | Carnival Underworld Kills               | HalloweenUnderworldKills            |
| 92      | Carnival Games Won                      | HalloweenMinigamesWon               |
| 93      | Not Crit nor MiniCrit Kills             | NonCritKills                        |
| 94      | Players Hit                             | PlayersHit                          |
| 95      | Assists                                 | CosmeticAssists                     |
| 96      | Contracts Completed                     | CosmeticOperationContractsCompleted |
| 97      | Kills                                   | CosmeticOperationKills              |
| 98      | Contract Points                         | CosmeticOperationContractsPoints    |
| 99      | Contract Bonus Points                   | CosmeticOperationBonusObjectives    |
| 100     | Times Performed                         | TauntsPerformed                     |
| 101     | Kills and Assists during Invasion Event | InvasionKills                       |
| 102     | Kills and Assists on 2Fort Invasion     | InvasionKillsOnMap01                |
| 103     | Kills and Assists on Probed             | InvasionKillsOnMap02                |
| 104     | Kills and Assists on Byre               | InvasionKillsOnMap03                |
| 105     | Kills and Assists on Watergate          | InvasionKillsOnMap04                |
| 106     | Souls Collected                         | HalloweenSouls                      |
| 107     | Merasmissions Completed                 | HalloweenContractsCompleted         |
| 108     | Halloween Transmutes Performed          | HalloweenOfferings                  |
| 109     | Power Up Canteens Used                  | PowerupBottlesUsed                  |
| 110     | Contract Points Earned                  | ContractPointsEarned                |
| 111     | Contract Points Contributed To Friends  | ContractPointsContributedToFriends  |
</details>
