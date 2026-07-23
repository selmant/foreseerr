import type { GetServerSideProps, NextPage } from 'next';

const TraktIntegrationSettingsPage: NextPage = () => null;

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: '/settings/integrations',
    permanent: false,
  },
});

export default TraktIntegrationSettingsPage;
