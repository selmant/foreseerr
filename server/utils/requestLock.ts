import AsyncLock from '@server/utils/asyncLock';

// Serialize the quota check and save for each request owner. Keep this outside
// database transactions and subscribers so a waiter never holds a connection.
const requestLock = new AsyncLock();

export default requestLock;
