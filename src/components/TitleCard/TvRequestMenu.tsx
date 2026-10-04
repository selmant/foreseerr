import defineMessages from '@app/utils/defineMessages';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { ArrowDownTrayIcon, QueueListIcon } from '@heroicons/react/24/outline';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TitleCard.TvRequestMenu', {
  moreOptions: 'More request options',
  requestOptions: 'Request options for {title}',
  allSeasons: 'Request all seasons',
  chooseSeasons: 'Choose seasons…',
  chooseEpisodes: 'Choose episodes…',
});

interface TvRequestMenuProps {
  title: string;
  disabled: boolean;
  episodeRequestsEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestAll: () => void;
  onChooseSeasons: () => void;
  onChooseEpisodes: () => void;
}

const MenuContent = ({
  open,
  onOpenChange,
  title,
  disabled,
  episodeRequestsEnabled,
  onRequestAll,
  onChooseSeasons,
  onChooseEpisodes,
}: TvRequestMenuProps & { open: boolean }) => {
  const intl = useIntl();

  useEffect(() => {
    onOpenChange(open);
    return () => onOpenChange(false);
  }, [onOpenChange, open]);

  const options = [
    {
      label: intl.formatMessage(messages.allSeasons),
      Icon: ArrowDownTrayIcon,
      onSelect: onRequestAll,
    },
    {
      label: intl.formatMessage(messages.chooseSeasons),
      Icon: ArrowDownTrayIcon,
      onSelect: onChooseSeasons,
    },
    ...(episodeRequestsEnabled
      ? [
          {
            label: intl.formatMessage(messages.chooseEpisodes),
            Icon: QueueListIcon,
            onSelect: onChooseEpisodes,
          },
        ]
      : []),
  ];

  return (
    <>
      <MenuButton
        type="button"
        disabled={disabled}
        aria-label={intl.formatMessage(messages.moreOptions)}
        className="button-md relative z-40 inline-flex min-h-11 min-w-11 items-center justify-center rounded-r-md border border-l-0 border-indigo-500 bg-indigo-600/80 px-2 text-white transition hover:bg-indigo-600 focus-visible:z-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={(event) => event.stopPropagation()}
      >
        <ChevronDownIcon className="h-4 w-4" aria-hidden />
      </MenuButton>
      <MenuItems
        anchor="top end"
        modal={false}
        aria-label={intl.formatMessage(messages.requestOptions, { title })}
        className="z-[100] w-60 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-indigo-500 bg-gray-800 p-1 text-white shadow-xl outline-none [--anchor-gap:8px] [--anchor-padding:8px]"
      >
        {options.map(({ label, Icon, onSelect }) => (
          <MenuItem key={label}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm data-[focus]:bg-indigo-600"
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span>{label}</span>
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </>
  );
};

const TvRequestMenu = (props: TvRequestMenuProps) => (
  <Menu as="div" className="flex shrink-0">
    {({ open }) => <MenuContent {...props} open={open} />}
  </Menu>
);

export default TvRequestMenu;
