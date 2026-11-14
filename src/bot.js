// The Discord side: /dungeon start opens a lobby, people join (each gets a random adventurer), then the run plays out in a
// thread with buttons. Characters nobody plays, and anyone who doesn't answer in time, are played by the game.
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags,
} from 'discord.js';
import { castable } from './game.js';
import { FLOORS } from './dungeon.js';
import { battlePng, dist } from './battlemap.js';

const EPH = { flags: MessageFlags.Ephemeral };
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label.slice(0, 80)).setStyle(style).setDisabled(disabled);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bar = (h) => (h.dead ? '💀' : h.down ? `🩸 0/${h.maxHp} (${h.ds.s}✓ ${h.ds.f}✗)` : `❤️ ${h.hp}/${h.maxHp}`);
const KIND = { fight: '⚔️', stairs: '🪜', boss: '💀', rest: '🛏️', treasure: '💰', trap: '🪤', empty: '🚪', start: '📍' };

const COMMAND = new SlashCommandBuilder().setName('dungeon').setDescription('Dungeon Tiger: a pick-up dungeon run, 5 floors deep')
  .addSubcommand((s) => s.setName('start').setDescription('Open a lobby: people join and get a random adventurer')
    .addIntegerOption((o) => o.setName('level').setDescription('Character level (default 3)').setMinValue(1).setMaxValue(10))
    .addStringOption((o) => o.setName('rules').setDescription('D&D rules (default from settings)').addChoices({ name: '2024', value: '2024' }, { name: '2014', value: '2014' }))
    .addIntegerOption((o) => o.setName('party').setDescription('Fill the party up to this many with computer-played companions (default 3)').setMinValue(1).setMaxValue(6)))
  .addSubcommand((s) => s.setName('map').setDescription('Show the map and the party for the run in this thread'))
  .addSubcommand((s) => s.setName('end').setDescription('End the run in this thread (the one who started it)'))
  .addSubcommand((s) => s.setName('ask').setDescription('Ask a rules question (answered from your Note Tiger books)')
    .addStringOption((o) => o.setName('question').setDescription('What do you want to know?').setRequired(true)));

