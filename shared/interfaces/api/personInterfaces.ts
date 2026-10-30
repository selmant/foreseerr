import type { PersonCreditCast, PersonCreditCrew } from '@shared/models/Person';

export interface PersonCombinedCreditsResponse {
  id: number;
  cast: PersonCreditCast[];
  crew: PersonCreditCrew[];
}
