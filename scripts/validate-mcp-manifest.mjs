#!/usr/bin/env node

import { loadMcpToolManifest } from './mcp-tool-manifest.mjs';

try {
  const { manifest, paths } = loadMcpToolManifest();
  process.stdout.write(
    `mcp manifest ok: ${manifest.manifest_id}; contract=${manifest.contract_version}; tools=${manifest.tools.length}; manifest=${paths.manifest}\n`,
  );
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