export function startBot({ token, delve, turnSeconds = 120 }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const lobbies = new Map();
  const byThread = new Map(); // thread id → run id

  client.once('clientReady', async () => {
    console.log(`[bot] logged in as ${client.user.tag}`);
    try { await new REST().setToken(token).put(Routes.applicationCommands(client.user.id), { body: [COMMAND.toJSON()] }); }
    catch (err) { console.error('[bot] couldn\'t register /dungeon:', err.message); }
  });

  // ---------- the lobby ----------
  const heroLine = (h) => `**${h.name}**, ${h.cls}${h.playerName ? ` (played by ${h.playerName})` : ''}: AC ${h.ac}, ${h.maxHp} HP${h.spells.length ? `, ${h.spells.length} spells` : ''}`;
  function lobbyView(lb) {
    const lines = lb.players.map((p) => `• ${p.hero ? heroLine(p.hero) : `${p.name}: rolling a character…`}`);
    const fill = Math.max(0, lb.party - lb.players.length);
    return {
      content: `🗝️ **Dungeon Tiger** (level ${lb.level}, ${lb.edition} rules): get the party down ${FLOORS} floors and beat what waits at the bottom.\n`
        + `${lines.length ? lines.join('\n') : '*Nobody yet. Press Join.*'}\n${fill ? `*${fill} companion${fill > 1 ? 's' : ''} played by the game will fill the party.*` : ''}`
        + `${lb.note ? `\n-# ${lb.note}` : ''}`,
      components: lb.closed ? [] : [row(
        btn(`dd|${lb.id}|join`, '🙋 Join', ButtonStyle.Primary), btn(`dd|${lb.id}|reroll`, '🎲 New character'),
        btn(`dd|${lb.id}|leave`, 'Leave'), btn(`dd|${lb.id}|go`, '▶ Start', ButtonStyle.Success), btn(`dd|${lb.id}|cancel`, 'Cancel', ButtonStyle.Danger))],
    };
  }

  // ---------- posting a run into its thread, in order ----------
  function wire(run, channel, ownerId) {
    const out = { chain: Promise.resolve(), buf: [], timer: null, panel: null, turnMsg: null, turnTimer: null, target: {} };
    run.ui = out; run.ownerId = ownerId; run.channel = channel;
    const queue = (fn) => { out.chain = out.chain.then(fn).catch((err) => console.error('[bot]', err.message)); };
    const flush = async () => {
      while (out.buf.length) {
        let text = '';
        while (out.buf.length && text.length + out.buf[0].length < 1900) text += `${out.buf.shift()}\n`;
        if (!text) text = clip(out.buf.shift(), 1900);
        await channel.send({ content: text, allowedMentions: { parse: [] } });
      }
    };
    run.on('say', (t) => { out.buf.push(t); clearTimeout(out.timer); out.timer = setTimeout(() => queue(flush), 700); });
    let panelSoon = false;
    run.on('map', () => {
      if (panelSoon) return;
      panelSoon = true;
      setTimeout(() => queue(async () => { panelSoon = false; await flush(); if (run.state === 'explore') await postPanel(run); }), 800);
    });
    // Show what they're up against.
    run.on('fight', () => queue(async () => {
      await flush();
      if (!run.combat) return;
      await channel.send({ content: `-# Battle map: heroes are blue numbers, monsters red letters. One square is 5 feet.`, files: [{ attachment: battlePng(run.combat.field, run.heroes, run.combat.monsters, { scale: 2 }), name: 'battle.png' }] });
    }));
    run.on('turn', (h) => queue(async () => { await flush(); await postTurn(run, h); }));
    run.on('end', () => queue(async () => {
      clearTimeout(out.turnTimer);
      await flush();
      await clearOld(run);
      await channel.send({ content: `**The party:**\n${run.heroes.map((h) => `${bar(h)} **${h.name}** (${h.cls})${h.gold ? `, ${h.gold} gp` : ''}${h.items.length ? `, ${h.items.join(', ')}` : ''}`).join('\n')}` });
    }));
    run.on('recap', (r) => queue(async () => {
      const msg = { writing: '📝 The run went to Note Tiger: a recap will show up in #recaps in a few minutes.', failed: `Couldn't send the run to Note Tiger: ${r.error}`, off: '' }[r.status];
      if (msg) await channel.send(msg);
    }));
  }
  async function clearOld(run) {
    const o = run.ui;
    for (const k of ['panel', 'turnMsg']) if (o[k]) { await o[k].edit({ components: [] }).catch(() => {}); o[k] = null; }
  }

  function panelView(run) {
    const r = run.room();
    const lines = run.heroes.map((h) => `${bar(h)} **${h.name}**${h.player ? ` <@${h.player}>` : ' 🤖'}${h.potions ? ` 🧪${h.potions}` : ''}${Object.values(h.slots).some((s) => s.max) ? ` ✨${Object.entries(h.slots).filter(([, s]) => s.max).map(([l, s]) => `${s.max - (s.used || 0)}`).join('/')}` : ''}`);
    const ex = r.exits;
    const dirBtn = (d, label) => {
      const to = ex[d] && run.floor.rooms[ex[d]];
      return btn(`dd|${run.id}|go|${d}`, `${label}${to ? ` ${to.seen && to.visited ? (to.cleared || !to.monsters?.length ? '·' : KIND[to.kind]) : to.kind === 'stairs' || to.kind === 'boss' ? '' : '?'}` : ''}`, ButtonStyle.Primary, !to);
    };
    const canLoot = r.loot && !r.looted && (r.cleared || !r.monsters?.length);
    const actions = [];
    if (canLoot) actions.push(btn(`dd|${run.id}|loot`, '💰 Take the loot', ButtonStyle.Success));
    if (r.kind === 'rest' && !r.rested) actions.push(btn(`dd|${run.id}|rest`, '🛏️ Rest (full heal)', ButtonStyle.Success));
    if (!r.breather) actions.push(btn(`dd|${run.id}|breather`, '☕ Short rest'));
    if (r.kind === 'stairs' && r.cleared) actions.push(btn(`dd|${run.id}|down`, `🪜 Go down to floor ${run.floorN + 1}`, ButtonStyle.Success));
    actions.push(btn(`dd|${run.id}|potion`, '🧪 Drink a potion'));
    return {
      content: `**Floor ${run.floorN}/${FLOORS}: ${run.floor.name}** · ${r.name}\n\`\`\`\n${run.map()}\n\`\`\`${lines.join('\n')}\n-# @ you · ? unexplored · M monsters · S stairs · B boss · $ loot · + safe room`,
      components: [row(dirBtn('n', '⬆️ North'), dirBtn('w', '⬅️ West'), dirBtn('e', '➡️ East'), dirBtn('s', '⬇️ South')), row(...actions.slice(0, 5))],
      allowedMentions: { parse: [] },
    };
  }
  async function postPanel(run) {
    await clearOld(run);
    run.ui.panel = await run.channel.send(panelView(run));
  }

  function turnView(run, h) {
    const foes = run.foes();
    const target = run.ui.target[h.id] && foes.find((m) => m.id === run.ui.target[h.id]) ? run.ui.target[h.id] : [...foes].sort((a, b) => dist(h, a) - dist(h, b) || a.hp - b.hp)[0]?.id;
    run.ui.target[h.id] = target;
    const sq = (m) => `${dist(h, m) * 5} ft`;
    const foeText = foes.map((m) => `${m.id === target ? '🎯 ' : ''}\`${m.tag}\` **${m.name}** (AC ${m.ac}, ${m.hp}/${m.maxHp} HP, ${sq(m)})`).join(' · ');
    const acts = [
      ...h.attacks.map((a) => ({ label: `⚔️ ${a.name}`, description: `${a.bonus >= 0 ? '+' : ''}${a.bonus} to hit, ${a.dice} ${a.type}${h.perTurn > 1 ? `, ${h.perTurn} attacks` : ''}${a.ranged ? ', ranged' : ''}`, value: `w:${a.name}` })),
      ...castable(h).map((s) => ({ label: `✨ ${s.name}`, description: `${s.level ? `level ${s.level}` : 'cantrip'}${s.data.heal ? ', heals the most hurt ally' : s.data.aoe ? ', hits an area' : ''}`, value: `s:${s.name}` })),
    ].slice(0, 25).map((o) => ({ ...o, label: clip(o.label, 100), description: clip(o.description, 100), value: o.value.slice(0, 100) }));
    const png = battlePng(run.combat.field, run.heroes, run.combat.monsters, { scale: 2, reach: run.reach(h), current: h.id, target });
    return {
      content: `${h.player ? `<@${h.player}> ` : ''}**${h.name}'s turn** (\`${h.tag}\` on the map, ${bar(h)}, AC ${h.ac}). Round ${run.combat.round}.\nFoes: ${foeText}\n-# Pick a target, then an action: you walk up to it by yourself (${h.speed * 5} ft, shown in blue). ${turnSeconds}s, then the game plays this turn for you.`,
      files: [{ attachment: png, name: 'battle.png' }],
      components: [
        row(new StringSelectMenuBuilder().setCustomId(`dd|${run.id}|target|${h.id}`).setPlaceholder('🎯 Target')
          .addOptions(foes.slice(0, 25).map((m) => ({ label: clip(`${m.tag}: ${m.name} (${m.hp}/${m.maxHp} HP, ${sq(m)})`, 100), value: m.id, default: m.id === target })))),
        row(new StringSelectMenuBuilder().setCustomId(`dd|${run.id}|act|${h.id}`).setPlaceholder('Choose an action').addOptions(acts)),
        row(btn(`dd|${run.id}|dodge|${h.id}`, '🛡️ Dodge'), btn(`dd|${run.id}|back|${h.id}`, '🏃 Back off & dodge'),
          btn(`dd|${run.id}|drink|${h.id}`, `🧪 Potion (${h.potions})`, ButtonStyle.Secondary, !h.potions),
          btn(`dd|${run.id}|auto|${h.id}`, '🤖 Play it for me')),
      ],
      allowedMentions: { users: h.player ? [h.player] : [] },
    };
  }
  async function postTurn(run, h) {
    if (run.waiting?.heroId !== h.id) return;
    await clearOld(run);
    run.ui.turnMsg = await run.channel.send(turnView(run, h));
    clearTimeout(run.ui.turnTimer);
    run.ui.turnTimer = setTimeout(() => {
      if (run.waiting?.heroId !== h.id) return;
      run.say(`⏳ ${h.name} hesitates; instinct takes over.`, { story: false });
      run.autoTurn();
    }, turnSeconds * 1000);
  }

  // ---------- slash commands ----------
  client.on('interactionCreate', async (i) => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'dungeon') return await onCommand(i);
      if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('dd|')) return await onPress(i);
    } catch (err) {
      console.error('[bot]', err);
      const msg = { content: `⚠️ ${err.message}`, ...EPH };
      if (i.deferred || i.replied) await i.followUp(msg).catch(() => {}); else await i.reply(msg).catch(() => {});
    }
  });

  async function onCommand(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'start') {
      const id = `l${Date.now().toString(36)}`;
      const lb = { id, owner: i.user.id, level: i.options.getInteger('level') || 3, edition: i.options.getString('rules') || delve.edition,
        party: i.options.getInteger('party') || 3, players: [], guildId: i.guildId };
      if (!delve.nt.ok) await delve.nt.check();
      if (!delve.nt.ok) lb.note = `Note Tiger isn't reachable (${delve.nt.lastError || 'not set up'}), so characters are simple stand-ins and there'll be no recap.`;
      lobbies.set(id, lb);
      await i.reply(lobbyView(lb));
      lb.message = await i.fetchReply();
      return;
    }
    if (sub === 'ask') {
      await i.deferReply();
      if (!delve.nt.ok && !(await delve.nt.check())) return i.editReply(`Note Tiger isn't reachable: ${delve.nt.lastError}`);
      const q = i.options.getString('question');
      const { answer, source } = await delve.nt.ask(q);
      return i.editReply(clip(`**${q}**\n${answer}${source ? `\n-# ${source.book}, p. ${source.page}` : ''}`, 2000));
    }
    const run = delve.get(byThread.get(i.channelId));
    if (!run) return i.reply({ content: 'There\'s no run in this thread. Start one with `/dungeon start`.', ...EPH });
    if (sub === 'map') {
      const extra = run.state === 'combat' ? { files: [{ attachment: battlePng(run.combat.field, run.heroes, run.combat.monsters, { scale: 2, current: run.current()?.id }), name: 'battle.png' }] } : {};
      return i.reply({ ...panelView(run), components: [], ...extra });
    }
    if (sub === 'end') {
      if (i.user.id !== run.ownerId && !i.memberPermissions?.has('ManageGuild')) return i.reply({ content: 'Only the one who started the run can end it.', ...EPH });
      await i.reply('Ending the run.');
      run.end(`The party left the dungeon on floor ${run.floorN}.`, 'quit');
    }
  }

  async function onPress(i) {
    const [, id, what, arg] = i.customId.split('|');
    const lb = lobbies.get(id);
    if (lb) return onLobby(i, lb, what);
    const run = delve.get(id);
    if (!run || run.state === 'ended') return i.reply({ content: 'That run is over.', ...EPH });
    const inParty = run.heroes.some((h) => h.player === i.user.id) || i.user.id === run.ownerId;

    // Fights: only the character's player (or whoever started the run) can choose.
    if (['target', 'act', 'dodge', 'back', 'drink', 'auto'].includes(what)) {
      const h = run.hero(arg);
      if (!h || run.waiting?.heroId !== h.id) return i.reply({ content: 'That turn is over.', ...EPH });
      if (h.player !== i.user.id && i.user.id !== run.ownerId) return i.reply({ content: `That's ${h.playerName || 'someone else'}'s character.`, ...EPH });
      if (what === 'target') { run.ui.target[h.id] = i.values[0]; return i.update({ ...turnView(run, h), attachments: [] }); }
      clearTimeout(run.ui.turnTimer);
      const target = run.ui.target[h.id];
      await i.update({ components: [] });
      run.ui.turnMsg = null;
      if (what === 'auto') return run.autoTurn();
      if (what === 'dodge') return run.act(h.id, { type: 'dodge' });
      if (what === 'back') return run.act(h.id, { type: 'retreat' });
      if (what === 'drink') { const down = run.standing().find((x) => x.down); return run.act(h.id, { type: 'potion', target: down?.id }); }
      const [kind, ...rest] = i.values[0].split(':');
      const name = rest.join(':');
      return run.act(h.id, kind === 'w' ? { type: 'attack', weapon: name, target } : { type: 'cast', spell: name, target });
    }

    if (!inParty) return i.reply({ content: 'Only the party can choose where to go.', ...EPH });
    if (run.state !== 'explore') return i.reply({ content: 'Finish the fight first.', ...EPH });
    await i.update({ components: [] });
    run.ui.panel = null;
    const who = run.heroes.find((h) => h.player === i.user.id);
    if (what === 'go') run.move(arg);
    else if (what === 'loot') run.loot();
    else if (what === 'rest') run.shortRest();
    else if (what === 'breather') run.breather();
    else if (what === 'down') run.descend();
    else if (what === 'potion') {
      const h = who && !who.dead && who.potions && who.hp < who.maxHp ? who : null;
      if (!h) { await i.followUp({ content: 'You have no potion, or you\'re at full HP.', ...EPH }); run.emit('map'); return; }
      run.drink(h);
    }
  }

  async function onLobby(i, lb, what) {
    const me = lb.players.find((p) => p.id === i.user.id);
    const name = i.member?.displayName || i.user.globalName || i.user.username;
    if (what === 'join' || what === 'reroll') {
      if (what === 'join' && me) return i.reply({ content: 'You\'re already in.', ...EPH });
      if (what === 'reroll' && !me) return i.reply({ content: 'Join first.', ...EPH });
      if (lb.players.length >= 6 && !me) return i.reply({ content: 'The party is full (6).', ...EPH });
      const p = me || { id: i.user.id, name };
      if (!me) lb.players.push(p);
      const old = p.hero;
      p.hero = null;
      await i.update(lobbyView(lb));
      if (old) delve.nt.remove(old.id);
      const { heroes } = await delve.makeParty({ players: [p], level: lb.level, edition: lb.edition });
      p.hero = heroes[0];
      return lb.message.edit(lobbyView(lb));
    }
    if (what === 'leave') {
      if (!me) return i.reply({ content: 'You\'re not in the party.', ...EPH });
      lb.players = lb.players.filter((p) => p !== me);
      if (me.hero) delve.nt.remove(me.hero.id);
      return i.update(lobbyView(lb));
    }
    if (i.user.id !== lb.owner) return i.reply({ content: 'Only the one who opened the lobby can start or cancel it.', ...EPH });
    if (what === 'cancel') {
      lb.closed = true; lobbies.delete(lb.id);
      lb.players.forEach((p) => p.hero && delve.nt.remove(p.hero.id));
      return i.update({ content: '🗝️ Dungeon Tiger: cancelled.', components: [] });
    }
    if (what === 'go') {
      if (lb.players.some((p) => !p.hero)) return i.reply({ content: 'Still rolling a character, one moment.', ...EPH });
      lb.closed = true; lobbies.delete(lb.id);
      await i.update(lobbyView(lb));
      const { heroes: comps } = await delve.makeParty({ companions: Math.max(0, lb.party - lb.players.length), level: lb.level, edition: lb.edition });
      const heroes = [...lb.players.map((p) => p.hero), ...comps];
      let channel = i.channel;
      try { channel = await lb.message.startThread({ name: `Dungeon Tiger ${new Date().toLocaleDateString()}`, autoArchiveDuration: 1440 }); }
      catch (err) { console.error('[bot] couldn\'t make a thread, playing in the channel:', err.message); }
      // Wire up before the run's first lines are said.
      const run = delve.start({ heroes, level: lb.level, edition: lb.edition, source: 'discord', guildId: lb.guildId, channelId: channel.id, defer: true });
      byThread.set(channel.id, run.id);
      wire(run, channel, lb.owner);
      run.begin();
    }
  }

  client.login(token).catch((err) => console.error('[bot] couldn\'t log in:', err.message));
  return client;
}
