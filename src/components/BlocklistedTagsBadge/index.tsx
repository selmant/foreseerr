import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { TagIcon } from '@heroicons/react/20/solid';
import type { BlocklistItem } from '@server/interfaces/api/blocklistInterfaces';
import type { Keyword } from '@server/models/common';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings', {
  blocklistedTagsText: 'Blocklisted Tags',
  blocklistedTagsLoading: 'Loading matched tags…',
  blocklistedTagUnavailable: 'Tag {id}',
});

interface BlocklistedTagsBadgeProps {
  data: BlocklistItem;
  showDetails?: boolean;
}

const BlocklistedTagsBadge = ({
  data,
  showDetails = false,
}: BlocklistedTagsBadgeProps) => {
  const [tagNamesBlocklistedFor, setTagNamesBlocklistedFor] =
    useState<string>();
  const intl = useIntl();

  useEffect(() => {
    let cancelled = false;
    if (!data.blocklistedTags) {
      return;
    }

    setTagNamesBlocklistedFor(undefined);
    const keywordIds = data.blocklistedTags
      .slice(1, -1)
      .split(',')
      .filter(Boolean);
    Promise.all(
      keywordIds.map(async (keywordId) => {
        try {
          const { data } = await axios.get<Keyword | null>(
            `/api/v1/keyword/${keywordId}`
          );
          return (
            data?.name ||
            intl.formatMessage(messages.blocklistedTagUnavailable, {
              id: keywordId,
            })
          );
        } catch {
          return intl.formatMessage(messages.blocklistedTagUnavailable, {
            id: keywordId,
          });
        }
      })
    ).then((keywords) => {
      if (!cancelled) setTagNamesBlocklistedFor(keywords.join(', '));
    });
    return () => {
      cancelled = true;
    };
  }, [data.blocklistedTags, intl]);

  const badge = (
    <Badge
      badgeType="dark"
      className={`items-center border border-red-500 !text-red-400 ${showDetails ? 'max-w-full !whitespace-normal' : ''}`}
    >
      <TagIcon className="mr-1 h-4 shrink-0" />
      {intl.formatMessage(messages.blocklistedTagsText)}
    </Badge>
  );
  const tagNames =
    tagNamesBlocklistedFor ??
    intl.formatMessage(messages.blocklistedTagsLoading);
  if (showDetails)
    return (
      <div className="space-y-2">
        {badge}
        <p className="break-words text-sm leading-6 text-gray-300">
          {tagNames}
        </p>
      </div>
    );

  return (
    <Tooltip content={tagNames} tooltipConfig={{ followCursor: false }}>
      {badge}
    </Tooltip>
  );
};

export default BlocklistedTagsBadge;
