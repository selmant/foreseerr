import type { GetServerSideProps, NextPage } from 'next';

const MdbListIntegrationSettingsPage: NextPage = () => null;

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: '/settings/integrations',
    permanent: false,
  },
});

export default MdbListIntegrationSettingsPage;
