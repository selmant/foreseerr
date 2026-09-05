#!/usr/bin/env bun
const ua = process.env.npm_config_user_agent ?? '';
if (!ua.includes('bun')) {
  console.error(
    'This project uses Bun. Install https://bun.sh then run: bun install'
  );
  process.exit(1);
}
