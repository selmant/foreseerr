import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import type { UserSettingsGeneralResponse } from '@server/interfaces/api/userSettingsInterfaces';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('OpenAPI contract parity', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const protocolPath = join(__dirname, '../../protocol/protocol-v1.json');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: {
      schemas: Record<
        string,
        {
          properties?: Record<
            string,
            { enum?: (string | number)[]; type?: string }
          >;
        }
      >;
    };
  };
  const protocolFixture = JSON.parse(readFileSync(protocolPath, 'utf8')) as {
    protocolVersion: number;
  };

  it('accepts only protocol v1 in desktop auth ticket OpenAPI schemas', () => {
    const issueSchema = (
      apiDocs.paths['/desktop/auth-tickets']?.post as {
        requestBody?: {
          content?: {
            'application/json'?: {
              schema?: {
                properties?: {
                  protocolVersion?: { enum?: number[] };
                };
              };
            };
          };
        };
      }
    ).requestBody?.content?.['application/json']?.schema?.properties
      ?.protocolVersion?.enum;

    const redeemSchema = (
      apiDocs.paths['/desktop/auth-tickets/redeem']?.post as {
        requestBody?: {
          content?: {
            'application/json'?: {
              schema?: {
                properties?: {
                  protocolVersion?: { enum?: number[] };
                };
              };
            };
          };
        };
      }
    ).requestBody?.content?.['application/json']?.schema?.properties
      ?.protocolVersion?.enum;

    assert.deepEqual(issueSchema, [1]);
    assert.deepEqual(redeemSchema, [1]);
    assert.equal(protocolFixture.protocolVersion, 1);
  });

  it('documents mediaActionsJellyfinEnabled on public settings', () => {
    const property =
      apiDocs.components.schemas.PublicSettings.properties
        ?.mediaActionsJellyfinEnabled;
    assert.equal(property?.type, 'boolean');
  });

  it('keeps PublicSettingsResponse media-action flags aligned with OpenAPI', () => {
    const publicSettingsKeys = new Set(
      Object.keys(apiDocs.components.schemas.PublicSettings.properties ?? {})
    );

    const requiredClientKeys: (keyof PublicSettingsResponse)[] = [
      'mediaActionsTraktEnabled',
      'mediaActionsJellyfinEnabled',
      'mediaActionsAnilistEnabled',
      'anilistConfigured',
    ];

    for (const key of requiredClientKeys) {
      assert.ok(
        publicSettingsKeys.has(key),
        `OpenAPI PublicSettings missing ${key}`
      );
    }
  });

  it('documents the skipped episode preference on general user settings', () => {
    const key: keyof UserSettingsGeneralResponse =
      'autoCompleteSkippedEpisodeEndings';
    const property = apiDocs.components.schemas.UserSettings.properties?.[key];
    assert.equal(property?.type, 'boolean');
  });
});
