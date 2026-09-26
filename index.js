'use strict';
/**
 * ███ LogPass ███ — all-in-one Discord moderation + fun bot in ONE file.
 * Runs on Vercel as a serverless function (Discord interactions over HTTPS,
 * no gateway connection needed).
 *
 * Web dashboard: admins run /setuplogin in Discord, click the button in the
 * reply, and set a username + password on a one-time LogPass-branded page.
 *
 * Everything is labeled LogPass with the logo:
 *   https://raw.githubusercontent.com/DCRDBOTS/images/main/logpass_logo.png
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

// ─────────────────────────────────────────────── config / branding
const LOGO_URL = 'https://raw.githubusercontent.com/DCRDBOTS/images/main/logpass_logo.png';
const BRAND = 'LogPass';
const DATA_DIR = process.env.LOGPASS_DATA_DIR || '/tmp/logpass';
const DB_FILE = `${DATA_DIR}/db.json`;
const START_TIME = Date.now();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_PUBLIC_KEY = process.env.CLIENT_PUBLIC_KEY || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const PORT = process.env.PORT || 3000;

const COLORS = { brand: 0x5865f2, ok: 0x57f287, err: 0xed4245, warn: 0xfee75c };

// ─────────────────────────────────────────────── tiny persistence
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_GUILD = () => ({
  modLogChannel: null,
  welcomeChannel: null,
  goodbyeChannel: null,
  welcomeMessage: 'Welcome {mention} to **{server}**! You are member #{count}.',
  goodbyeMessage: '{user} has left **{server}**. 😢',
  automod: { enabled: false, bannedWords: [], antiInvite: false, antiLink: false, antiSpam: false, maxMentions: 5 },
  warnings: {},
  cases: [],
  caseCounter: 0,
  dashboard: null, // { username, hash, salt, createdAt }
});

let state = { guilds: {} };
try {
  if (fs.existsSync(DB_FILE)) state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (err) {
  console.error('[LogPass] Could not read database, starting fresh:', err.message);
}

function getGuild(id) {
  if (!state.guilds[id]) state.guilds[id] = DEFAULT_GUILD();
  const g = state.guilds[id];
  const defaults = DEFAULT_GUILD();
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in g)) g[k] = typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  }
  if (!g.automod) g.automod = defaults.automod;
  return g;
}

let flushTimer = null;
function flushDb() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(state)); } catch (err) { console.error('[LogPass] DB write failed:', err.message); }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushDb(); }, 200);
}

// ─────────────────────────────────────────────── discord REST helpers
const API = 'https://discord.com/api/v10';
const rest = {
  async call(method, endpoint, body, reason) {
    const res = await fetch(API + endpoint, {
      method,
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason).slice(0, 480) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  },
  async json(method, endpoint, body, reason) {
    const res = await rest.call(method, endpoint, body, reason);
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  },
};
function sendFollowup(token, payload) { return rest.json('POST', `/webhooks/${CLIENT_ID}/${token}`, payload); }
function sendModLog(guildId, embed) {
  const settings = getGuild(guildId);
  if (!settings.modLogChannel) return;
  rest.json('POST', `/channels/${settings.modLogChannel}/messages`, { embeds: [embed] }).catch(() => {});
}
function sendDm(userId, payload) {
  return rest.json('POST', '/users/@me/channels', { recipient_id: userId })
    .then((dm) => { if (dm && dm.id) return rest.json('POST', `/channels/${dm.id}/messages`, payload); return null; })
    .catch(() => null);
}

// snowflake → timestamp (for /serverinfo, /userinfo)
function snowflakeDate(id) { return new Date(Number(BigInt(id) >> BigInt(22)) + 1420070400000); }

// ─────────────────────────────────────────────── signature verification
function verifyKey(rawBody, signature, timestamp) {
  if (!CLIENT_PUBLIC_KEY) return false;
  try {
    return crypto.verify(
      'ed25519',
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      Buffer.from(CLIENT_PUBLIC_KEY, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch { return false; }
}
function textResponse(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function reply401(res) { return textResponse(res, 401, 'Invalid request signature'); }

// ─────────────────────────────────────────────── shared utils
const DURATION_CHOICES = [
  { name: '60 seconds', value: 60 }, { name: '5 minutes', value: 300 }, { name: '10 minutes', value: 600 },
  { name: '1 hour', value: 3600 }, { name: '1 day', value: 86400 }, { name: '1 week', value: 604800 },
];
function fmtMs(ms) {
  const units = [['w', 604800000], ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  for (const [suffix, v] of units) if (ms >= v) return ms % v === 0 ? `${Math.floor(ms / v)}${suffix}` : `${Math.floor(ms / v)}${suffix}${fmtMs(ms % v)}`;
  return `${ms}ms`;
}

function brandEmbed(color, title, description, extra = {}) {
  const e = {
    title: title ? `${title}` : BRAND,
    color: color ?? COLORS.brand,
    timestamp: new Date().toISOString(),
    footer: { text: `${BRAND} — secure server management`, icon_url: LOGO_URL },
    ...extra,
  };
  if (description) e.description = description;
  return e;
}
function okEmbed(description, title) { return brandEmbed(COLORS.ok, title, `✅ ${description}`); }
function errEmbed(description, title) { return brandEmbed(COLORS.err, title, `❌ ${description}`); }
function infoEmbed(description, title) { return brandEmbed(COLORS.brand, title, description); }

function logEmbed(action, targetTag, targetMention, modTag, modMention, reason, extra = {}) {
  return brandEmbed(COLORS.brand, `Case #${extra.caseId ?? '—'} • ${action}`, null, {
    fields: [
      { name: 'User', value: `${targetTag}\n${targetMention}`, inline: true },
      { name: 'Moderator', value: `${modTag}\n${modMention}`, inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: false },
      ...(extra.detail ? [{ name: 'Details', value: extra.detail, inline: false }] : []),
    ],
  });
}
function nextCase(settings, action, userId, modId, reason) {
  settings.caseCounter = (settings.caseCounter || 0) + 1;
  settings.cases.push({ id: settings.caseCounter, action, user: userId, moderator: modId, reason: reason || '', timestamp: Date.now() });
  if (settings.cases.length > 500) settings.cases = settings.cases.slice(-500);
  scheduleFlush();
  return settings.caseCounter;
}
function parseOptions(data) {
  const map = new Map();
  for (const o of (data && data.options) || []) map.set(o.name, o);
  return map;
}
function opt(type, name, description, extra = {}) {
  const o = { type, name, description, required: !!extra.required };
  for (const k of ['choices', 'channel_types', 'min_value', 'max_value', 'max_length', 'min_length']) {
    if (extra[k] !== undefined) o[k] = extra[k];
  }
  return o;
}

// ─────────────────────────────────────────────── credentials / sessions
function hashPassword(password, salt) { return crypto.createHash('sha256').update(`${salt}:${password}`, 'utf8').digest('hex'); }
function createCredentials(guildId, username, password) {
  const settings = getGuild(guildId);
  const salt = crypto.randomBytes(16).toString('hex');
  settings.dashboard = { username, hash: hashPassword(password, salt), salt, createdAt: Date.now() };
  scheduleFlush();
  return settings.dashboard;
}
function verifyCredentials(guildId, username, password) {
  const dash = getGuild(guildId).dashboard;
  if (!dash || !username || !password) return false;
  const a = Buffer.from(String(username));
  const b = Buffer.from(String(dash.username));
  const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passOk = hashPassword(String(password), dash.salt) === dash.hash;
  return userOk && passOk;
}

const sessions = new Map(); // 'login:<token>' | 'session:<token>' -> { guildId, expiresAt }
function createLoginToken(guildId, discordUserId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(`login:${token}`, { guildId, discordUserId, expiresAt: Date.now() + 15 * 60 * 1000 });
  return token;
}
function consumeLoginToken(token) {
  const key = `login:${token}`;
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  sessions.delete(key);
  return entry;
}
function createSession(guildId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(`session:${token}`, { guildId, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const key = `session:${token}`;
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt < Date.now()) { if (entry) sessions.delete(key); return null; }
  return entry;
}
function destroySession(token) { if (token) sessions.delete(`session:${token}`); }

// ─────────────────────────────────────────────── command registry
const commands = {};
function def(name, description, options, perms) {
  commands[name] = { name, description, options: options || [], dm_permission: false, default_member_permissions: perms || null, execute: null, handleComponent: null, afterSend: null };
  return commands[name];
}
const OPTS = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8 };

// permission bits (discord.js style)
const PERM = {
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  ManageMessages: 1n << 13n,
  SendMessages: 1n << 11n,
  ManageRoles: 1n << 28n,
  ModerateMembers: 1n << 40n,
};
const permsStr = (name) => PERM[name].toString();

// ── /setuplogin — opens the LogPass web credential setup
const setuplogin = def('setuplogin', 'Open the LogPass web dashboard setup (Server Administrators only)', [], null);
setuplogin.execute = async (interaction) => {
  const guildId = interaction.guild_id;
  const userId = interaction.member.user.id;
  const token = createLoginToken(guildId, userId);
  const dash = getGuild(guildId).dashboard;
  const host = process.env.VERCEL_URL || process.env.RENDER_EXTERNAL_URL || '';
  const baseUrl = host ? `https://${host}` : 'https://YOUR-DEPLOYMENT-URL';
  const link = `${baseUrl}/login?token=${token}`;

  const embed = brandEmbed(COLORS.brand, '🔐 Dashboard Setup', [
    `Welcome to **${BRAND}**, your secure server management panel.`,
    '',
    dash
      ? '⚠️ Credentials already exist — the button below lets you **reset** them.'
      : 'Click the button below to set your dashboard **username** and **password**.',
    '',
    `**⏱️ Expires:** <t:${Math.floor((Date.now() + 15 * 60 * 1000) / 1000)}:R>`,
    `**👤 Only usable by:** <@${userId}>`,
  ].join('\n'));

  return {
    type: 4,
    data: {
      embeds: [embed],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: `Open ${BRAND} Setup`, url: link, emoji: { name: '🌐' } }] }],
      flags: 64,
    },
  };
};

// ── /ping
const ping = def('ping', "Check LogPass's latency and status", [], null);
ping.execute = async () => ({
  type: 4,
  data: { embeds: [infoEmbed(`🏓 **Pong!**\nMode: **webhook (serverless)**\nCold start: **${Math.floor((Date.now() - START_TIME) / 1000)}s** ago\nHealth: **✅ online**`)] },
});

// ── /help
const help = def('help', 'Show all LogPass commands', [], null);
help.execute = async () => ({
  type: 4,
  data: {
    embeds: [brandEmbed(COLORS.brand, '📖 Command List', [
      '**🛡️ Moderation**',
      '`/ban` `/unban` `/kick` `/timeout` `/untimeout` `/warn` `/warnings`',
      '`/purge` `/slowmode` `/lock` `/unlock` `/role` `/automod` `/setup` `/embed`',
      '',
      '**🎉 Fun**',
      '`/8ball` `/coinflip` `/dice` `/rps` `/meme` `/joke` `/hug` `/slap` `/pat`',
      '`/poll` `/trivia` `/ship` `/rate` `/avatar` `/say`',
      '',
      '**⚙️ Utility**',
      '`/ping` `/help` `/serverinfo` `/userinfo` `/setuplogin`',
    ].join('\n'))],
  },
});

// ── /ban
const ban = def('ban', 'Ban a member from the server', [
  opt(OPTS.USER, 'user', 'User to ban', { required: true }),
  opt(OPTS.STRING, 'reason', 'Reason for the ban', { max_length: 500 }),
  opt(OPTS.INTEGER, 'delete_days', 'Days of messages to delete', { choices: [{ name: '1 day', value: 1 }, { name: '3 days', value: 3 }, { name: '7 days', value: 7 }] }),
], permsStr('BanMembers'));
ban.execute = async (interaction) => {
  const { guild_id: guildId, member, token } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';
  const deleteDays = opts.has('delete_days') ? opts.get('delete_days').value : 0;
  const mod = member.user;

  if (target === mod.id) return { type: 4, data: { flags: 64, embeds: [errEmbed('You cannot ban yourself.')] } };

  const [targetUser, targetMember] = await Promise.all([
    rest.json('GET', `/users/${target}`).catch(() => null),
    rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null),
  ]);
  if (!targetUser) return { type: 4, data: { flags: 64, embeds: [errEmbed('Could not resolve that user.')] } };

  // hierarchy check only applies if target is a member
  if (targetMember) {
    const [me, roles] = await Promise.all([
      rest.json('GET', `/guilds/${guildId}/members/@me`).catch(() => null),
      rest.json('GET', `/guilds/${guildId}/roles`).catch(() => null),
    ]);
    if (me && roles) {
      const myTop = Math.max(0, ...(me.roles || []).map((r) => { const rr = roles.find((x) => x.id === r); return rr ? rr.position : 0; }));
      const targetTop = Math.max(0, ...(targetMember.roles || []).map((r) => { const rr = roles.find((x) => x.id === r); return rr ? rr.position : 0; }));
      if (targetTop >= myTop) return { type: 4, data: { flags: 64, embeds: [errEmbed("My highest role must be above the target user's highest role.")] } };
    }
  }

  sendDm(target, { embeds: [brandEmbed(COLORS.err, '🔨 You were banned', `**Server:** ${guildId}\n**Reason:** ${reason}`)] });
  const res = await rest.call('PUT', `/guilds/${guildId}/bans/${target}`, { delete_message_seconds: deleteDays * 86400 }, `${mod.username}: ${reason}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to ban — do I have the **Ban Members** permission? Is my role high enough?')] } };

  const settings = getGuild(guildId);
  const caseId = nextCase(settings, 'Ban', target, mod.id, reason);
  const embed = logEmbed('Ban', targetUser.username, `<@${target}>`, mod.username, `<@${mod.id}>`, reason, { caseId });
  sendModLog(guildId, embed);
  return { type: 4, data: { embeds: [brandEmbed(COLORS.err, `🔨 Case #${caseId} • Ban`, `<@${target}> has been banned. **Reason:** ${reason}`)] } };
};

// ── /unban
const unban = def('unban', 'Unban a user by ID', [
  opt(OPTS.STRING, 'user_id', 'ID of the banned user', { required: true }),
  opt(OPTS.STRING, 'reason', 'Reason', { max_length: 500 }),
], permsStr('BanMembers'));
unban.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const userId = opts.get('user_id').value;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';
  if (!/^\d{17,20}$/.test(userId)) return { type: 4, data: { flags: 64, embeds: [errEmbed('Please provide a valid user ID (17-20 digits).')] } };
  const res = await rest.call('DELETE', `/guilds/${guildId}/bans/${userId}`, null, `${member.user.username}: ${reason}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to unban — is that user actually banned?')] } };
  const settings = getGuild(guildId);
  const caseId = nextCase(settings, 'Unban', userId, member.user.id, reason);
  sendModLog(guildId, logEmbed('Unban', userId, `<@${userId}>`, member.user.username, `<@${member.user.id}>`, reason, { caseId }));
  return { type: 4, data: { embeds: [okEmbed(`<@${userId}> has been unbanned.`, `⚖️ Case #${caseId} • Unban`)] } };
};

// ── /kick
const kick = def('kick', 'Kick a member from the server', [
  opt(OPTS.USER, 'user', 'User to kick', { required: true }),
  opt(OPTS.STRING, 'reason', 'Reason for the kick', { max_length: 500 }),
], permsStr('KickMembers'));
kick.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';
  const mod = member.user;

  if (target === mod.id) return { type: 4, data: { flags: 64, embeds: [errEmbed('You cannot kick yourself.')] } };

  const targetMember = await rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null);
  if (!targetMember) return { type: 4, data: { flags: 64, embeds: [errEmbed('That user is not in this server. Use `/ban` instead.')] } };

  const [me, roles] = await Promise.all([
    rest.json('GET', `/guilds/${guildId}/members/@me`).catch(() => null),
    rest.json('GET', `/guilds/${guildId}/roles`).catch(() => null),
  ]);
  if (me && roles) {
    const myTop = Math.max(0, ...(me.roles || []).map((r) => { const rr = roles.find((x) => x.id === r); return rr ? rr.position : 0; }));
    const targetTop = Math.max(0, ...(targetMember.roles || []).map((r) => { const rr = roles.find((x) => x.id === r); return rr ? rr.position : 0; }));
    if (targetTop >= myTop) return { type: 4, data: { flags: 64, embeds: [errEmbed("My highest role must be above the target user's highest role.")] } };
  }

  sendDm(target, { embeds: [brandEmbed(COLORS.warn, '👢 You were kicked', `**Server:** ${guildId}\n**Reason:** ${reason}`)] });
  const res = await rest.call('DELETE', `/guilds/${guildId}/members/${target}`, null, `${mod.username}: ${reason}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to kick — do I have the **Kick Members** permission? Is my role high enough?')] } };

  const settings = getGuild(guildId);
  const caseId = nextCase(settings, 'Kick', target, mod.id, reason);
  sendModLog(guildId, logEmbed('Kick', targetMember.user.username, `<@${target}>`, mod.username, `<@${mod.id}>`, reason, { caseId }));
  return { type: 4, data: { embeds: [brandEmbed(COLORS.warn, `👢 Case #${caseId} • Kick`, `<@${target}> has been kicked. **Reason:** ${reason}`)] } };
};

// ── /timeout
const timeout = def('timeout', 'Timeout (mute) a member', [
  opt(OPTS.USER, 'user', 'User to timeout', { required: true }),
  opt(OPTS.INTEGER, 'duration', 'How long', { required: true, choices: DURATION_CHOICES }),
  opt(OPTS.STRING, 'reason', 'Reason for the timeout', { max_length: 500 }),
], permsStr('ModerateMembers'));
timeout.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const durationSec = opts.get('duration').value;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';
  const mod = member.user;

  if (target === mod.id) return { type: 4, data: { flags: 64, embeds: [errEmbed('You cannot timeout yourself.')] } };
  const targetMember = await rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null);
  if (!targetMember) return { type: 4, data: { flags: 64, embeds: [errEmbed('That user is not in this server.')] } };

  const res = await rest.call('PATCH', `/guilds/${guildId}/members/${target}`, { communication_disabled_until: new Date(Date.now() + durationSec * 1000).toISOString() }, `${mod.username}: ${reason}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to timeout — do I have the **Moderate Members** permission?')] } };

  const settings = getGuild(guildId);
  const caseId = nextCase(settings, 'Timeout', target, mod.id, `${reason} (${fmtMs(durationSec * 1000)})`);
  sendModLog(guildId, logEmbed('Timeout', targetMember.user.username, `<@${target}>`, mod.username, `<@${mod.id}>`, reason, { caseId, detail: `Duration: **${fmtMs(durationSec * 1000)}**` }));
  return { type: 4, data: { embeds: [brandEmbed(COLORS.warn, `🔇 Case #${caseId} • Timeout`, `<@${target}> has been timed out for **${fmtMs(durationSec * 1000)}**.`)] } };
};

// ── /untimeout
const untimeout = def('untimeout', 'Remove a timeout from a member', [
  opt(OPTS.USER, 'user', 'User to remove timeout from', { required: true }),
  opt(OPTS.STRING, 'reason', 'Reason', { max_length: 500 }),
], permsStr('ModerateMembers'));
untimeout.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';
  const targetMember = await rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null);
  if (!targetMember) return { type: 4, data: { flags: 64, embeds: [errEmbed('That user is not in this server.')] } };
  if (!targetMember.communication_disabled_until) return { type: 4, data: { flags: 64, embeds: [errEmbed('That user is not timed out.')] } };
  const res = await rest.call('PATCH', `/guilds/${guildId}/members/${target}`, { communication_disabled_until: null }, `${member.user.username}: ${reason}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to remove the timeout.')] } };
  const settings = getGuild(guildId);
  const caseId = nextCase(settings, 'Untimeout', target, member.user.id, reason);
  sendModLog(guildId, logEmbed('Untimeout', targetMember.user.username, `<@${target}>`, member.user.username, `<@${member.user.id}>`, reason, { caseId }));
  return { type: 4, data: { embeds: [okEmbed(`Timeout removed from <@${target}>.`, `🔊 Case #${caseId} • Untimeout`)] } };
};

// ── /warn
const warn = def('warn', 'Warn a member', [
  opt(OPTS.USER, 'user', 'User to warn', { required: true }),
  opt(OPTS.STRING, 'reason', 'Reason for the warning', { required: true, max_length: 500 }),
], permsStr('ModerateMembers'));
warn.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const reason = opts.get('reason').value;
  const mod = member.user;

  if (target === mod.id) return { type: 4, data: { flags: 64, embeds: [errEmbed('You cannot warn yourself.')] } };

  const settings = getGuild(guildId);
  if (!settings.warnings[target]) settings.warnings[target] = [];
  settings.warnings[target].push({ id: Date.now(), reason, moderator: mod.id, timestamp: Date.now() });
  const warnCount = settings.warnings[target].length;
  const caseId = nextCase(settings, 'Warn', target, mod.id, reason);

  const targetUser = await rest.json('GET', `/users/${target}`).catch(() => null);
  sendDm(target, { embeds: [brandEmbed(COLORS.warn, '⚠️ You received a warning', `**Reason:** ${reason}\n**Total warnings:** ${warnCount}`)] });
  sendModLog(guildId, logEmbed('Warn', targetUser ? targetUser.username : target, `<@${target}>`, mod.username, `<@${mod.id}>`, reason, { caseId }));
  return { type: 4, data: { embeds: [brandEmbed(COLORS.warn, `⚠️ Case #${caseId} • Warn`, `<@${target}> has been warned (warning **#${warnCount}**). **Reason:** ${reason}`)] } };
};

// ── /warnings
const warnings = def('warnings', "View or manage a user's warnings", [
  opt(OPTS.USER, 'user', 'User to check', { required: true }),
  opt(OPTS.STRING, 'action', 'Manage warnings', { choices: [{ name: 'list', value: 'list' }, { name: 'remove', value: 'remove' }, { name: 'clear', value: 'clear' }] }),
  opt(OPTS.INTEGER, 'index', 'Warning number to remove (from the list)', { min_value: 1 }),
], permsStr('ModerateMembers'));
warnings.execute = async (interaction) => {
  const { guild_id: guildId } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.get('user').value;
  const action = opts.has('action') ? opts.get('action').value : 'list';
  const index = opts.has('index') ? opts.get('index').value : null;
  const settings = getGuild(guildId);
  const list = settings.warnings[target] || [];

  if (action === 'remove') {
    if (!index) return { type: 4, data: { flags: 64, embeds: [errEmbed('You must provide a warning **index** to remove.')] } };
    if (index > list.length) return { type: 4, data: { flags: 64, embeds: [errEmbed(`That warning doesn't exist (user has ${list.length}).`)] } };
    const removed = list.splice(index - 1, 1)[0];
    scheduleFlush();
    return { type: 4, data: { embeds: [okEmbed(`Removed warning **#${index}** for <@${target}> (\`${removed.reason}\`).`)] } };
  }
  if (action === 'clear') {
    settings.warnings[target] = [];
    scheduleFlush();
    return { type: 4, data: { embeds: [okEmbed(`Cleared all warnings for <@${target}>.`)] } };
  }

  if (list.length === 0) return { type: 4, data: { embeds: [okEmbed(`<@${target}> has no warnings. 🎉`)] } };
  const fields = list.slice(0, 25).map((w, i) => ({
    name: `#${i + 1} — <t:${Math.floor(w.timestamp / 1000)}:R>`,
    value: `**Reason:** ${w.reason}\n**Moderator:** <@${w.moderator}>`,
  }));
  return { type: 4, data: { embeds: [brandEmbed(COLORS.warn, `⚠️ Warnings — <@${target}>`, null, { fields })] } };
};

// ── /purge
const purge = def('purge', 'Bulk delete recent messages in this channel', [
  opt(OPTS.INTEGER, 'amount', 'Number of messages (1-100)', { required: true, min_value: 1, max_value: 100 }),
  opt(OPTS.STRING, 'contains', 'Only delete messages containing this text'),
], permsStr('ManageMessages'));
purge.execute = async (interaction) => {
  const { guild_id: guildId, channel_id: channelId, token } = interaction;
  const opts = parseOptions(interaction.data);
  const amount = opts.get('amount').value;
  const contains = opts.has('contains') ? opts.get('contains').value : null;

  // defer: bulk delete can take a moment
  const respond = (payload) => sendFollowup(token, payload).catch(() => {});
  const respondEmbed = (embed) => respond({ flags: 64, embeds: [embed] });

  const messages = await rest.json('GET', `/channels/${channelId}/messages?limit=${Math.min(100, amount * 3)}`);
  if (!Array.isArray(messages)) { await respondEmbed(errEmbed('Could not fetch messages from this channel.')); return { type: 5 }; }

  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const deletable = messages.filter((m) => {
    if (m.pinned) return false;
    if (m.timestamp && new Date(m.timestamp).getTime() < twoWeeksAgo) return false;
    if (contains && !(m.content || '').toLowerCase().includes(contains.toLowerCase())) return false;
    return true;
  }).slice(0, amount).map((m) => m.id);

  if (deletable.length === 0) { await respondEmbed(errEmbed('No deletable messages found (messages older than 14 days cannot be bulk-deleted).')); return { type: 5 }; }

  const res = await rest.call('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: deletable });
  await respondEmbed(res.status < 300 ? okEmbed(`Deleted **${deletable.length}** message(s). 🧹`) : errEmbed('Bulk delete failed.'));
  return { type: 5 };
};

// ── /slowmode
const slowmode = def('slowmode', 'Set or disable slowmode in a channel', [
  opt(OPTS.INTEGER, 'seconds', 'Seconds between messages (0 to disable)', { required: true, min_value: 0, max_value: 21600 }),
  opt(OPTS.CHANNEL, 'channel', 'Channel (defaults to current)', { channel_types: [0] }),
], permsStr('ManageChannels'));
slowmode.execute = async (interaction) => {
  const { member } = interaction;
  const opts = parseOptions(interaction.data);
  const seconds = opts.get('seconds').value;
  const target = opts.has('channel') ? opts.get('channel').value : interaction.channel_id;
  const res = await rest.call('PATCH', `/channels/${target}`, { rate_limit_per_user: seconds }, `Slowmode set by ${member.user.username}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to set slowmode.')] } };
  return { type: 4, data: { embeds: [okEmbed(seconds === 0 ? `Disabled slowmode in <#${target}>.` : `Slowmode in <#${target}> set to **${seconds}s**.`)] } };
};

// ── /lock & /unlock
const lock = def('lock', "Lock a channel so members can't send messages", [
  opt(OPTS.CHANNEL, 'channel', 'Channel to lock (defaults to current)', { channel_types: [0] }),
  opt(OPTS.STRING, 'reason', 'Reason', { max_length: 200 }),
], permsStr('ManageChannels'));
lock.execute = async (interaction) => {
  const { guild_id: guildId, member, token } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.has('channel') ? opts.get('channel').value : interaction.channel_id;
  const reason = opts.has('reason') ? opts.get('reason').value : 'No reason provided';

  const res = await rest.call('PUT', `/channels/${target}/permissions/@everyone`, { type: 0, id: guildId, deny: String(PERM.SendMessages) }, `Locked by ${member.user.username}: ${reason}`);
  if (res.status >= 300) { await sendFollowup(token, { flags: 64, embeds: [errEmbed('Failed to lock the channel.')]}).catch(() => {}); return { type: 5 }; }
  await sendFollowup(token, { embeds: [okEmbed(`🔒 Locked <#${target}>. **Reason:** ${reason}`)] }).catch(() => {});
  return { type: 5 };
};

const unlock = def('unlock', 'Unlock a previously locked channel', [
  opt(OPTS.CHANNEL, 'channel', 'Channel to unlock (defaults to current)', { channel_types: [0] }),
], permsStr('ManageChannels'));
unlock.execute = async (interaction) => {
  const { guild_id: guildId, member, token } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.has('channel') ? opts.get('channel').value : interaction.channel_id;
  const res = await rest.call('PUT', `/channels/${target}/permissions/@everyone`, { type: 0, id: guildId, allow: String(PERM.SendMessages) }, `Unlocked by ${member.user.username}`);
  if (res.status >= 300) { await sendFollowup(token, { flags: 64, embeds: [errEmbed('Failed to unlock the channel.')]}).catch(() => {}); return { type: 5 }; }
  await sendFollowup(token, { embeds: [okEmbed(`🔓 Unlocked <#${target}>.`)] }).catch(() => {});
  return { type: 5 };
};

// ── /role
const role = def('role', 'Add or remove a role from a member', [
  { type: OPTS.SUB_COMMAND, name: 'add', description: 'Add a role to a member', options: [opt(OPTS.USER, 'user', 'Target user', { required: true }), opt(OPTS.ROLE, 'role', 'Role to add', { required: true })] },
  { type: OPTS.SUB_COMMAND, name: 'remove', description: 'Remove a role from a member', options: [opt(OPTS.USER, 'user', 'Target user', { required: true }), opt(OPTS.ROLE, 'role', 'Role to remove', { required: true })] },
], permsStr('ManageRoles'));
role.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const sub = interaction.data.options[0].name;
  const subOpts = parseOptions({ options: interaction.data.options[0].options });
  const target = subOpts.get('user').value;
  const roleId = subOpts.get('role').value;

  const [targetMember, me, roles] = await Promise.all([
    rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null),
    rest.json('GET', `/guilds/${guildId}/members/@me`).catch(() => null),
    rest.json('GET', `/guilds/${guildId}/roles`).catch(() => null),
  ]);
  if (!targetMember) return { type: 4, data: { flags: 64, embeds: [errEmbed('That user is not in this server.')] } };
  if (roles && me) {
    const roleObj = roles.find((r) => r.id === roleId);
    const myTop = Math.max(0, ...(me.roles || []).map((r) => { const rr = roles.find((x) => x.id === r); return rr ? rr.position : 0; }));
    if (roleObj && roleObj.position >= myTop) return { type: 4, data: { flags: 64, embeds: [errEmbed('My highest role must be above that role.')] } };
  }
  const memberRoles = new Set(targetMember.roles || []);
  if (sub === 'add') memberRoles.add(roleId); else memberRoles.delete(roleId);
  const res = await rest.call('PATCH', `/guilds/${guildId}/members/${target}`, { roles: [...memberRoles] }, `Role ${sub} by ${member.user.username}`);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('Failed to update roles.')] } };
  return { type: 4, data: { embeds: [okEmbed(sub === 'add' ? `Added <@&${roleId}> to <@${target}>.` : `Removed <@&${roleId}> from <@${target}>.`)] } };
};

// ── /automod
const automod = def('automod', 'Configure the LogPass automod system', [
  { type: OPTS.SUB_COMMAND, name: 'status', description: 'Show current automod settings', options: [] },
  { type: OPTS.SUB_COMMAND, name: 'toggle', description: 'Enable or disable automod', options: [opt(OPTS.BOOLEAN, 'enabled', 'Enable automod?', { required: true })] },
  { type: OPTS.SUB_COMMAND, name: 'antispam', description: 'Toggle anti-spam (7+ messages in 10s)', options: [opt(OPTS.BOOLEAN, 'enabled', 'Enable anti-spam?', { required: true })] },
  { type: OPTS.SUB_COMMAND, name: 'antiinvite', description: 'Toggle invite link blocking', options: [opt(OPTS.BOOLEAN, 'enabled', 'Block invite links?', { required: true })] },
  { type: OPTS.SUB_COMMAND, name: 'antilink', description: 'Toggle all link blocking', options: [opt(OPTS.BOOLEAN, 'enabled', 'Block all links?', { required: true })] },
  { type: OPTS.SUB_COMMAND, name: 'maxmentions', description: 'Max mentions allowed per message', options: [opt(OPTS.INTEGER, 'max', 'Max mentions (1-20)', { required: true, min_value: 1, max_value: 20 })] },
  { type: OPTS.SUB_COMMAND, name: 'addword', description: 'Add a banned word', options: [opt(OPTS.STRING, 'word', 'Word to ban', { required: true, max_length: 100 })] },
  { type: OPTS.SUB_COMMAND, name: 'removeword', description: 'Remove a banned word', options: [opt(OPTS.STRING, 'word', 'word to unban', { required: true, max_length: 100 })] },
  { type: OPTS.SUB_COMMAND, name: 'words', description: 'List banned words', options: [] },
  { type: OPTS.SUB_COMMAND, name: 'setmodlog', description: 'Set the moderation log channel', options: [opt(OPTS.CHANNEL, 'channel', 'Mod log channel', { required: true, channel_types: [0] })] },
], permsStr('ManageGuild'));
automod.execute = async (interaction) => {
  const { guild_id: guildId } = interaction;
  const settings = getGuild(guildId);
  const sub = interaction.data.options[0].name;
  const get = (n) => (interaction.data.options[0].options || []).find((o) => o.name === n);

  switch (sub) {
    case 'status': {
      const am = settings.automod;
      const embed = brandEmbed(COLORS.brand, '🛡️ Automod Settings', null, {
        fields: [
          { name: 'Enabled', value: am.enabled ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Anti-spam', value: am.antiSpam ? '✅ On' : '❌ Off', inline: true },
          { name: 'Anti-invite', value: am.antiInvite ? '✅ On' : '❌ Off', inline: true },
          { name: 'Anti-link', value: am.antiLink ? '✅ On' : '❌ Off', inline: true },
          { name: 'Max mentions', value: String(am.maxMentions), inline: true },
          { name: 'Banned words', value: am.bannedWords.length ? am.bannedWords.map((w) => `\`${w}\``).join(', ').slice(0, 1000) : 'None', inline: false },
          { name: 'Mod log channel', value: settings.modLogChannel ? `<#${settings.modLogChannel}>` : 'Not set', inline: false },
        ],
      });
      return { type: 4, data: { flags: 64, embeds: [embed] } };
    }
    case 'toggle': { settings.automod.enabled = get('enabled').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Automod is now **${settings.automod.enabled ? 'enabled' : 'disabled'}**.`)] } }; }
    case 'antispam': { settings.automod.antiSpam = get('enabled').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Anti-spam is now **${settings.automod.antiSpam ? 'on' : 'off'}**.`)] } }; }
    case 'antiinvite': { settings.automod.antiInvite = get('enabled').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Anti-invite is now **${settings.automod.antiInvite ? 'on' : 'off'}**.`)] } }; }
    case 'antilink': { settings.automod.antiLink = get('enabled').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Anti-link is now **${settings.automod.antiLink ? 'on' : 'off'}**.`)] } }; }
    case 'maxmentions': { settings.automod.maxMentions = get('max').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Max mentions per message set to **${settings.automod.maxMentions}**.`)] } }; }
    case 'addword': {
      const word = get('word').value.toLowerCase().trim();
      if (settings.automod.bannedWords.includes(word)) return { type: 4, data: { flags: 64, embeds: [errEmbed('That word is already banned.')] } };
      settings.automod.bannedWords.push(word);
      scheduleFlush();
      return { type: 4, data: { embeds: [okEmbed(`Banned the word \`${word}\`.`)] } };
    }
    case 'removeword': {
      const word = get('word').value.toLowerCase().trim();
      const idx = settings.automod.bannedWords.indexOf(word);
      if (idx === -1) return { type: 4, data: { flags: 64, embeds: [errEmbed('That word is not banned.')] } };
      settings.automod.bannedWords.splice(idx, 1);
      scheduleFlush();
      return { type: 4, data: { embeds: [okEmbed(`Unbanned the word \`${word}\`.`)] } };
    }
    case 'words': {
      const words = settings.automod.bannedWords;
      return { type: 4, data: { flags: 64, embeds: [brandEmbed(COLORS.brand, '🚫 Banned Words', words.length ? words.map((w) => `\`${w}\``).join(', ').slice(0, 2000) : 'None set.')] } };
    }
    case 'setmodlog': {
      settings.modLogChannel = get('channel').value;
      scheduleFlush();
      return { type: 4, data: { embeds: [okEmbed(`Mod log channel set to <#${settings.modLogChannel}>.`)] } };
    }
  }
  return { type: 4, data: { flags: 64, embeds: [errEmbed('Unknown subcommand.')] } };
};

// ── /setup
const setup = def('setup', 'Configure welcome, goodbye, auto-role and more', [
  { type: OPTS.SUB_COMMAND, name: 'welcome', description: 'Set the welcome channel', options: [opt(OPTS.CHANNEL, 'channel', 'Welcome channel', { required: true, channel_types: [0] })] },
  { type: OPTS.SUB_COMMAND, name: 'goodbye', description: 'Set the goodbye channel', options: [opt(OPTS.CHANNEL, 'channel', 'Goodbye channel', { required: true, channel_types: [0] })] },
  { type: OPTS.SUB_COMMAND, name: 'welcomemessage', description: 'Set the welcome message', options: [opt(OPTS.STRING, 'message', 'Use {user} {mention} {server} {count}', { required: true, max_length: 500 })] },
  { type: OPTS.SUB_COMMAND, name: 'goodbyemessage', description: 'Set the goodbye message', options: [opt(OPTS.STRING, 'message', 'Use {user} {mention} {server} {count}', { required: true, max_length: 500 })] },
  { type: OPTS.SUB_COMMAND, name: 'joinrole', description: 'Set a role automatically given to new members', options: [opt(OPTS.ROLE, 'role', 'Role (omit to disable)')] },
  { type: OPTS.SUB_COMMAND, name: 'show', description: 'Show current settings', options: [] },
], permsStr('ManageGuild'));
setup.execute = async (interaction) => {
  const { guild_id: guildId } = interaction;
  const settings = getGuild(guildId);
  const sub = interaction.data.options[0].name;
  const get = (n) => (interaction.data.options[0].options || []).find((o) => o.name === n);

  switch (sub) {
    case 'welcome': { settings.welcomeChannel = get('channel').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Welcome channel set to <#${settings.welcomeChannel}>.`)] } }; }
    case 'goodbye': { settings.goodbyeChannel = get('channel').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed(`Goodbye channel set to <#${settings.goodbyeChannel}>.`)] } }; }
    case 'welcomemessage': { settings.welcomeMessage = get('message').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed('Welcome message updated. Placeholders: `{user}` `{mention}` `{server}` `{count}`')] } }; }
    case 'goodbyemessage': { settings.goodbyeMessage = get('message').value; scheduleFlush(); return { type: 4, data: { embeds: [okEmbed('Goodbye message updated.')] } }; }
    case 'joinrole': {
      const roleOpt = get('role');
      settings.joinRole = roleOpt ? roleOpt.value : null;
      scheduleFlush();
      return { type: 4, data: { embeds: [okEmbed(settings.joinRole ? `New members will now receive <@&${settings.joinRole}>.` : 'Auto-role disabled.')] } };
    }
    case 'show': {
      const embed = infoEmbed([
        `**Welcome channel:** ${settings.welcomeChannel ? `<#${settings.welcomeChannel}>` : 'not set'}`,
        `**Welcome message:** ${settings.welcomeMessage}`,
        `**Goodbye channel:** ${settings.goodbyeChannel ? `<#${settings.goodbyeChannel}>` : 'not set'}`,
        `**Goodbye message:** ${settings.goodbyeMessage}`,
        `**Join role:** ${settings.joinRole ? `<@&${settings.joinRole}>` : 'not set'}`,
        `**Mod log channel:** ${settings.modLogChannel ? `<#${settings.modLogChannel}>` : 'not set'}`,
        `**Dashboard login:** ${settings.dashboard ? `✅ configured (user: \`${settings.dashboard.username}\`)` : 'not set — use `/setuplogin`'}`,
      ].join('\n'), '⚙️ Server Settings');
      return { type: 4, data: { flags: 64, embeds: [embed] } };
    }
  }
  return { type: 4, data: { flags: 64, embeds: [errEmbed('Unknown subcommand.')] } };
};

// ── /embed
const embed = def('embed', 'Send a custom embed message (moderators)', [
  opt(OPTS.STRING, 'title', 'Embed title', { required: true, max_length: 256 }),
  opt(OPTS.STRING, 'description', 'Embed description', { required: true, max_length: 2000 }),
  opt(OPTS.STRING, 'color', 'Hex color like #5865f2'),
  opt(OPTS.STRING, 'image_url', 'Image URL to attach'),
  opt(OPTS.CHANNEL, 'channel', 'Where to send it', { channel_types: [0] }),
], permsStr('ManageMessages'));
embed.execute = async (interaction) => {
  const { channel_id: channelId } = interaction;
  const opts = parseOptions(interaction.data);
  const title = opts.get('title').value;
  const description = opts.get('description').value;
  const target = opts.has('channel') ? opts.get('channel').value : channelId;

  let color = COLORS.brand;
  if (opts.has('color')) {
    const raw = String(opts.get('color').value);
    const parsed = parseInt(raw.replace('#', ''), 16);
    if (Number.isNaN(parsed) || raw.length > 7) return { type: 4, data: { flags: 64, embeds: [errEmbed('Invalid color. Use hex like `#ff0000`.')] } };
    color = parsed;
  }
  const data = { embeds: [{ title, description, color, timestamp: new Date().toISOString(), footer: { text: BRAND, icon_url: LOGO_URL } }] };
  if (opts.has('image_url')) {
    const url = opts.get('image_url').value;
    if (!/^https?:\/\//.test(url)) return { type: 4, data: { flags: 64, embeds: [errEmbed('Image URL must start with http(s)://')] } };
    data.embeds[0].image = { url };
  }
  const res = await rest.call('POST', `/channels/${target}/messages`, data);
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed(`Couldn't send to <#${target}> — missing permissions?`)] } };
  return { type: 4, data: { flags: 64, embeds: [okEmbed(`Embed sent to <#${target}>.`)] } };
};

// ── /serverinfo
const serverinfo = def('serverinfo', 'Show information about this server', [], null);
serverinfo.execute = async (interaction) => {
  const { guild_id: guildId } = interaction;
  const g = await rest.json('GET', `/guilds/${guildId}?with_counts=true`).catch(() => null);
  if (!g) return { type: 4, data: { flags: 64, embeds: [errEmbed('Could not fetch server info.')] } };
  const settings = getGuild(guildId);
  return {
    type: 4,
    data: {
      embeds: [brandEmbed(COLORS.brand, `ℹ️ ${g.name}`, null, {
        thumbnail: g.icon ? { url: `https://cdn.discordapp.com/icons/${guildId}/${g.icon}.png?size=512` } : undefined,
        fields: [
          { name: '👑 Owner', value: `<@${g.owner_id}>`, inline: true },
          { name: '👥 Members', value: String(g.approximate_member_count ?? '?'), inline: true },
          { name: '🟢 Online', value: String(g.approximate_presence_count ?? '?'), inline: true },
          { name: '🗓️ Created', value: `<t:${Math.floor(snowflakeDate(guildId).getTime() / 1000)}:R>`, inline: true },
          { name: '✨ Boosts', value: `${g.premium_subscription_count || 0} (Level ${g.premium_tier})`, inline: true },
          { name: '🛡️ Automod', value: settings.automod.enabled ? 'Enabled' : 'Disabled', inline: true },
        ],
      })],
    },
  };
};

// ── /userinfo
const userinfo = def('userinfo', 'Show information about a user', [
  opt(OPTS.USER, 'user', 'User (defaults to you)'),
], null);
userinfo.execute = async (interaction) => {
  const { guild_id: guildId, member } = interaction;
  const opts = parseOptions(interaction.data);
  const target = opts.has('user') ? opts.get('user').value : member.user.id;
  const settings = getGuild(guildId);
  const warnCount = (settings.warnings[target] || []).length;
  const targetMember = await rest.json('GET', `/guilds/${guildId}/members/${target}`).catch(() => null);
  const user = targetMember ? targetMember.user : await rest.json('GET', `/users/${target}`).catch(() => null);
  if (!user) return { type: 4, data: { flags: 64, embeds: [errEmbed('Could not fetch that user.')] } };

  const fields = [
    { name: '🆔 ID', value: user.id, inline: true },
    { name: '🤖 Bot?', value: user.bot ? 'Yes' : 'No', inline: true },
    { name: '🗓️ Account created', value: `<t:${Math.floor(snowflakeDate(user.id).getTime() / 1000)}:R>`, inline: true },
    { name: '⚠️ Warnings', value: String(warnCount), inline: true },
  ];
  if (targetMember) {
    fields.push({ name: '📥 Joined server', value: targetMember.joined_at ? `<t:${Math.floor(new Date(targetMember.joined_at).getTime() / 1000)}:R>` : 'unknown', inline: true });
    fields.push({ name: '🎭 Roles', value: (targetMember.roles || []).slice(0, 20).map((r) => `<@&${r}>`).join(', ').slice(0, 1024) || 'None', inline: false });
  }
  return {
    type: 4,
    data: {
      embeds: [brandEmbed(COLORS.brand, `👤 ${user.username}`, null, {
        fields,
        thumbnail: user.avatar ? { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=512` } : undefined,
      })],
    },
  };
};

// ─────────────────────────────────────────────── fun commands
const responses8 = ['It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.', 'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.', "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'];
const eightball = def('8ball', 'Ask the magic 8-ball a question', [opt(OPTS.STRING, 'question', 'Your question for the 8-ball', { required: true, max_length: 200 })], null);
eightball.execute = async (interaction) => {
  const question = parseOptions(interaction.data).get('question').value;
  const answer = responses8[Math.floor(Math.random() * responses8.length)];
  return { type: 4, data: { embeds: [infoEmbed(`🎱 **Question:** ${question}\n**Answer:** ${answer}`)] } };
};

const coinflip = def('coinflip', 'Flip a coin', [opt(OPTS.INTEGER, 'count', 'How many coins to flip (1-10)', { min_value: 1, max_value: 10 })], null);
coinflip.execute = async (interaction) => {
  const opts = parseOptions(interaction.data);
  const count = opts.has('count') ? opts.get('count').value : 1;
  const results = [];
  for (let i = 0; i < count; i++) results.push(Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails');
  const heads = results.filter((r) => r.includes('Heads')).length;
  return { type: 4, data: { embeds: [infoEmbed(`${results.join(' · ')}\n\n**Result:** ${heads} heads / ${count - heads} tails`)] } };
};

const dice = def('dice', 'Roll dice (e.g. 2d6 = two six-sided dice)', [opt(OPTS.STRING, 'roll', 'Dice notation, like 2d6 or d20', { required: true, max_length: 20 })], null);
dice.execute = async (interaction) => {
  const notation = parseOptions(interaction.data).get('roll').value.toLowerCase().trim();
  const m = /^(\d*)d(\d+)$/.exec(notation);
  if (!m) return { type: 4, data: { flags: 64, content: '❌ Invalid format! Use `2d6`, `d20`, `3d10`, etc.' } };
  const count = Math.min(parseInt(m[1] || '1', 10), 20);
  const sides = Math.min(parseInt(m[2], 10), 1000);
  if (sides < 2) return { type: 4, data: { flags: 64, content: '❌ A die needs at least 2 sides!' } };
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  return { type: 4, data: { embeds: [infoEmbed(`🎲 **${count}d${sides}** → ${count === 1 ? String(rolls[0]) : `[ ${rolls.join(', ')} ]`}\n**Total:** ${total}`)] } };
};

const rps = def('rps', 'Play rock-paper-scissors against LogPass', [opt(OPTS.STRING, 'choice', 'Your choice', { required: true, choices: [{ name: '🪨 Rock', value: 'rock' }, { name: '📄 Paper', value: 'paper' }, { name: '✂️ Scissors', value: 'scissors' }] })], null);
rps.execute = async (interaction) => {
  const userChoice = parseOptions(interaction.data).get('choice').value;
  const choices = ['rock', 'paper', 'scissors'];
  const emoji = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const botChoice = choices[Math.floor(Math.random() * choices.length)];
  let result;
  if (userChoice === botChoice) result = "It's a tie!";
  else if ((userChoice === 'rock' && botChoice === 'scissors') || (userChoice === 'paper' && botChoice === 'rock') || (userChoice === 'scissors' && botChoice === 'paper')) result = 'You win! 🎉';
  else result = 'I win! 😎';
  return { type: 4, data: { embeds: [infoEmbed(`**You:** ${emoji[userChoice]} ${userChoice}\n**Me:** ${emoji[botChoice]} ${botChoice}\n\n**${result}**`)] } };
};

const meme = def('meme', 'Get a random meme from Reddit', [], null);
meme.execute = async () => {
  const subs = ['memes', 'dankmemes', 'wholesomememes', 'me_irl'];
  const sub = subs[Math.floor(Math.random() * subs.length)];
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=50`, { headers: { 'User-Agent': 'LogPass/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const posts = json.data.children.map((c) => c.data).filter((p) => !p.stickied && p.post_hint === 'image' && !p.over_18);
    if (!posts.length) throw new Error('no posts');
    const post = posts[Math.floor(Math.random() * posts.length)];
    return { type: 4, data: { embeds: [brandEmbed(COLORS.brand, post.title.slice(0, 256), null, { image: { url: post.url }, url: `https://reddit.com${post.permalink}`, footer: { text: `👍 ${post.ups} · r/${sub} • ${BRAND}`, icon_url: LOGO_URL } })] } };
  } catch {
    return { type: 4, data: { flags: 64, content: "❌ Couldn't fetch a meme right now — Reddit is probably rate-limiting. Try again in a bit!" } };
  }
};

const jokes = ["Why don't scientists trust atoms? Because they make up everything!", 'Why did the scarecrow win an award? He was outstanding in his field.', 'I told my wife she was drawing her eyebrows too high. She looked surprised.', "Why don't skeletons fight each other? They don't have the guts.", 'What do you call a fake noodle? An impasta.', 'I used to hate facial hair, but then it grew on me.', 'Why did the bicycle fall over? Because it was two-tired.', "What do you call cheese that isn't yours? Nacho cheese.", "Why can't you give Elsa a balloon? Because she'll let it go.", "I'm reading a book about anti-gravity. It's impossible to put down!", 'What did the ocean say to the beach? Nothing, it just waved.', 'Why did the math book look sad? Too many problems.', 'What do you call a bear with no teeth? A gummy bear.', 'Why did the golfer bring two pairs of pants? In case he got a hole in one.', 'What do you call a sleeping bull? A bulldozer.', 'How does a penguin build its house? Igloos it together.', 'What do you call a fish without eyes? A fsh.', "I would tell you a joke about construction, but I'm still working on it.", "Why don't eggs tell jokes? They'd crack each other up.", "What do you call a can opener that doesn't work? A can't opener."];
const joke = def('joke', 'Tell a random joke', [], null);
joke.execute = async () => ({ type: 4, data: { embeds: [infoEmbed(`😂 ${jokes[Math.floor(Math.random() * jokes.length)]}`)] } });

const hug = def('hug', 'Give someone a hug', [opt(OPTS.USER, 'user', 'Who to hug', { required: true })], null);
hug.execute = async (interaction) => {
  const user = parseOptions(interaction.data).get('user').value;
  return { type: 4, data: { embeds: [infoEmbed(`<@${interaction.member.user.id}> hugs <@${user}>! 🤗`)] } };
};

const slap = def('slap', 'Slap someone (playfully!)', [opt(OPTS.USER, 'user', 'Who to slap', { required: true })], null);
slap.execute = async (interaction) => {
  const user = parseOptions(interaction.data).get('user').value;
  if (user === interaction.application_id) return { type: 4, data: { flags: 64, content: '😢 How could you?! *runs away*' } };
  return { type: 4, data: { embeds: [infoEmbed(`<@${interaction.member.user.id}> slaps <@${user}>! 💥`)] } };
};

const pat = def('pat', 'Pat someone on the head', [opt(OPTS.USER, 'user', 'Who to pat', { required: true })], null);
pat.execute = async (interaction) => {
  const user = parseOptions(interaction.data).get('user').value;
  return { type: 4, data: { embeds: [infoEmbed(`<@${interaction.member.user.id}> pats <@${user}>! 🥰`)] } };
};

const poll = def('poll', 'Create a reaction poll with buttons', [
  opt(OPTS.STRING, 'question', 'Poll question', { required: true, max_length: 200 }),
  opt(OPTS.STRING, 'option1', 'Option 1 (leave all blank for yes/no)', { max_length: 80 }),
  opt(OPTS.STRING, 'option2', 'Option 2', { max_length: 80 }),
  opt(OPTS.STRING, 'option3', 'Option 3', { max_length: 80 }),
  opt(OPTS.STRING, 'option4', 'Option 4', { max_length: 80 }),
], null);
const pollVotes = new Map(); // messageId -> { choices, emojis, votes:Map }
poll.execute = async (interaction) => {
  const opts = parseOptions(interaction.data);
  const question = opts.get('question').value;
  const options = [1, 2, 3, 4].map((n) => opts.get(`option${n}`)).filter(Boolean).map((o) => o.value);
  if (options.length === 1) return { type: 4, data: { flags: 64, content: '❌ Give at least 2 options (or none for a yes/no poll).' } };

  const choices = options.length ? options : ['Yes', 'No'];
  const emojis = options.length ? ['1️⃣', '2️⃣', '3️⃣', '4️⃣'] : ['👍', '👎'];
  const embedData = { title: `📊 ${question}`, description: choices.map((c, i) => `${emojis[i]} ${c} — **0** vote(s)`).join('\n'), color: COLORS.brand, footer: { text: `Poll by ${interaction.member.user.username} • ${BRAND}`, icon_url: LOGO_URL } };
  const row = { type: 1, components: choices.map((c, i) => ({ type: 2, style: 2, label: `${emojis[i]} ${c}`.slice(0, 80), custom_id: `poll:${i}`, emoji: { name: emojis[i] } })) };
  return { type: 4, data: { embeds: [embedData], components: [row] } };
};
poll.afterSend = (interaction, message) => {
  const opts = parseOptions(interaction.data);
  const options = [1, 2, 3, 4].map((n) => opts.get(`option${n}`)).filter(Boolean).map((o) => o.value);
  pollVotes.set(message.id, { choices: options.length ? options : ['Yes', 'No'], emojis: options.length ? ['1️⃣', '2️⃣', '3️⃣', '4️⃣'] : ['👍', '👎'], votes: new Map() });
};
poll.handleComponent = (interaction) => {
  const pollData = pollVotes.get(interaction.message.id);
  if (!pollData) return { type: 4, data: { flags: 64, content: '❌ This poll has expired (the bot restarted).' } };
  const idx = parseInt(interaction.data.custom_id.split(':')[1], 10);
  const userId = interaction.member.user.id;
  if (pollData.votes.get(userId) === idx) pollData.votes.delete(userId);
  else pollData.votes.set(userId, idx);
  const embedData = interaction.message.embeds[0];
  embedData.description = pollData.choices.map((c, i) => `${pollData.emojis[i]} ${c} — **${[...pollData.votes.values()].filter((v) => v === i).length}** vote(s)`).join('\n');
  embedData.footer = { text: `Poll by ${interaction.member.user.username} • ${pollData.votes.size} total vote(s) • ${BRAND}`, icon_url: LOGO_URL };
  return { type: 7, data: { embeds: [embedData], components: interaction.message.components } };
};

const trivia = def('trivia', 'Play a trivia question — first correct answer wins!', [], null);
const triviaGames = new Map(); // messageId -> { correct, options, expiresAt, answered:Set }
trivia.execute = async (interaction) => {
  try {
    const res = await fetch('https://opentdb.com/api.php?amount=1&type=multiple');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const q = json.results[0];
    const decode = (html) => html.replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    const question = decode(q.question);
    const correct = decode(q.correct_answer);
    const options = [...q.incorrect_answers.map(decode), correct].map((s) => s.slice(0, 80)).sort(() => Math.random() - 0.5);
    triviaGames.set('_pending', { correct: options.indexOf(correct), options });
    const embedData = { title: `🧠 ${q.category}`, description: `**${question}**`, color: COLORS.brand, footer: { text: `Difficulty: ${q.difficulty} • First correct answer wins! • ${BRAND}`, icon_url: LOGO_URL } };
    const row = { type: 1, components: options.map((o, i) => ({ type: 2, style: 2, label: o, custom_id: `trivia:${i}` })) };
    return { type: 4, data: { embeds: [embedData], components: [row] } };
  } catch {
    return { type: 4, data: { flags: 64, content: "❌ Couldn't fetch a trivia question. Try again!" } };
  }
};
trivia.afterSend = (interaction, message) => {
  const pending = triviaGames.get('_pending');
  if (pending) {
    triviaGames.delete('_pending');
    pending.expiresAt = Date.now() + 60000;
    pending.answered = new Set();
    triviaGames.set(message.id, pending);
  }
};
trivia.handleComponent = (interaction) => {
  const game = triviaGames.get(interaction.message.id);
  if (!game || Date.now() > game.expiresAt) { triviaGames.delete(interaction.message.id); return { type: 4, data: { flags: 64, content: '❌ This trivia round has ended.' } }; }
  const chosen = parseInt(interaction.data.custom_id.split(':')[1], 10);
  const userId = interaction.member.user.id;
  if (game.answered.has(userId)) return { type: 4, data: { flags: 64, content: '❌ You already answered this round!' } };
  game.answered.add(userId);
  if (chosen === game.correct) {
    triviaGames.delete(interaction.message.id);
    const embedData = interaction.message.embeds[0];
    embedData.description = `${embedData.description}\n\n🎉 **${interaction.member.user.username} got it right!** The answer was: **${game.options[game.correct]}**`;
    return { type: 7, data: { embeds: [embedData], components: [] } };
  }
  return { type: 4, data: { flags: 64, content: `❌ Wrong, <@${userId}>! Try again.` } };
};

const ship = def('ship', 'See how compatible two users are 💕', [opt(OPTS.USER, 'user1', 'First user', { required: true }), opt(OPTS.USER, 'user2', 'Second user (defaults to you)')], null);
ship.execute = async (interaction) => {
  const opts = parseOptions(interaction.data);
  const user1 = opts.get('user1').value;
  const user2 = opts.has('user2') ? opts.get('user2').value : interaction.member.user.id;
  const seed = parseInt(user1.slice(-6), 10) + parseInt(user2.slice(-6), 10);
  const percent = seed % 101;
  const hearts = '❤️'.repeat(Math.round(percent / 10)) + '🖤'.repeat(10 - Math.round(percent / 10));
  let verdict;
  if (percent >= 90) verdict = '💞 A match made in heaven!';
  else if (percent >= 70) verdict = '💕 Looking great together!';
  else if (percent >= 50) verdict = "🤝 There's potential here.";
  else if (percent >= 30) verdict = "😬 It's complicated...";
  else verdict = '💔 Better stay friends.';
  return { type: 4, data: { embeds: [brandEmbed(0xeb459e, `💘 ${user1 === user2 ? 'Self-love check' : 'Ship Result'}`, `\`${hearts}\`\n**${percent}%**\n\n${verdict}`)] } };
};

const rate = def('rate', 'Rate something or someone out of 10', [opt(OPTS.STRING, 'thing', 'What should I rate?', { required: true, max_length: 100 })], null);
rate.execute = async (interaction) => {
  const thing = parseOptions(interaction.data).get('thing').value;
  let hash = 0;
  for (const ch of thing.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 1000;
  const rating = hash % 11;
  const stars = '⭐'.repeat(Math.max(1, Math.round(rating / 2)));
  return { type: 4, data: { embeds: [infoEmbed(`🔍 I'd rate **${thing}** a **${rating}/10** ${stars}${rating >= 8 ? ' — excellent taste!' : rating <= 2 ? ' ...yikes.' : ''}`)] } };
};

const avatar = def('avatar', "Show a user's avatar in full size", [opt(OPTS.USER, 'user', 'User (defaults to you)')], null);
avatar.execute = async (interaction) => {
  const opts = parseOptions(interaction.data);
  const userId = opts.has('user') ? opts.get('user').value : interaction.member.user.id;
  const user = await rest.json('GET', `/users/${userId}`).catch(() => null);
  if (!user) return { type: 4, data: { flags: 64, embeds: [errEmbed('Could not fetch that user.')] } };
  const url = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=1024` : `https://cdn.discordapp.com/embed/avatars/0.png`;
  return { type: 4, data: { embeds: [brandEmbed(COLORS.brand, `🖼️ ${user.username}'s avatar`, null, { image: { url }, footer: { text: `ID: ${user.id} • ${BRAND}`, icon_url: LOGO_URL } })] } };
};

const say = def('say', 'Make LogPass say something', [opt(OPTS.STRING, 'message', 'What to say', { required: true, max_length: 500 })], permsStr('ManageMessages'));
say.execute = async (interaction) => {
  const message = parseOptions(interaction.data).get('message').value;
  const res = await rest.call('POST', `/channels/${interaction.channel_id}/messages`, { content: message });
  if (res.status >= 300) return { type: 4, data: { flags: 64, embeds: [errEmbed('I could not send that message (missing permissions?).')] } };
  return { type: 4, data: { flags: 64, embeds: [okEmbed('Message sent.')] } };
};

// ─────────────────────────────────────────────── interaction dispatcher
function errReply() { return { type: 4, data: { flags: 64, embeds: [errEmbed('There was an error executing that command!')] } }; }

async function handleCommand(interaction) {
  const cmd = commands[interaction.data.name];
  if (!cmd || typeof cmd.execute !== 'function') return { type: 4, data: { flags: 64, content: '❌ Unknown command.' } };
  try {
    return await cmd.execute(interaction);
  } catch (err) {
    console.error(`[LogPass] /${interaction.data.name} failed:`, err);
    return errReply();
  }
}

async function handleComponent(interaction) {
  const prefix = interaction.data.custom_id.split(':')[0];
  const cmd = commands[prefix];
  if (!cmd || typeof cmd.handleComponent !== 'function') return { type: 4, data: { flags: 64, content: '❌ This component has expired.' } };
  try {
    return await cmd.handleComponent(interaction);
  } catch (err) {
    console.error(`[LogPass] component ${interaction.data.custom_id} failed:`, err);
    return { type: 4, data: { flags: 64, content: '❌ Something went wrong.' } };
  }
}

async function handleInteraction(interaction) {
  if (interaction.type === 1) return { type: 1 }; // PING → PONG

  if (interaction.type === 2) {
    const reply = await handleCommand(interaction);
    const cmd = commands[interaction.data.name];
    if (reply && reply.type === 4 && cmd && typeof cmd.afterSend === 'function') {
      // fetch the message so components can track state by id
      try {
        const msg = await rest.json('POST', `/webhooks/${CLIENT_ID}/${interaction.token}?wait=true`, reply.data);
        if (msg && msg.id) cmd.afterSend(interaction, msg);
      } catch (err) { console.error('[LogPass] afterSend failed:', err.message); }
    }
    return reply;
  }

  if (interaction.type === 3) return handleComponent(interaction);
  return { type: 4, data: { flags: 64, content: 'Unsupported interaction type.' } };
}

// ─────────────────────────────────────────────── automod (webhook events)
const recentMessages = new Map();
function checkSpam(userId) {
  const now = Date.now();
  if (!recentMessages.has(userId)) recentMessages.set(userId, []);
  const stamps = recentMessages.get(userId);
  stamps.push(now);
  while (stamps.length && now - stamps[0] > 10000) stamps.shift();
  return stamps.length > 7;
}

async function handleMessageEvent(event) {
  const settings = getGuild(event.guild_id);
  const am = settings.automod;
  if (!am || !am.enabled) return;
  if (!event.author || event.author.bot) return;
  const content = event.content || '';
  const contentLower = content.toLowerCase();
  const violations = [];

  for (const word of am.bannedWords) {
    if (contentLower.includes(word.toLowerCase())) { violations.push(`used a banned word (\`${word}\`)`); break; }
  }
  if (am.antiInvite && /discord\.gg\/|discord\.com\/invite\//i.test(content)) violations.push('posted a server invite link');
  if (am.antiLink && /(https?:\/\/|www\.)\S+/i.test(content)) violations.push('posted a link');
  const mentionCount = ((content.match(/<@!?\d+>/g) || []).length) + ((content.match(/<@&\d+>/g) || []).length);
  if (mentionCount > am.maxMentions) violations.push(`mentioned too many users/roles (${mentionCount})`);
  if (am.antiSpam && checkSpam(event.author.id)) violations.push('sent messages too quickly');
  if (violations.length === 0) return;

  rest.call('DELETE', `/channels/${event.channel_id}/messages/${event.id}`).catch(() => {});
  sendModLog(event.guild_id, brandEmbed(COLORS.warn, '🛡️ Automod', `<@${event.author.id}> — ${violations.join(', ')}`, {
    fields: [{ name: 'Channel', value: `<#${event.channel_id}>`, inline: true }],
  }));
}

// ─────────────────────────────────────────────── command registration
async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID) { console.error('[LogPass] DISCORD_TOKEN / CLIENT_ID missing — cannot register commands.'); return; }
  try {
    const body = Object.values(commands).map((c) => ({
      name: c.name, description: c.description, options: c.options, dm_permission: false, default_member_permissions: c.default_member_permissions,
    }));
    const res = await rest.call('PUT', `/applications/${CLIENT_ID}/commands`, body);
    if (res.status >= 300) {
      const text = await res.text();
      console.error(`[LogPass] Command registration failed (${res.status}):`, text.slice(0, 800));
      return;
    }
    console.log(`[LogPass] Registered ${body.length} global slash commands.`);
  } catch (err) {
    console.error('[LogPass] Command registration error:', err.message);
  }
}

// ─────────────────────────────────────────────── web dashboard (LogPass)
function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}
function parseForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      const form = {};
      for (const pair of body.split('&')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        try { form[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' ')); } catch { /* skip */ }
      }
      resolve(form);
    });
    req.on('error', () => resolve({}));
  });
}
function page(title, body, noindex) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<title>${esc(title)} — ${BRAND}</title>
<link rel="icon" href="${LOGO_URL}">
<style>
  :root { --brand:#5865f2; --ok:#57f287; --err:#ed4245; --bg:#0b0e14; --card:#151a23; --text:#e6e9ef; --muted:#8b93a1; --border:#262d3a; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Segoe UI',system-ui,-apple-system,sans-serif; background:radial-gradient(1200px 600px at 50% -10%, #1a2030 0%, var(--bg) 60%); color:var(--text); min-height:100vh; }
  .wrap { max-width:560px; margin:0 auto; padding:40px 20px; }
  header { text-align:center; margin-bottom:28px; }
  header img { width:84px; height:84px; border-radius:20px; box-shadow:0 8px 30px rgba(88,101,242,.35); }
  h1 { font-size:30px; margin-top:12px; letter-spacing:1px; }
  h1 span { color:var(--brand); }
  .sub { color:var(--muted); font-size:14px; margin-top:4px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; box-shadow:0 10px 40px rgba(0,0,0,.4); margin-bottom:16px; }
  label { display:block; font-size:13px; font-weight:600; color:var(--muted); margin:14px 0 6px; text-transform:uppercase; letter-spacing:.5px; }
  input { width:100%; padding:12px 14px; border-radius:10px; border:1px solid var(--border); background:#0d1117; color:var(--text); font-size:15px; outline:none; }
  input:focus { border-color:var(--brand); box-shadow:0 0 0 3px rgba(88,101,242,.2); }
  button { padding:12px 18px; border:none; border-radius:10px; background:linear-gradient(135deg,var(--brand),#4553e8); color:#fff; font-size:14px; font-weight:700; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  button.danger { background:linear-gradient(135deg,var(--err),#c93b42); }
  button.ghost { background:transparent; border:1px solid var(--border); color:var(--muted); }
  .msg { margin:0 0 14px; padding:12px 14px; border-radius:10px; font-size:14px; display:none; }
  .msg.err { background:rgba(237,66,69,.12); color:var(--err); border:1px solid rgba(237,66,69,.3); display:block; }
  .msg.ok { background:rgba(87,242,135,.1); color:var(--ok); border:1px solid rgba(87,242,135,.3); display:block; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:6px; }
  .stat { background:#0d1117; border:1px solid var(--border); border-radius:12px; padding:14px; }
  .stat b { display:block; font-size:20px; margin-top:2px; }
  .stat span { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .list { margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; }
  .chip { background:#0d1117; border:1px solid var(--border); padding:6px 12px; border-radius:999px; font-size:13px; display:inline-flex; align-items:center; gap:8px; }
  .chip form { display:inline; }
  .chip button { padding:0 6px; background:none; color:var(--err); font-size:13px; font-weight:400; }
  .row { display:flex; gap:10px; align-items:center; margin-top:10px; }
  .row input { flex:1; }
  footer { text-align:center; color:var(--muted); font-size:12px; margin-top:26px; }
  footer img { width:22px; height:22px; vertical-align:-6px; border-radius:6px; }
  h2 { font-size:16px; margin:24px 0 6px; color:var(--brand); }
  .case { padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
  a { color:var(--brand); }
  .brandbar { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .brandbar img { width:42px; height:42px; border-radius:10px; }
  .brandbar .t { font-weight:700; font-size:16px; }
  .brandbar .s { font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="${LOGO_URL}" alt="${BRAND} logo">
    <h1>Log<span>Pass</span></h1>
    <div class="sub">${esc(title)}</div>
  </header>
  ${body}
  <footer><img src="${LOGO_URL}" alt=""> ${BRAND} — secure server management</footer>
</div>
</body>
</html>`;
}

// GET /login — one-time setup (from /setuplogin) or standard login (?g=)
function handleLoginGet(req, res, url) {
  const token = url.searchParams.get('token');
  const guildParam = url.searchParams.get('g');

  if (token) {
    const entry = sessions.get(`login:${token}`);
    if (!entry || entry.expiresAt < Date.now()) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Setup Link Expired', '<div class="card"><div class="msg err">This setup link is invalid or has expired. Run <b>/setuplogin</b> in Discord again to get a fresh one.</div></div>', true));
    }
    const dash = getGuild(entry.guildId).dashboard;
    const isReset = !!dash;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page(isReset ? 'Reset Dashboard Credentials' : 'Set Dashboard Credentials', `
      <div class="card">
        <div class="brandbar">
          <img src="${LOGO_URL}" alt="">
          <div><div class="t">${BRAND}</div><div class="s">Dashboard credential setup</div></div>
        </div>
        ${isReset ? '<div class="msg err">⚠️ Credentials already exist — submitting will <b>reset</b> them.</div>' : ''}
        <div class="msg" id="msg"></div>
        <form method="POST" action="/login">
          <input type="hidden" name="token" value="${esc(token)}">
          <label for="username">Username</label>
          <input id="username" name="username" required maxlength="64" placeholder="e.g. admin" autocomplete="username">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="4" maxlength="100" placeholder="Choose a strong password" autocomplete="new-password">
          <label for="password2">Confirm password</label>
          <input id="password2" name="password2" type="password" required minlength="4" maxlength="100" placeholder="Repeat password" autocomplete="new-password">
          <button type="submit" style="width:100%;margin-top:20px;">${isReset ? 'Reset Credentials' : 'Create Credentials'}</button>
        </form>
      </div>
      <script>
        document.querySelector('form').addEventListener('submit', function(e){
          var p = document.getElementById('password'), p2 = document.getElementById('password2'), msg = document.getElementById('msg');
          if (p.value !== p2.value) { e.preventDefault(); msg.className='msg err'; msg.textContent='Passwords do not match.'; }
        });
      </script>`, true));
  }

  if (guildParam && /^\d{15,21}$/.test(guildParam) && getGuild(guildParam).dashboard) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Dashboard Login', `
      <div class="card">
        <div class="brandbar">
          <img src="${LOGO_URL}" alt="">
          <div><div class="t">${BRAND}</div><div class="s">Sign in to your server dashboard</div></div>
        </div>
        <div class="msg" id="msg"></div>
        <form method="POST" action="/login">
          <input type="hidden" name="guild" value="${esc(guildParam)}">
          <label for="username">Username</label>
          <input id="username" name="username" required autocomplete="username">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
          <button type="submit" style="width:100%;margin-top:20px;">Sign in</button>
        </form>
      </div>`, true));
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(page('Login', '<div class="card"><div class="msg err">No dashboard is configured for this link.<br><br>A server administrator must run <b>/setuplogin</b> in Discord and click the button in the reply.</div></div>', true));
}

async function handleLoginPost(req, res) {
  const form = await parseForm(req);
  const token = form.token;
  const guildParam = form.guild;

  // ----- credential creation / reset via one-time token
  if (token) {
    const entry = consumeLoginToken(token);
    if (!entry) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Setup Link Expired', '<div class="card"><div class="msg err">This setup link was invalid, already used, or expired. Run <b>/setuplogin</b> in Discord again.</div></div>', true));
    }
    const username = (form.username || '').trim();
    const password = form.password || '';
    const password2 = form.password2 || '';
    if (!/^[A-Za-z0-9_.@ -]{1,64}$/.test(username) || password.length < 4 || password.length > 100 || password !== password2) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page('Invalid Input', '<div class="card"><div class="msg err">Invalid username or password. Username: 1-64 chars (letters, numbers, spaces, _ . @). Password: 4-100 chars, both fields matching.<br><br><a href="javascript:history.back()">Go back</a></div></div>', true));
    }
    createCredentials(entry.guildId, username, password);
    const sessionToken = createSession(entry.guildId);
    console.log(`[LogPass] Dashboard credentials created for guild ${entry.guildId}`);
    res.writeHead(303, { 'Set-Cookie': `LogPass_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, Location: `/dashboard?g=${entry.guildId}` });
    return res.end();
  }

  // ----- normal login
  if (guildParam && /^\d{15,21}$/.test(guildParam)) {
    const username = (form.username || '').trim();
    const password = form.password || '';
    if (verifyCredentials(guildParam, username, password)) {
      const sessionToken = createSession(guildParam);
      console.log(`[LogPass] Dashboard login OK for guild ${guildParam}`);
      res.writeHead(303, { 'Set-Cookie': `LogPass_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, Location: `/dashboard?g=${guildParam}` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Login Failed', '<div class="card"><div class="msg err">Incorrect username or password.<br><br><a href="javascript:history.back()">Try again</a></div></div>', true));
  }

  return textResponse(res, 400, 'Bad request');
}

// GET /dashboard — the LogPass control panel
function handleDashboardGet(req, res, url) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.LogPass_session);
  let guildId = url.searchParams.get('g');
  if (!session) {
    const loginUrl = guildId ? `/login?g=${encodeURIComponent(guildId)}` : '/login';
    res.writeHead(303, { Location: loginUrl });
    return res.end();
  }
  if (!guildId) guildId = session.guildId;
  const settings = getGuild(guildId);
  const am = settings.automod;
  const dash = settings.dashboard;

  const wordChips = am.bannedWords.length
    ? `<div class="list">${am.bannedWords.slice(0, 60).map((w) => `<span class="chip">${esc(w)}<form method="POST" action="/dashboard"><input type="hidden" name="g" value="${esc(guildId)}"><input type="hidden" name="action" value="delword"><input type="hidden" name="word" value="${esc(w)}"><button type="submit" title="Remove">✕</button></form></span>`).join('')}</div>`
    : '<div class="sub" style="margin-top:8px;">No banned words yet.</div>';

  const warnTotal = Object.values(settings.warnings || {}).reduce((a, w) => a + w.length, 0);
  const casesHtml = (settings.cases || []).length
    ? settings.cases.slice(-10).reverse().map((c) => `<div class="case">#${c.id} • <b>${esc(c.action)}</b> • <code>${esc(c.user)}</code> • ${esc(c.reason || 'No reason')}</div>`).join('')
    : '<div class="sub">No cases yet.</div>';

  const inner = `
  <div class="brandbar">
    <img src="${LOGO_URL}" alt="">
    <div><div class="t">${BRAND} Server Dashboard</div><div class="s">Guild ${esc(guildId)} · signed in as <b>${esc(dash.username)}</b></div></div>
  </div>

  <div class="grid">
    <div class="stat"><span>Automod</span><b style="color:${am.enabled ? 'var(--ok)' : 'var(--err)'}">${am.enabled ? 'Enabled' : 'Disabled'}</b></div>
    <div class="stat"><span>Warnings stored</span><b>${warnTotal}</b></div>
    <div class="stat"><span>Mod cases</span><b>${(settings.cases || []).length}</b></div>
    <div class="stat"><span>Banned words</span><b>${am.bannedWords.length}</b></div>
  </div>

  <h2>🛡️ Automod</h2>
  <div class="row">
    <button type="button" class="${am.enabled ? 'danger' : ''}" onclick="toggle(this,'automod',${am.enabled ? 0 : 1})">${am.enabled ? 'Disable Automod' : 'Enable Automod'}</button>
  </div>
  <div class="list">
    <span class="chip">Anti-spam: <b style="color:${am.antiSpam ? 'var(--ok)' : 'var(--muted)'}">${am.antiSpam ? 'on' : 'off'}</b></span>
    <span class="chip">Anti-invite: <b style="color:${am.antiInvite ? 'var(--ok)' : 'var(--muted)'}">${am.antiInvite ? 'on' : 'off'}</b></span>
    <span class="chip">Anti-link: <b style="color:${am.antiLink ? 'var(--ok)' : 'var(--muted)'}">${am.antiLink ? 'on' : 'off'}</b></span>
    <span class="chip">Max mentions: <b>${am.maxMentions}</b></span>
  </div>
  <div class="sub" style="margin-top:6px;">Configure thresholds and more options in Discord with <b>/automod</b>.</div>

  <h2>🚫 Banned words</h2>
  <form method="POST" action="/dashboard" class="row">
    <input type="hidden" name="g" value="${esc(guildId)}"><input type="hidden" name="action" value="addword">
    <input name="word" required maxlength="100" placeholder="Add a banned word…">
    <button type="submit">Add</button>
  </form>
  ${wordChips}

  <h2>⚠️ Recent mod cases</h2>
  ${casesHtml}

  <h2>🔐 Credentials</h2>
  <div class="sub">Created ${new Date(dash.createdAt).toISOString().slice(0, 10)} · to change them, run <b>/setuplogin</b> in Discord again.</div>
  <form method="POST" action="/dashboard" style="margin-top:10px;">
    <input type="hidden" name="g" value="${esc(guildId)}"><input type="hidden" name="action" value="logout">
    <button type="submit" class="ghost">Log out</button>
  </form>

  <script>
    async function toggle(btn, action, value) {
      const g = '${esc(guildId)}';
      const res = await fetch('/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'g=' + g + '&action=' + action + '&value=' + value });
      if (res.ok) location.reload(); else alert('Action failed — session may have expired.');
    }
  </script>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' });
  return res.end(page('Server Dashboard', `<div class="card">${inner}</div>`, true));
}

async function handleDashboardPost(req, res) {
  const form = await parseForm(req);
  const guildId = form.g;
  const cookies = parseCookies(req);

  if (form.action === 'logout') {
    destroySession(cookies.LogPass_session);
    res.writeHead(303, { 'Set-Cookie': 'LogPass_session=; Path=/; HttpOnly; Max-Age=0', Location: '/login' });
    return res.end();
  }

  const session = getSession(cookies.LogPass_session);
  if (!session || !guildId || !/^\d{15,21}$/.test(guildId)) return reply401(res);
  const settings = getGuild(guildId);
  const am = settings.automod;
  let changed = false;

  if (form.action === 'automod') { am.enabled = form.value === '1'; changed = true; }
  else if (form.action === 'addword') {
    const w = (form.word || '').toLowerCase().trim();
    if (w && !am.bannedWords.includes(w)) { am.bannedWords.push(w); changed = true; }
  } else if (form.action === 'delword') {
    const w = (form.word || '').toLowerCase().trim();
    const i = am.bannedWords.indexOf(w);
    if (i > -1) { am.bannedWords.splice(i, 1); changed = true; }
  }

  if (changed) {
    scheduleFlush();
    flushDb();
    console.log(`[LogPass] Dashboard change '${form.action}' on guild ${guildId}`);
    return textResponse(res, 200, 'ok');
  }
  return textResponse(res, 400, 'no change');
}

// ─────────────────────────────────────────────── express app
const app = express();
app.disable('x-powered-by');
const rawParser = express.raw({ type: '*/*', limit: '1mb' });

app.get('/', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online', bot: BRAND, mode: 'webhook', client_id: CLIENT_ID || 'unknown',
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000), timestamp: new Date().toISOString(),
  }, null, 2));
});
app.get('/healthz', (req, res) => textResponse(res, 200, 'ok'));
app.get('/favicon.ico', (req, res) => { res.writeHead(204); res.end(); });

app.get('/login', (req, res) => handleLoginGet(req, res, new URL(req.url, 'http://x')));
app.post('/login', (req, res) => { handleLoginPost(req, res).catch((e) => { console.error(e); textResponse(res, 500, 'Server error'); }); });
app.get('/dashboard', (req, res) => handleDashboardGet(req, res, new URL(req.url, 'http://x')));
app.post('/dashboard', (req, res) => { handleDashboardPost(req, res).catch((e) => { console.error(e); textResponse(res, 500, 'Server error'); }); });

// POST / — Discord interactions (signature-verified)
app.post('/', rawParser, async (req, res) => {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  if (!verifyKey(rawBody, signature, timestamp)) return reply401(res);

  let interaction = null;
  try { interaction = JSON.parse(rawBody.toString('utf8')); } catch { return textResponse(res, 400, 'Bad JSON'); }

  try {
    const reply = await handleInteraction(interaction);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  } catch (err) {
    console.error('[LogPass] Interaction handler error:', err);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 4, data: { flags: 64, content: '❌ Internal error.' } }));
  } finally {
    flushDb();
  }
});

// MESSAGE_CREATE events (automod) — sent by Discord when you enable an
// "Event Subscription" endpoint or use the automod webhook; verified the same way.
app.post('/events', rawParser, async (req, res) => {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!verifyKey(rawBody, signature, timestamp)) return reply401(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 1 }));
  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    if (event && event.type === 'MESSAGE_CREATE') await handleMessageEvent(event);
  } catch (err) { console.error('[LogPass] event error:', err.message); }
  flushDb();
});

app.use((req, res) => textResponse(res, 404, 'Not found'));

// Local/dev entrypoint (Vercel imports the app instead)
if (require.main === module) {
  app.listen(PORT, () => console.log(`[LogPass] listening on port ${PORT}`));
  if (DISCORD_TOKEN && CLIENT_ID) registerCommands();
  process.on('SIGTERM', () => { flushDb(); process.exit(0); });
}

module.exports = { app, verifyKey, handleInteraction, commands, getGuild, registerCommands, handleMessageEvent };
