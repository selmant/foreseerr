import type Issue from '@shared/entity/Issue';
import type { User } from '@shared/entity/User';

/** A comment on an issue. */
interface IssueComment {
  id: number;
  user: User;
  /** Parent issue; absent when nested inside that issue. */
  issue?: Issue;
  message: string;
  createdAt: Date;
  updatedAt: Date;
}

export default IssueComment;
