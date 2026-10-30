import type { IssueStatus, IssueType } from '@shared/constants/issue';
import type IssueComment from '@shared/entity/IssueComment';
import type Media from '@shared/entity/Media';
import type { User } from '@shared/entity/User';

/** A reported problem with a title, with its comments. */
interface Issue {
  id: number;
  issueType: IssueType;
  status: IssueStatus;
  problemSeason: number;
  problemEpisode: number;
  media: Media;
  createdBy: User;
  modifiedBy?: User;
  /** Sorted oldest first. */
  comments: IssueComment[];
  createdAt: Date;
  updatedAt: Date;
}

export default Issue;
