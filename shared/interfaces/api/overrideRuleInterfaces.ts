import type OverrideRule from '@shared/entity/OverrideRule';

export type OverrideRuleResultsResponse = OverrideRule[];

/** What `POST /overrideRule/advancedRequest` says the rules would set. */
export type OverrideRulesResult = {
  rootFolder: string | null;
  profileId: number | null;
  tags: number[] | null;
};
