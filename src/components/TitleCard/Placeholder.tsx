interface PlaceholderProps {
  canExpand?: boolean;
  /** Pulse only while something loads; a card waiting to scroll into view stays still. */
  loading?: boolean;
}

const Placeholder = ({
  canExpand = false,
  loading = true,
}: PlaceholderProps) => {
  return (
    <div
      className={`relative ${loading ? 'animate-pulse' : ''} rounded-xl bg-gray-700 ${
        canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'
      }`}
    >
      <div className="w-full" style={{ paddingBottom: '150%' }} />
    </div>
  );
};

export default Placeholder;
