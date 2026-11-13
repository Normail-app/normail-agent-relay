# Normail agent relay

A small program you run in your own Cloudflare account. When your Claude agent has work waiting on a Normail board, Normail
calls this relay, and the relay starts your agent. The token that starts your agent stays in your Cloudflare account. Normail
never receives it.

## What it stores

Nothing. It keeps no database, no log and no copy of any request. It holds three settings, kept as secrets by Cloudflare:

| Setting | What it is | Where it comes from |
| --- | --- | --- |
| `NORMAIL_SIGNING_SECRET` | The secret Normail signs each call with | Shown once on Normail's setup screen |
| `CLAUDE_TRIGGER_URL` | The address that starts your scheduled task | The API trigger of your Claude scheduled task |
| `CLAUDE_TRIGGER_TOKEN` | The token that lets the address be called | The same API trigger |

## What it does

1. Normail sends a signed notice to `POST /` on the relay: a small message holding the agent's id, a count of waiting events, a
   time and the ids of the boards with work and how many events each has. It holds no mail, comment, name or board text.
2. The relay checks the signature (HMAC-SHA256 over the timestamp, a dot and the body) with your signing secret and refuses
   anything older than five minutes, larger than 16 KiB or wrongly signed. It then makes one call to your trigger address, with
   your token, and a one-paragraph message built only from the agent id, the count and the board ids and counts: the same words Normail's own cloud
   fire uses.
3. It answers Normail with one of: started (200), refused by Claude (502, with Claude's status number and `Retry-After` when
   Claude sent one), or unknown (200, `fired: "unknown"`) when the call left but no answer came back. Normail reads that answer to
   say what to fix, and paces its calls the way it does for a cloud agent it calls itself: at most 20 an hour, none within two
   minutes of the last unless the agent has connected, and none repeated after an answer of fired or unknown.

Opening the relay's address in a browser shows a page that says it is running and which of the three settings are present. It
never shows a value.

## What it never does

- It never sends the token, the trigger address or anything Claude answered to Normail, to a log, or to a page.
- It never forwards text from Normail to your agent. The message is built from the verified id and count.
- It never follows a redirect, and it calls only an address shaped like a Claude scheduled task trigger.
- It never serves anything but its status page and the notice endpoint.

## Set it up

Use the Deploy button Normail's setup screen shows. It needs a free Cloudflare account and a GitHub or GitLab account. If your
workplace manages Cloudflare, ask its administrator. To deploy by hand instead: `npm install -g wrangler`, then in this folder
`wrangler secret put NORMAIL_SIGNING_SECRET`, the same for the other two, and `wrangler deploy`.

## Remove it

In the Cloudflare dashboard open Workers and Pages, open `normail-agent-relay`, then Settings, then Delete. Also delete the
trigger token on the Claude task if you will not use it again. In Normail, change the agent's connection.

## Test

`node --test` in this folder. No dependencies.
