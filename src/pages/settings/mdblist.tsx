import type { GetServerSideProps, NextPage } from 'next';

const MdbListSettingsPage: NextPage = () => null;

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: '/settings/integrations/mdblist',
    permanent: false,
  },
});

export default MdbListSettingsPage;
