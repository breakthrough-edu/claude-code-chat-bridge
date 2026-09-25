# Lark setup

*From nothing to a Lark bot app the bridge can listen to and reply as: install lark-cli, create the app as a named profile, add the card callback, find your own id, test without a phone, and know what the errors mean.*

Written against Claude Code 2.1.240 and lark-cli 1.0.89. Lark's console and lark-cli change between versions: if what yours prints differs from this page, trust your console and your CLI, and check `lark-cli --version` first. Anything marked *unverified on your setup* is yours to check as you go. The Lark calls themselves live in `bridge/platform-lark.mjs`; the file is the truth if this page and the code disagree.

---

## 1. Install lark-cli

The reference bridge talks to Lark through lark-cli, which wraps the official long-connection event client, so the bridge dials out and needs no public webhook and no tunnel. The npm package is `@larksuite/cli`: install it with `npm install -g @larksuite/cli`, then check it with `lark-cli --version` (and `npm ls -g @larksuite/cli` if you are unsure which copy is installed).

Write down the absolute path `which lark-cli` prints: it goes into `LARK_CLI` in the plist ([launchd.md](launchd.md)), because launchd's `PATH` is minimal. lark-cli is itself a node script that finds `node` through `PATH`, so any non-interactive environment that runs it (launchd, SSH, a script) needs a `PATH` that includes the folder `node` lives in. Without it the call fails silently, with exit code 127 and empty output (*unverified on your setup*). The shipped plist's `PATH` includes `/usr/local/bin` and `/opt/homebrew/bin`.

## 2. Create the bot app as a named profile

```bash
lark-cli config init --new --name <profile> --brand lark
```

- `--new` creates a new app instead of asking which mode you want.
- `--name <profile>` **appends** a named profile. Always pass it: without it the command can replace the default identity, which other tools on the machine may depend on (*unverified on your setup*; `lark-cli config init --help` describes it).
- `--brand lark` is for Lark. The default brand is `feishu`, so leave the flag out (or pass `feishu`) if your account is on Feishu (*unverified on your setup*).

The command prints a QR code and a URL, and blocks until you finish. Scan the code or open the URL, sign in if asked, and approve. Approving creates the app and appends the profile. When it returns, check that `lark-cli profile list` shows the new profile next to your default one, and that the app secret was masked in the command's output (*unverified on your setup*). That profile name goes into `LARK_PROFILE` in the plist.

**The app's display name is not your profile name.** The profile name is a label on your machine. The app gets its own display name in the developer console, and that is the name you see in Lark. When you look for the bot to DM it, search for the console display name.

**Profiles are per machine.** A profile you created on one computer does not exist on another. If the bridge will run on a different machine from the one you set up on, create or register the profile again on the machine that runs the bridge. *Unverified on your setup.*

## 3. What the new app does out of the box, and the one thing it lacks

- **DMs work with no further setup.** The long connection needs no manual configuration: the message listener (`event consume im.message.receive_v1`) connects and prints a ready line (`[event] ready event_key=...`), and the bot answers a DM. That ready line, not the process starting, is the sign it is listening. The reference bridge waits for it on stderr and does not pass `--quiet`, which suppresses it (*unverified on your setup*: if your lark-cli prints it on stdout, the bridge will not see it until the first event).
- **The progress card's scope is included.** Creating and updating CardKit cards (`cardkit:card:write`) works on a new app without extra permissions.
- ⚠️ **`card.action.trigger` is missing**, and the Stop button and the approval card both depend on it. The card listener exits with code 2, a validation error (`failed_precondition`) saying the callback is not subscribed in the console, and the error contains a launcher link that adds just that callback. Open the link and approve it.

What happens next in the reference bridge: the card listener keeps retrying on its own restart backoff (it starts at about a second, doubles each time and is capped at 30 seconds), so on the first retry after you approve, it prints `[event] ready` for `card.action.trigger`. No restart is needed. The message listener is unaffected the whole time, so DMs keep working while the card listener is down.

If you run consumers yourself, without that retry loop, restart every consumer after any subscription change and wait for `[event] ready` before you test: a consumer that exited is not listening, and a tap or message sent while nothing listens is lost (next section). Cards sent before the callback was added work once it is added; you do not need to resend them. *Unverified on your setup.*

## 4. Events are not replayed: start listening before you send

Lark's long connection pushes live events only. Anything sent while nothing was listening is gone, and starting a consumer afterwards does not bring it back. So every test goes in this order: start the consumer, see `[event] ready`, then send the message or tap the button. "The bot didn't react" almost always means "nothing was listening", not a configuration problem.

**Keep stdin open.** `event consume` treats stdin reaching end of file as "stop": spawned with a closed stdin it exits at once ("context canceled"). The reference bridge gives it a real stdin pipe and never closes it; do the same if you write your own.

**One app, one consumer per event key.** Two processes consuming the same event key of the same app compete for its events, so each sees only some of your messages. On one machine, consumers share a local bus that lark-cli starts for them, and its log reports how many other instances are online; check that before you start a second bridge anywhere. Consuming two different keys of one app side by side (messages and card callbacks, as the bridge does) is fine. *Unverified on your setup.*

## 5. Find your own id, and the bot's

Your `open_id` is **per app**: the same person has a different `open_id` under every bot app. An id copied from another app, or from an earlier test app, makes the allowlist reject you silently.

