---
title: AI
description: Connect AI providers for suggestions, choose who can use them, and add SearXNG web search.
sidebar_position: 10
---

# AI

AI features are off until an admin turns them on in **Settings → AI**. They
suggest titles from a mood, a title someone loves, or (only if that person
allows it) their watch history. Foreseerr finds real titles in its catalogs
first; the model plans the search and ranks what was found, so it can't invent
titles.

## AI Picks

Once AI is on, everyone gets **AI Picks** in the sidebar. There's no chat:

- **Describe a mood** ("a cozy mystery for a rainy night") or tap a mood chip.
  **Just for me** asks for picks from your taste alone.
- **Choose All, Movies, Series or Anime** to narrow the search.
- **More like this** on any movie or series page starts AI Picks from that
  title.

A request takes a few seconds. Foreseerr asks the model for a search plan,
gathers candidates from TMDB (recommendations, similar titles, genres and
keywords), AniList for anime, Trakt recommendations when you've linked Trakt,
and SearXNG when it's on. The model then ranks only what was found and writes
one line on why each pick fits. Titles it suggests beyond those are checked
against TMDB first, so every pick is a real, requestable title.

Under the results, **Refine** chips ("lighter tone", "only movies") run the
request again with that change. **Recent** reopens your earlier requests.

### Feedback and your taste card

Each pick has four buttons: 👍 **More like this**, 👎 **Not for me**, 👁
**Already seen** and 🚫 **Don't suggest this**. Tap one again to undo it. Titles
you rated never come back as picks, and liked and disliked ones steer later
requests.

After a few new ratings, Foreseerr rewrites your **taste card**, a short note
about what you enjoy that goes with each request. You can read, edit or clear
it in **Profile → AI**, and forget all your ratings there too.

Titles you've already watched on your media server or linked trackers are
skipped even when **Use my watch history** is off. That check happens on the
server; nothing about your history is sent to the model.

### Discover rows

Admins can turn a request into a Discover row: **Add to Discover** on the
results, or **Customize Discover → Add slider → AI Picks** with a prompt. The
row is the same for everyone, but each person sees picks for their own taste.
Picks are cached for a day per person, and each refresh counts as one request
toward that person's daily limit.

## Connections

Every request goes through one connection, and each person can see which one
in **Profile → AI**: whose connection it is, the provider, the model, and whose
quota it uses.

- **The server connection.** An admin sets it up, and everyone uses it unless
  they connect their own. It is any OpenAI-compatible endpoint: OpenAI with an
  API key, OpenRouter, Ollama, LM Studio, vLLM, and so on. Usage counts against
  the admin's quota.
- **A person's own ChatGPT account.** In **Profile → AI**, **Continue with
  ChatGPT** signs in through OpenAI's _Sign in with ChatGPT_. That person's
  requests then count toward their own ChatGPT plan's limits. They can review
  usage, set a limit or remove Foreseerr at
  [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- **A person's own endpoint**, when the admin allows it.

A ChatGPT account can't be the server connection. OpenAI's terms don't allow a
ChatGPT account to be shared with other people, so a ChatGPT connection only
ever serves the person who signed in. Nothing falls back to another connection
silently. If someone's own connection stops working, their AI page says so and
offers to sign in again or switch back to the server connection.

### Signing in with ChatGPT

ChatGPT opens in a small window. OpenAI only sends a finished sign-in back to
`127.0.0.1` on your own computer, never to a server, so after you approve,
that window lands on a page that doesn't load
(`http://127.0.0.1:1455/auth/callback?code=…`). This is expected:

1. Copy that page's address (<kbd>Ctrl</kbd>+<kbd>L</kbd>, then
   <kbd>Ctrl</kbd>+<kbd>C</kbd>; <kbd>⌘</kbd> on a Mac).
2. Come back to Foreseerr. It finishes on its own when you paste anywhere on
   the page or press **Paste address**. If your browser already lets
   Foreseerr read the clipboard, coming back is enough.

