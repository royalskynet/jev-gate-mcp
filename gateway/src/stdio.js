#!/usr/bin/env node
// stdio transport entry (v2 `serveStdio`). `JEV_PROVIDER=fake node gateway/src/stdio.js`
// or a real provider with a key file. Same Gateway core and tool surface as HTTP.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildGateway } from './config.js';
import { buildServer } from './server.js';

serveStdio(() => buildServer(buildGateway().gateway));
