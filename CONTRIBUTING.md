# Contributing to Foreseerr

All help is welcome and greatly appreciated! If you would like to contribute to the project, the following instructions should get you started...

## AI Policy

Using AI is fine. Two rules:

1. **Use a capable model.** Don't use cheap or small models. Their output looks plausible and is wrong in ways that cost more to review than to write.
2. **Test it manually.** Run the change yourself and check that it does what the PR says. Passing CI is not enough.

## Development

### Tools Required

- HTML/Typescript/Javascript editor
- [VSCode](https://code.visualstudio.com/) is recommended. Upon opening the project, a few extensions will be automatically recommended for install.
- [Bun](https://bun.sh/docs/installation) 1.4+ (or `mise install` from this repo)
- .NET 8 SDK if you are building the optional Jellyfin sidecar plugin (`mise.toml` pins it)
- [Git](https://git-scm.com/downloads)

### Getting Started

1. [Fork](https://help.github.com/articles/fork-a-repo/) the repository to your own GitHub account and [clone](https://help.github.com/articles/cloning-a-repository/) it to your local device:

   ```bash
   git clone https://github.com/YOUR_USERNAME/foreseerr.git
   cd foreseerr/
   ```

2. Add the remote `upstream`:

   ```bash
   git remote add upstream https://github.com/selmant/foreseerr.git
   ```

3. Create a new branch:

   ```bash
   git switch -c BRANCH_NAME develop
   ```

   - It is recommended to give your branch a meaningful name, relevant to the feature or fix you are working on.
     - Good examples:
       - `docs-docker`
       - `feature-new-system`
       - `fix-title-cards`
     - Bad examples:
       - `bug`
       - `docs`
       - `feature`
       - `fix`
       - `patch`

4. Run the development environment:

   ```bash
   bun install
   bun run dev
   ```

   - Alternatively, you can use [Docker](https://www.docker.com/) with `docker compose up -d`. This method does not require installing Bun on your machine directly.

5. Create your patch and test your changes.

   - Be sure to follow both the [code](#contributing-code) and [UI text](#ui-text-style) guidelines.
   - Should you need to update your fork, you can do so by rebasing from `upstream`:

     ```bash
     git fetch upstream
     git rebase upstream/develop
     git push origin BRANCH_NAME -f
     ```

### Helm Chart

Tools Required:

- [Helm](https://helm.sh/docs/intro/install/)
- [helm-docs](https://github.com/norwoodj/helm-docs)

Steps:

1. Make the necessary changes.
2. Test your changes.
3. Update the `version` in `charts/foreseerr-chart/Chart.yaml` following [Semantic Versioning (SemVer)](https://semver.org/).
4. Run the `helm-docs` command to regenerate the chart's README.

### Contributing Code

- If you are taking on an existing bug or feature ticket, please comment on the [issue](/../../issues) to avoid multiple people working on the same thing.
- Pull requests with titles not following [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) will **not** be merged. PR titles are automatically checked for compliance.
- Please make meaningful commits, or squash them prior to opening a pull request.
  - Do not squash commits once people have begun reviewing your changes.
- Always rebase your branch to the latest `develop` branch.
- It is your responsibility to keep your branch up-to-date. Your work will **not** be merged unless it is rebased off the latest `develop` branch.
- You can create a "draft" pull request early to get feedback on your work.
- Your code **must** be formatted correctly, or the tests will fail.
  - We use Prettier to format our code base. It should automatically run with a Git hook, but it is recommended to have the Prettier extension installed in your editor and format on save.
- If you have questions or need help, you can reach out via [Discussions](/../../discussions) or our [Discord server](https://discord.gg/seerr).
- Only open pull requests to `develop`, never `master`! Any pull requests opened to `master` will be closed.

### UI Text Style

When adding new UI text, please try to adhere to the following guidelines:

1. Be concise and clear, and use as few words as possible to make your point.
2. Use the Oxford comma where appropriate.
3. Use the appropriate Unicode characters for ellipses, arrows, and other special characters/symbols.
4. Capitalize proper nouns, such as Plex, Radarr, Sonarr, Telegram, Slack, Pushover, etc. Be sure to also use the official capitalization for any abbreviations; e.g., IMDb has a lowercase 'b', whereas TMDB and TheTVDB have a capital 'B'.
5. Title case headings, button text, and form labels. Note that verbs such as "is" should be capitalized, whereas prepositions like "from" should be lowercase (unless as the first or last word of the string, in which case they are also capitalized).
6. Capitalize the first word in validation error messages, dropdowns, and form "tips." These strings should not end in punctuation.
7. Ensure that toast notification strings are complete sentences ending in punctuation.
8. If an additional description or "tip" is required for a form field, it should be styled using the global CSS class `label-tip`.
9. In full sentences, abbreviations like "info" or "auto" should not be used in place of full words, unless referencing the name/label of a specific setting or option which has an abbreviation in its name.
10. Do your best to check for spelling errors and grammatical mistakes.
11. Do not misspell "Seerr."

## Translation

Upstream Seerr still hosts [Weblate](https://translate.seerr.dev/projects/seerr/seerr-frontend/) for shared strings. Foreseerr has **not** stood up a separate Weblate project.

Roughly ~492 Foreseerr-only message keys exist in `src/i18n/locale/en.json` and are English-only across the other locale files. The UI still works because `react-intl` falls back to each message’s `defaultMessage`. When you add or change UI copy:

1. Use `defineMessages` / `intl.formatMessage` with a clear `defaultMessage` (do not hardcode English in JSX).
2. Run `bun run i18n:extract` and commit `src/i18n/locale/en.json`.
3. Do **not** invent translations for other locales unless you are updating Weblate-backed Seerr-shared keys; leave non-`en` files alone for Foreseerr-only keys so they keep falling back to English.

<a href="https://translate.seerr.dev/engage/seerr/"><img src="https://translate.seerr.dev/widget/seerr/multi-auto.svg" alt="Translation status" /></a>

## Migrations

If you are adding a new feature that requires a database migration, you will need to create 2 migrations: one for SQLite and one for PostgreSQL. Here is how you could do it:

1. Create a PostgreSQL database or use an existing one:

```bash
sudo docker run --name postgres-seerr -e POSTGRES_PASSWORD=postgres -d -p 127.0.0.1:5432:5432/tcp postgres:latest
```

2. Reset the SQLite database and the PostgreSQL database:

```bash
rm config/db/db.*
rm config/settings.*
PGPASSWORD=postgres sudo docker exec -it postgres-seerr /usr/bin/psql -h 127.0.0.1 -U postgres -c "DROP DATABASE IF EXISTS seerr;"
PGPASSWORD=postgres sudo docker exec -it postgres-seerr /usr/bin/psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE seerr;"
```

3. Switch to the `develop` branch and create the original database for SQLite and PostgreSQL so that TypeORM can automatically generate the migrations:

```bash
git switch develop
bun install
rm -r dist/public dist; bun run build
bun run start
DB_TYPE="postgres" DB_USER=postgres DB_PASS=postgres bun run start
```

(You can shutdown the server once the message "Server ready on 5055" appears)

4. Let TypeORM generate the migrations:

```bash
git switch -c your-feature-branch
bun install
bun run migration:generate server/migration/sqlite/YourMigrationName
DB_TYPE="postgres" DB_USER=postgres DB_PASS=postgres bun run migration:generate server/migration/postgres/YourMigrationName
```

## Attribution

This contribution guide was inspired by the [Next.js](https://github.com/vercel/next.js), [Radarr](https://github.com/Radarr/Radarr), and [Ghostty](https://github.com/ghostty-org/ghostty) contribution guides.
