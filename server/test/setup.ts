import dataSource, { getRepository } from '@server/datasource';
import { MappingSourceUsage } from '@server/entity/MappingSourceUsage';
import { scheduledJobs, stopJobs } from '@server/job/schedule';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import { clearNegativeCache, resetBudgets } from '@server/lib/mapping/budget';
import { resetMappingGapBuffer } from '@server/lib/mapping/gaps';
import { resetSettings } from '@server/lib/settings';
import logger from '@server/logger';
import http from 'node:http';
import https from 'node:https';
import { after, afterEach, before } from 'node:test';

// supertest serves the app over a real loopback socket, so only external hosts
// can be refused
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

const blocked = new Map<string, string>();

function stripPort(host: string): string {
  const bracketed = host.match(/^\[(.+)\]/);
  if (bracketed) {
    return bracketed[1];
  }

  const parts = host.split(':');
  return parts.length === 2 ? parts[0] : host;
}

function hostnameOf(args: unknown[]): string {
  const [first, second] = args;
  const fromUrl =
    typeof first === 'string' || first instanceof URL
      ? new URL(String(first)).hostname
      : undefined;

  const options = (fromUrl !== undefined ? second : first) as
    | { hostname?: string; host?: string }
    | undefined;
  const fromOptions =
    typeof options === 'object' && options !== null
      ? (options.hostname ??
        (options.host ? stripPort(options.host) : undefined))
      : undefined;

  return stripPort(fromOptions ?? fromUrl ?? 'localhost');
}

function blockOutboundRequests(
  mod: typeof http | typeof https,
  scheme: string
) {
  // get() calls the module's internal request(), not the exported one
  for (const name of ['request', 'get'] as const) {
    const original = mod[name] as (...args: unknown[]) => unknown;

    mod[name] = ((...args: unknown[]) => {
      const hostname = hostnameOf(args);

      if (!LOOPBACK.has(hostname)) {
        const target = `${scheme}//${hostname}`;
        if (!blocked.has(target)) {
          blocked.set(target, new Error(`blocked ${target}`).stack ?? target);
        }
        throw new Error(
          `Blocked outbound request to ${target}. Stub the API client this test uses, or set ALLOW_NETWORK=true.`
        );
      }

      return original(...args);
    }) as typeof mod.request;
  }
}

if (process.env.ALLOW_NETWORK != 'true') {
  blockOutboundRequests(http, 'http:');
  blockOutboundRequests(https, 'https:');

  // Bun's fetch uses its own transport rather than node:http.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname)) {
      const target = `${url.protocol}//${url.hostname}`;
      if (!blocked.has(target)) {
        blocked.set(target, new Error(`blocked ${target}`).stack ?? target);
      }
      throw new Error(
        `Blocked outbound request to ${target}. Stub the API client this test uses, or set ALLOW_NETWORK=true.`
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

before(() => {
  if (process.env.VERBOSE != 'true') logger.silent = true;
});

afterEach(async () => {
  if (scheduledJobs.length > 0) {
    stopJobs();
  }
  resetMappingGapBuffer();
  resetSettings();
  resetBudgets();
  clearNegativeCache();
  resetTmdbValidityCache();
  if (dataSource.isInitialized) {
    try {
      await getRepository(MappingSourceUsage).clear();
    } catch {
      // Schema may not exist in files that never open the test DB.
    }
  }
});

after(() => {
  if (process.env.VERBOSE != 'true') logger.silent = false;

  // callers that swallow the error would otherwise leave the suite green
  if (blocked.size) {
    const hosts = [...blocked.keys()].join(', ');
    const stacks = [...blocked.entries()]
      .map(([host, stack]) => `${host}\n${stack}`)
      .join('\n');
    throw new Error(
      `Test reached the network: ${hosts}. Stub the API client this test uses.\n${stacks}`
    );
  }
});
