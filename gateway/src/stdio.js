#!/usr/bin/env node
// stdio transport entry: `JEV_PROVIDER=fake node gateway/src/stdio.js` or a
// real provider with a key file. Same tool surface as HTTP.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildGateway } from './config.js';
import { buildServer } from './server.js';

const { gateway } = buildGateway();
const server = buildServer(gateway);
await server.connect(new StdioServerTransport());
