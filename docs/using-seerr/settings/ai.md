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

Once AI is on, everyone gets an **AI Picks** tab alongside Discover, Movies,
Series and Sources. There's no chat:

- **Describe a mood** ("a cozy mystery for a rainy night") or tap a mood chip.
  **Just for me** asks for picks from your taste alone.
- **Choose All, Movies, Series or Anime** to narrow the search.
- **Choose Anywhere, In library or Not in library.** In library
  picks only from what's already available to watch; Not in library leaves
  out anything available, requested or downloading.
- **More like this** on any movie or series page starts AI Picks from that
  title.

A request takes a few seconds. Foreseerr asks the model for a search plan,
gathers candidates from TMDB (recommendations, similar titles, genres and
keywords), AniList for anime, Trakt recommendations when you've linked Trakt,
and SearXNG when it's on. The model then ranks only what was found and writes
one line on why each pick fits. Titles it suggests beyond those are checked
against TMDB first, so every pick is a real, requestable title.

Under the results, **Refine** chips ("lighter tone", "only movies") run the
request again with that change. **Recent** reopens your earlier requests and
shows when you asked, the filters, a few posters, and how many of the picks
you requested or liked. Delete one with its trash button, or **Clear history**
to delete them all.

### Weekly picks

Once a week, Foreseerr makes a set of picks for your taste overnight. They show
as **This week for you** at the top of AI Picks, and you get a web push when
they're ready (if you've turned web push on). Weekly picks don't count toward
your daily limit. Turn them off in **Profile → Discover → AI recommendations →
Weekly picks**. Only people who used AI picks in the last week get them.

### Feedback and your taste card

AI picks look like any other poster, with the same rating badges. Hover over
or tap one, then press the lightbulb badge under the ratings. A small panel shows
why it was picked, with **Like**, **Not for me**, **Seen it** and **Don't
suggest** buttons; select a choice again to take it back. This works on the AI
Picks page and in Discover AI rows. Once you rate a pick, its badge shows your
choice. This feedback only tunes AI suggestions; it does not change your
tracker ratings or watch status. Titles you rated never come back as picks, and
liked and disliked ones steer later requests. Titles you passed on are left out
of Discover rows.

Foreseerr also notices what you do with picks, without you pressing anything:

- **You requested a pick.** It counts like a like, and that title isn't
  suggested again.
- **You watched a pick, or rated it on Trakt or Simkl** (7 or more counts as
  liked, 4 or less as disliked). These are watch history, so they only go to
  the model when **Use my watch history** is on.

These stay on your server. **Forget all ratings** forgets them too.

After a few new ratings, Foreseerr rewrites your **taste card**, a short note
about what you enjoy that goes with each request. You can read, edit or clear
it in **Profile → Discover → AI recommendations**, and forget all your ratings there too.

Titles you've already watched on your media server or linked trackers are
skipped even when **Use my watch history** is off. That check happens on the
server; nothing about your history is sent to the model.

### Discover rows

Admins can turn a request into a Discover row: **Add to Discover** on the
results, or **Customize Discover → Add slider → AI Picks** with a prompt. The
row is the same for everyone, but each person sees picks for their own taste.
Adding completed picks reuses that run for your slider's first day, without
another AI request. The saved row keeps the original seed title, media filter,
anime setting and refinements for future refreshes. Other people get their own
personalized results. Each person's picks are kept for a few days (3 by
default; admins can change it), and a refresh made while they browse counts as
one request toward their daily limit.

Rows are mostly refreshed overnight instead, by the **AI Picks Refresh** job
(Settings → Jobs, 4:30 by default). For people who used AI picks in the last
week, it refreshes rows that would go stale during the next day, one request at
a time. These overnight refreshes don't count toward anyone's daily limit.
People who haven't used AI picks lately cost nothing.

For API clients, `GET /api/v1/ai/row` reads cached picks only. To allow a new
run when the cache has expired, use `POST` with the same query parameters and
the header `X-Foreseerr-AI: 1`.

## Connections

Personal AI accounts live alongside your other linked accounts. The account card
shows the active provider and model; **Manage** opens connection and model controls.
Taste and history preferences are in **Profile → Discover → AI recommendations**.

Every request goes through one connection, and each person can see which one
in **Profile → Linked Accounts → AI account**: whose connection it is, the provider, the model, and whose
quota it uses.

- **The server connection.** An admin sets it up, and everyone uses it unless
  they connect their own. It is any OpenAI-compatible endpoint: OpenAI with an
  API key, OpenRouter, Ollama, LM Studio, vLLM, and so on. Usage counts against
  the admin's quota.
- **A person's own ChatGPT account.** In **Profile → Linked Accounts → AI account**, **Continue with
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

**Sign out** in Profile → Linked Accounts → AI account revokes Foreseerr's access at OpenAI as well.

## Models

On the server connection the admin picks a **Balanced** model (the default for
everyone) and, optionally, **Fast** and **Best** models. When the admin allows
it, people choose between these three in Profile → Linked Accounts → AI account. People with their own
connection pick any model it offers.

## Who can use what

| Setting                                        | Default | Effect                                                                                                                  |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Everyone can use the server connection         | On      | When off, only admins can use it.                                                                                       |
| People can connect their own ChatGPT account   | On      |                                                                                                                         |
| People can choose Fast, Balanced or Best       | On      |                                                                                                                         |
| People can add their own endpoint              | Off     | This lets a user make the server call any address they enter, including ones on your network. Leave it off unless you trust every user. |
| Daily AI requests per person                   | 30      | On the server connection, reset at midnight UTC. Admins and people using their own account aren't limited. 0 means no limit. |
| Prepare picks overnight                        | On      | Refreshes Discover AI rows ahead of time and makes weekly picks for people active in the last week. |
| Refresh Discover AI rows every (days)          | 3       | How long a person's row picks are kept. Longer means fewer AI requests. |
| Keep request history (days)                    | 90      | Finished requests and their picks are deleted after this. 0 keeps them. |
| Monthly token budget for the server connection | 0       | When the server connection has used this many tokens this month, new requests on it stop until the 1st. Own accounts aren't affected. 0 means no budget. |

Admins can always use the server connection and connect their own accounts.
Each person sees how many requests they have left on the AI Picks page and in
Profile → Linked Accounts → AI account.

## Usage

**Settings → AI → Usage** shows the last 30 days: requests per person (asked
for, or made automatically), failures, tokens, and how picks went (requested,
watched or liked after being suggested). The **Models** table compares the
models you've used, including how often their picks were requested, which
helps decide whether Fast, Balanced or Best is worth it. Tokens are what the
provider reported; Foreseerr doesn't estimate prices, since they differ by
provider and plan.

## Watch history

Each person decides whether their watch history is used, in **Profile → Discover → AI recommendations →
Use my watch history**. It is off by default. When it's on, a short summary of
what they watched, rated and saved (from the media server and the trackers
they linked) goes with their requests to the connection they use. When it's
off, their prompt, taste card and feedback can still be sent to the AI provider. With web search enabled, searches based on their request and taste are sent through SearXNG.

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
