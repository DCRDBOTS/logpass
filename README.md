# 🔐 LogPass — Discord Moderation + Fun Bot

**LogPass** is an all-in-one Discord bot in a **single file** (`api/index.js`), built to run on **Vercel** — with a built-in **web dashboard** where server owners log in with a username and password they set themselves via `/setuplogin`.

Everything is labeled **LogPass** and branded with the [LogPass logo](https://github.com/DCRDBOTS/images/blob/main/logpass_logo.png).

## ✨ What's inside

**🛡️ Moderation** — `/ban` `/unban` `/kick` `/timeout` `/untimeout` `/warn` `/warnings` `/purge` `/slowmode` `/lock` `/unlock` `/role` `/embed` `/setup` `/automod`

**🎉 Fun** — `/8ball` `/coinflip` `/dice` `/rps` `/meme` `/joke` `/hug` `/slap` `/pat` `/poll` `/trivia` `/ship` `/rate` `/avatar` `/say`

**⚙️ Utility** — `/ping` `/help` `/serverinfo` `/userinfo` `/setuplogin`

**🌐 Web dashboard** — automod on/off toggle, banned-word manager, mod-case viewer, stats — all behind a username + password that **you** choose.

---

## 🚀 Deploy to Vercel (free)

### Step 1 — Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it **LogPass** (or whatever you like).
2. Go to **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
3. Still on the Bot tab, find **Public Key** → copy it (this is `CLIENT_PUBLIC_KEY`).
4. Go to **General Information** → copy the **Application ID** (this is `CLIENT_ID`).
5. Invite the bot: open this URL in your browser, replacing `YOUR_CLIENT_ID`:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1374893823552
   ```
   That permission set covers kick/ban/moderate/manage messages/roles/channels.

### Step 2 — Deploy

**Easiest (no git needed):**
```bash
npm i -g vercel
vercel            # from this folder; follow the prompts
```

**Or via GitHub:** push this folder to a repo → [vercel.com/new](https://vercel.com/new) → import it → deploy. The included `vercel.json` routes everything to `api/index.js` automatically.

### Step 3 — Add environment variables

In the Vercel dashboard → your project → **Settings → Environment Variables**, add all three:

| Key | Value |
|---|---|
| `DISCORD_TOKEN` | your bot token |
| `CLIENT_ID` | your application ID |
| `CLIENT_PUBLIC_KEY` | your public key |

Then **redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

### Step 4 — Set the Interactions Endpoint URL

1. Get your deployment URL, e.g. `https://logpass.vercel.app` (shown in Vercel after deploy).
2. Developer Portal → your app → **Interactions Endpoint URL** → enter:
   ```
   https://YOUR-DEPLOYMENT.vercel.app/
   ```
3. Click **Save Changes**. Discord sends a `PING` — LogPass answers `PONG`, and the save succeeds. (If it fails, double-check `CLIENT_PUBLIC_KEY` and that the deployment is live.)

That's it — the slash commands register automatically on the first request.

---

## 🔐 Setting up the web dashboard (`/setuplogin`)

1. In your Discord server, an administrator runs:
   ```
   /setuplogin
   ```
2. LogPass replies (only visible to the admin) with a **"Open LogPass Setup"** button.
3. Click it → a LogPass-branded page opens where you **set a username and password** for your server's dashboard.
4. You're logged straight into your dashboard: `https://YOUR-DEPLOYMENT.vercel.app/dashboard`
5. Later, anyone with credentials can log in at:
   ```
   https://YOUR-DEPLOYMENT.vercel.app/login?g=YOUR_SERVER_ID
   ```

**Security details:**
- The setup link is **one-time** and **expires in 15 minutes**.
- Only **Server Administrators** can run `/setuplogin` (Discord enforces this).
- Passwords are stored **salted + hashed** (never in plain text).
- Sessions are `HttpOnly` cookies valid for 7 days.
- Every dashboard action requires the session; Discord interactions are **signature-verified** with your public key.

## 🌐 Dashboard features

- **Automod on/off** toggle (one click)
- **Banned words** — add/remove with one click
- **Stats** — warnings stored, mod cases, banned words count
- **Recent mod cases** — last 10 moderation actions with case numbers
- Toggle more granular automod settings (`/automod antispam`, `/antiinvite`, `/antilink`, `/maxmentions`) in Discord

## 🛡️ Enabling automod

1. `/automod setmodlog #mod-log` — pick a log channel
2. `/automod toggle enabled:True`
3. `/automod antispam enabled:True` · `/automod antiinvite enabled:True` · `/automod addword word:badword`
4. Banned words / anti-invite / anti-link / mention limits are enforced automatically — mods with **Manage Messages** are exempt.

> **Note on automod on Vercel:** Vercel functions are serverless, so there's no always-on gateway connection. Message events reach LogPass via the `/events` webhook route (`MESSAGE_CREATE` payloads, signature-verified). Slash-command moderation (ban/kick/timeout/warn/purge/…) works fully with zero extra setup.

## 📁 Project structure

```
api/index.js   ← the ENTIRE bot (1,530 lines): commands, automod, web dashboard
vercel.json    ← routes all traffic to the function
```

That's it — one file. To add a command, open `api/index.js` and follow the pattern of the existing `def('name', ...)` blocks.

## 🧰 Running locally

```bash
npm install
cp .env.example .env   # fill in the 3 values
npm start              # http://localhost:3000
```

> Local runs skip command registration unless both `DISCORD_TOKEN` and `CLIENT_ID` are set.

## 📝 Notes & limitations

- **Data storage:** settings/warnings live in a JSON file (`/tmp/logpass/db.json`). On serverless the disk is ephemeral — fine for trying it out, but for permanent storage across restarts, point `LOGPASS_DATA_DIR` at a persistent volume or wire the tiny persistence layer to a free DB (Upstash, Supabase…).
- **Fun commands** that need the internet (`/meme`, `/trivia`) use public APIs — if those APIs are down, the bot tells you instead of crashing.
- To change dashboard credentials later, run `/setuplogin` again — the link becomes a **reset** link.
