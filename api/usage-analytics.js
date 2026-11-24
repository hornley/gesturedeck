import { createServer } from 'node:http';
import { attachUsageAnalytics } from '../src/usage-analytics-server.js';

const server = createServer();
attachUsageAnalytics(server);

export default server;