Foreseerr only ever uses an address that belongs to the sign-in it started,
so nothing else on your clipboard is sent anywhere. The address works once,
for a few minutes.

**Sign out** in Profile → AI revokes Foreseerr's access at OpenAI as well.

## Models

On the server connection the admin picks a **Balanced** model (the default for
everyone) and, optionally, **Fast** and **Best** models. When the admin allows
it, people choose between these three in Profile → AI. People with their own
connection pick any model it offers.

## Who can use what

| Setting                                        | Default | Effect                                                                                                                  |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Everyone can use the server connection         | On      | When off, only admins can use it.                                                                                       |
| People can connect their own ChatGPT account   | On      |                                                                                                                         |
| People can choose Fast, Balanced or Best       | On      |                                                                                                                         |
| People can add their own endpoint              | Off     | This lets a user make the server call any address they enter, including ones on your network. Leave it off unless you trust every user. |
| Daily AI requests per person                   | 30      | On the server connection, reset at midnight UTC. Admins and people using their own account aren't limited. 0 means no limit. |

Admins can always use the server connection and connect their own accounts.
Each person sees how many requests they have left on the AI Picks page and in
Profile → AI.

## Watch history

Each person decides whether their watch history is used, in **Profile → AI →
Use my watch history**. It is off by default. When it's on, a short summary of
what they watched, rated and saved (from the media server and the trackers
they linked) goes with their requests to the connection they use. When it's
off, only what they type is sent.

## How keys are protected

API keys and ChatGPT sign-ins are encrypted at rest (AES-256-GCM). Foreseerr
never returns them to a browser after they're saved: not to the admin, not to
other admins. A key field only shows that a key is saved. Personal connections
can only be seen and changed by their owner; there is no admin view of them.
Someone with access to the server itself and its secret key could still decrypt
them.

The secret key is, in order of preference:

1. `FORESEERR_SECRET_KEY`: 32 random bytes as hex or base64
   (`openssl rand -hex 32`).
2. `FORESEERR_SECRET_KEY_FILE`: a file holding that value, such as a Docker or
   Kubernetes secret.
3. Otherwise, `secret.key` in the config folder, created with owner-only access
   the first time the AI settings are opened.

The default keeps the key next to the database, so a copy of the config folder
includes both. Use a secret to keep them apart. See
[`compose.yaml`](https://github.com/selmant/foreseerr/blob/develop/compose.yaml)
for Docker, and `secretKey.existingSecret` in the Helm chart. To move an
existing key, copy the contents of `secret.key` into the secret. A new key
can't open credentials saved with the old one; they would have to be entered
again.

## Web search with SearXNG

With a [SearXNG](https://docs.searxng.org) instance, every new recommendation
run researches the web alongside the catalogs. This includes personal Discover
rows when they regenerate. The model creates one or two searches from your
request and taste, and Foreseerr supplies a search from the plan's summary if
the model leaves them empty. Results guide ranking, and extra titles are
checked against TMDB before they appear. Cached rows reuse their existing picks.

Searches run from your server, so no search provider account is needed.
In **Settings → AI → Web search**, turn it on, enter the instance's URL and
use **Test**. The results page shows **Web search used** when web results
were included. If search fails or returns nothing, the catalogs can still
provide recommendations.

The instance needs:

- `json` in `search.formats` in its `settings.yml`. Without it, SearXNG
  answers 403.
- `server.limiter: false`. The limiter is for public instances and needs Valkey.
  With it on, SearXNG rate-limits Foreseerr.

SearXNG has no login, so keep it reachable only from Foreseerr.

- **Docker Compose:** `compose.searxng.yaml` in the repository runs a private
  instance with these settings and no published port:

  ```bash
  echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
  docker compose -f compose.yaml -f compose.searxng.yaml up -d
  ```

  Then use `http://searxng:8080`.

- **Helm:** set `searxng.enabled=true`. A NetworkPolicy lets only Foreseerr's
  pods reach it, and the install notes print the URL.