`scripts/whoami.sh <profile>` finds it. It listens for one message to the bot on that profile, prints the sender's id (`sender_id:`, starting with `ou_`), the chat type (`chat_type:`) and the chat id (`chat_id:`, starting with `oc_`), and exits with code 0. It never prints the message content. Start it, wait until it is listening, then DM the bot anything from your own account. The `sender_id` goes into `BRIDGE_ALLOWED_USERS`; keep the `chat_id` of that DM too, for [testing without a phone](#7-testing-without-a-phone). The bridge refuses to start with an empty allowlist.

**The bot's own id, for groups.** The bridge answers in a group only when @-mentioned, and it needs its own id (`BRIDGE_BOT_ID`) to recognise the mention. To find it: add the bot to a group, run `whoami.sh`, and @-mention the bot in that group. `whoami.sh` then also prints each mentioned id (`mentioned:` lines) and says which one belongs to the bot. Without `BRIDGE_BOT_ID`, the bridge ignores groups.

`whoami.sh` refuses to run while another consumer (your bridge, for example) is listening on the same profile, because two consumers on one app split the events. It prints that consumer's pid with a hint to pause the bridge (`scripts/pause.sh <label>`) and exits with code 1. Stop the bridge, run `whoami.sh`, then start the bridge again.

The same `open_id` is what a card tap reports as the operator, so one allowlist gates both messages and buttons.

## 6. Run it in the foreground first

Before you install the LaunchAgent, run the bridge in a terminal. It reads its configuration from the environment, and Node 20.6 or later can load that from a file: copy `bridge/example.env` to a file of your own, fill in the same values the plist asks for ([launchd.md](launchd.md#install-it-as-a-user-launchagent)), then run

```bash
node --env-file=<your env file> bridge/bridge.mjs
```

Keep the env file out of version control. When the foreground run works, put the same values into the plist.

## 7. Testing without a phone

You can drive the bot from a terminal by sending a DM **as yourself** instead of typing it in the Lark client:

```bash
lark-cli im +messages-send --as user --chat-id <p2p chat id> --text 'what is in this folder?'
```

- `--as user` sends as you, not as the bot, so the message arrives with your own `open_id` and passes the allowlist exactly as a typed message would. The bridge will run it, so send only what you would type.
- The chat id is the `chat_id` of your DM with the bot (it starts with `oc_`). `whoami.sh` prints it (section 5). If you have no DM to catch, list your direct chats with `lark-cli im +chat-list --as user --types=p2p` and pick the one with the bot.
- The command above runs on your default lark-cli profile, and `--as user` needs a user login (you, not the bot) on that profile. Pass `--profile <name>` to use another one. How to log in as a user depends on your lark-cli version: see `lark-cli auth --help` (*unverified on your setup*).

**Card buttons cannot be pressed this way.** lark-cli offers no way to tap a button on someone's behalf: a person taps Stop or an approval card in the Lark client. Plan every card test around a human tap, and start the listener before you tap (section 4).

**Confirm the round trip in the log.** When a job finishes, the bridge logs one line such as `job <id> done in <N>s; reply sent`. If it says `reply NOT confirmed sent` instead, the run finished but the send did not confirm; check the chat before you resend. No such line after a message you sent means the bridge never took the job: check that it is listening and that the sender is on the allowlist.

## 8. When the app is disabled: error 20069

If the app is disabled in the developer console (and, *unverified on your setup*, if it is deleted), every lark-cli call for it fails with error 20069, "The specified app is not enabled". `event consume` prints an error report (pretty-printed JSON over many lines, `"ok": false` with an error of type `config`) and exits with code 3.

Restarting cannot fix a configuration error, so the reference bridge does not retry forever: after three configuration failures within a minute (a few seconds, on its restart backoff) it logs one line starting `FATAL:` that quotes Lark's message, the error code and Lark's hint, marks both listeners down in the heartbeat file, shuts down cleanly and exits with code 1. Under launchd, `KeepAlive` then starts it again, so the same `FATAL` repeats in the log until you re-enable the app in the console, or pause the worker ([launchd.md](launchd.md#stop-it-for-good)). The restart by launchd is *unverified on your setup*. If the bot goes quiet and the log shows `FATAL` with 20069, look at the app in the console before you touch any code.

For comparison, a clean stop (SIGTERM, which is what `launchctl bootout` and `pause.sh` send; *unverified on your setup* for those two) exits with code 0, leaves no lark-cli consumer running, and writes `connection: closed` to the heartbeat file. A `closed` connection is a stop you asked for; a `down` one is not. lark-cli's shared local bus process (`event _bus`) can stay up for about 30 seconds after the last consumer exits, as its own log line says; that is not a leaked consumer.

---

## Checklist lines this chapter adds

- [ ] lark-cli (`@larksuite/cli`) installed; its absolute path is in `LARK_CLI`; the plist's `PATH` includes the folder `node` lives in.
- [ ] The bot app created with `--name <profile>` (default profile untouched), on the machine that runs the bridge; the profile name is in `LARK_PROFILE`; the bot found in chat by its console display name.
- [ ] `card.action.trigger` added through the launcher link in the card listener's error; `[event] ready` seen for it afterwards.
- [ ] Every test starts the listener first and sends second.
- [ ] Only one consumer per event key of this app, on any machine.
- [ ] Your `open_id` under **this** app found with `scripts/whoami.sh <profile>` (bridge stopped first) and set in `BRIDGE_ALLOWED_USERS`; the bot's own id in `BRIDGE_BOT_ID` if it should answer in groups.
- [ ] The bridge ran in the foreground with `node --env-file=...` before the LaunchAgent was installed.
- [ ] One test message confirmed by a `job <id> done in <N>s; reply sent` line in the log.
- [ ] Every card test has a person to tap the button.
- [ ] You know what `FATAL` with 20069 in the log means: check the app in the console first.
