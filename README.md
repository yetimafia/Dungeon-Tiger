# 🗝️ Dungeon Tiger

A pick-up D&D dungeon crawl. Everyone gets a random adventurer, and the party tries to get down **5 floors** and beat
the boss at the bottom. Play it in Discord with buttons, or at the table from the GM page in your browser.

It's a separate program from Note Tiger, but it **works with Note Tiger** when Note Tiger is running:

| From Note Tiger | What it's for |
|---|---|
| Random characters | Each player gets a full random character made by Note Tiger's character builder (tagged `dungeon`). |
| Party tracker | HP, spell slots, death saves and gold update live in Note Tiger's **Party** tab. |
| Rules lookups | `/dungeon ask` answers rules questions from your Note Tiger books. |
| Recap | When the run ends, Note Tiger writes a recap and posts it in **#recaps**. |

If Note Tiger isn't running, the game still works. It uses simple stand-in characters instead, and skips the tracker and the recap.

## Install (Windows)

1. Download **DungeonTiger-Setup-x.y.z.exe** from the [latest release](https://github.com/yetimafia/Dungeon-Tiger/releases/latest) and run it.
   If Windows says it protected your PC, click **More info → Run anyway**. No admin rights or Node.js needed.
2. Dungeon Tiger opens in its own window, and a door icon by the clock shows it's running.
3. If Note Tiger is installed on the same PC, click **🔗 Link Note Tiger**. That's all it needs.
   If Note Tiger is on another PC, open **⚙️ Settings** and paste its address and key from Note Tiger → Settings → Connections.
4. For Discord, paste the Dungeon Tiger bot's token in **⚙️ Settings** (see below).

**Updates:** when there's a new version, an **⬆️ Update** button shows at the top of the window. Click it and Dungeon Tiger
closes, updates and reopens, keeping your settings. You can also check by hand in ⚙️ Settings.

**Running from the code instead** (for testing changes): install Node.js, then double-click `start.bat`.

### The Discord bot (a second bot, separate from Note Tiger)

1. Go to https://discord.com/developers/applications, then **New Application**, and name it "Dungeon Tiger".
2. **Bot** tab: **Reset Token**, copy it, and paste it in Dungeon Tiger → ⚙️ Settings → Bot token. Keep it secret.
3. **OAuth2 → URL Generator**: tick `bot` and `applications.commands`. Under Bot Permissions, tick Send Messages,
   Create Public Threads, Send Messages in Threads, Read Message History, Embed Links, and Attach Files. Open the link it makes,
   then add the bot to your server.

## Playing

**In Discord**
- `/dungeon start` opens a lobby. Press **Join** and you get a random adventurer (🎲 for a different one). The one who
  opened the lobby presses **Start**. Empty seats are filled with companions the game plays (`party:` sets how many seats, 3 by default).
- The run happens in a thread. Pick a door with the arrow buttons, take loot, rest in the safe room (once per floor,
  full heal), and go down the stairs once their guards are beaten.
- In a fight, you get a message on your turn: pick a target, then an action (weapon or spell), or Dodge, a Potion, or
  🤖 Play it for me. If you don't choose within 2 minutes, the game plays that turn for you.
- `/dungeon map` shows the map. `/dungeon ask` asks a rules question. `/dungeon end` ends the run.

**On the GM page**
- Watch any run, including Discord ones: the map with fog, the party's HP and spell slots, the foes, and what's happening.
- Start a run yourself: **Test run** plays itself, which is handy for trying it out. **At the table**: you click each character's action.
- GM buttons: Auto-play, Heal party, Skip this fight, Next floor, End run.

## Settings

All of these are in ⚙️ Settings. They're saved in `app\\.env` in the install folder.

| Setting | What it does |
|---|---|
| `DISCORD_TOKEN` | The Dungeon Tiger bot's token. Empty = no Discord, GM page only. |
| `NOTE_TIGER_URL` | Note Tiger's Connections address. Default `http://localhost:3081/v1`. Use the address Note Tiger shows if it's on another PC. |
| `NOTE_TIGER_KEY` | The key from Note Tiger → Settings → Connections. |
| `NOTE_TIGER_SERVER` | Which Discord server's characters, books and #recaps to use. Empty = Note Tiger's first server. |
| `EDITION` | `2024` or `2014` rules for new runs. |
| `PORT` / `GM_LAN` | The GM page's port (3090). `GM_LAN=true` lets other computers on your network open it. |
| `TURN_SECONDS` | How long a Discord player has to choose an action (120). |
| `KEEP_CHARACTERS` | `true` keeps the random characters in Note Tiger after the run. They're removed by default. |

## The battle map

Every fight happens on a grid of 5-foot squares the size of the room, drawn in pixel art over a floor that matches the dungeon level:
flagstones and barrels in the cellars, tombs and puddles in the crypts, giant mushrooms in the fungal deep, anvils and
lava in the forge, and black crystal and runes at the bottom. Pillars, crates, tombs, mushrooms, lava and crystals block the way.

- Rooms come in different sizes, from cramped 35×25-foot cells to vast 80×50-foot halls (the boss lair is always the biggest). Some are L-shaped, some have their corners cut off, some are rough caves, and some are halls with rows of pillars. Fights in a crowded room get a bigger room so everyone can move.
- Heroes start by the door on the left (blue numbers), monsters on the right (red letters). Large monsters take 2×2 squares, Huge ones 3×3.
- Everyone moves 30 feet (6 squares) a turn. Slow things like oozes and zombies move less.
- Swords and claws reach the next square. Bows, crossbows and most spells shoot from afar. Shooting with an enemy right next to you is at disadvantage.
- Area spells and breath weapons hit everyone close together. Fireball has a 20-foot radius; Burning Hands bursts out from the caster.
- **In Discord:** on your turn you get the map with the squares you can reach shown in blue. Pick a target and an action, and your character walks up to it by themselves. **🏃 Back off & dodge** moves you away from the monsters.
- **On the GM page:** click a blue square to move there, click a monster to target it, then pick an action.

## Monster sprites

Every monster (all 364 from the free D&D rules) has its own 32×32 pixel-art sprite. They're drawn by code from the
monster's body type and name: dragons get wings and their colour, "frost" and "fire" monsters get icy or fiery colours,
and so on. The same monster always looks the same.

- They stand on the battle map, and the party gets sprites too, dressed for their class (robes and staffs, armour, bows…).
- **http://localhost:3090/sprites** shows all of them. A single sprite is at `/sprite/<Monster Name>.png`; add `?scale=4` for a bigger one.

## How the dungeon works

- Each floor is a 5×4 grid of rooms, with the stairs (or the boss lair on floor 5) as far from the start as possible.
  Rooms hold monster fights, treasure, traps, one safe room, or nothing.
- Fights are built from the party's level and size, and get harder floor by floor. Smaller parties get easier fights.
- The rules are simplified D&D 5e: initiative, attack rolls against AC, saves for half damage, crits, Extra Attack,
  Sneak Attack, spell slots, potions, death saves, and monster multiattacks and area attacks.
- `npm run sim` plays hundreds of runs by itself and reports how many win (`npm run sim -- 300 3 4` = 300 runs, level 3, party of 4).

## Credits

Monsters, spells and magic items come from the System Reference Document 5.1 and 5.2 by Wizards of the Coast LLC,
available at https://dnd.wizards.com/resources/systems-reference-document, licensed under the Creative Commons
Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/). The data was taken from the
5e-database project (https://github.com/5e-bits/5e-database).
