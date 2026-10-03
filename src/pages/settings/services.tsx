import { Navigate } from 'react-router';

// Upstream Seerr called this page "Services"; keep old links working.
const ServicesSettingsRedirect = () => (
  <Navigate to="/settings/integrations" replace />
);

export default ServicesSettingsRedirect;
